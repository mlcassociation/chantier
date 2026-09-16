import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  AgentEvent,
  Message,
  ModelAdapter,
  ModelEvent,
  SessionEntry,
  SessionStore,
  ToolDefinition,
} from "@chantier/core";
import { createAllowAllSink, createPermissionEngine } from "@chantier/permissions";
import { describe, expect, it } from "vitest";
import { runAgent } from "../src/agent.ts";
import {
  COMPACT_PROMPT,
  COMPACTED_MARKER,
  compactConversation,
  compactedSummaryMessage,
  DEFAULT_COMPACTION_KEEP_RECENT,
  DEFAULT_COMPACTION_RESERVE,
  estimateMessageTokens,
  estimateTokens,
  serializeConversation,
  shouldCompact,
} from "../src/compaction.ts";
import {
  alignedMessageOrdinals,
  compactSession,
  createSessionStore,
  sessionView,
} from "../src/session.ts";

function scriptedAdapter(
  turns: Array<ModelEvent[] | Error>,
): ModelAdapter & { count: number; calls: Array<{ messages: Message[]; toolNames: string[] }> } {
  let index = 0;
  return {
    count: 0,
    calls: [],
    async *stream(messages, tools) {
      this.count += 1;
      this.calls.push({
        messages: structuredClone(messages) as Message[],
        toolNames: tools.map((tool) => tool.name),
      });
      const turn = turns[index];
      index += 1;
      if (turn instanceof Error) throw turn;
      for (const event of turn ?? []) yield event;
    },
  } as ModelAdapter & { count: number; calls: Array<{ messages: Message[]; toolNames: string[] }> };
}

interface MemorySession extends SessionStore {
  lines: SessionEntry[];
}

function memorySession(): MemorySession {
  const lines: SessionEntry[] = [];
  return {
    id: "test-session",
    dir: "/tmp",
    append: async (entry) => {
      lines.push(entry);
    },
    load: async () => structuredClone(lines) as SessionEntry[],
    lines,
  };
}

const readTool: ToolDefinition = {
  name: "read",
  description: "reads",
  inputSchema: { type: "object", properties: { path: { type: "string" } } },
  readOnly: true,
  handler: async (input) => `contents of ${String(input.path)}`,
};

function resultOf(events: AgentEvent[]): Extract<AgentEvent, { type: "result" }> {
  const last = events.at(-1);
  if (last?.type !== "result") throw new Error("expected a result event");
  return last;
}

function compactionEventsOf(
  events: AgentEvent[],
): Array<Extract<AgentEvent, { type: "compaction" }>> {
  return events.filter(
    (event): event is Extract<AgentEvent, { type: "compaction" }> => event.type === "compaction",
  );
}

async function collect(generator: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of generator) events.push(event);
  return events;
}

function userMessage(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}

function assistantWithCalls(
  ...calls: Array<{ id: string; name: string; args?: Record<string, unknown> }>
): Message {
  return {
    role: "assistant",
    content: calls.map((call) => ({
      type: "tool-call" as const,
      id: call.id,
      name: call.name,
      args: call.args ?? {},
    })),
  };
}

function toolResult(toolCallId: string, toolName: string, content: string): Message {
  return { role: "tool-result", toolCallId, toolName, content };
}

/** Pairing invariant over a kept span: every kept result has its kept call and vice versa. */
function expectPairingIntact(messages: Message[]): void {
  const callIds = new Set<string>();
  const resultIds = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type === "tool-call") callIds.add(block.id);
      }
    } else if (message.role === "tool-result") {
      resultIds.add(message.toolCallId);
    }
  }
  expect([...resultIds].every((id) => callIds.has(id))).toBe(true);
  expect([...callIds].every((id) => resultIds.has(id))).toBe(true);
}

describe("estimateTokens", () => {
  it("ceil-divides characters by four", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("x".repeat(401))).toBe(101);
  });
});

describe("estimateMessageTokens", () => {
  it("sums per-message estimates across roles including tool args", () => {
    const messages: Message[] = [
      { role: "system", content: "abcd" },
      userMessage("abcdabcd"),
      assistantWithCalls({ id: "c1", name: "read", args: { path: "abcdabcdabcdabcd" } }),
      toolResult("c1", "read", "abcdabcd"),
    ];
    // system 4 chars→1, user 8→2, assistant tool-call "read"+"c1"+28-char args = 34→9, result 8→2
    expect(estimateMessageTokens(messages)).toBe(14);
  });
});

describe("serializeConversation", () => {
  it("renders every role with deterministic, role-tagged lines", () => {
    const messages: Message[] = [
      { role: "system", content: "You are chantier." },
      userMessage("read a.ts"),
      assistantWithCalls({ id: "c1", name: "read", args: { path: "a.ts" } }),
      toolResult("c1", "read", "contents of a.ts"),
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ];
    const first = serializeConversation(messages);
    expect(first).toBe(serializeConversation(structuredClone(messages) as Message[]));
    expect(first).toContain("[system]\nYou are chantier.");
    expect(first).toContain("[user]\nread a.ts");
    expect(first).toContain(`[assistant]\ntool-call read id=c1: {"path":"a.ts"}`);
    expect(first).toContain("[tool-result c1 (read)]\ncontents of a.ts");
    expect(first).toContain("[assistant]\ndone");
  });
});

describe("COMPACT_PROMPT", () => {
  it("requires the five summary sections and faithfulness rules", () => {
    expect(COMPACT_PROMPT).toContain("ACTIVE TASK");
    expect(COMPACT_PROMPT).toContain("DECISIONS AND CONSTRAINTS");
    expect(COMPACT_PROMPT).toContain("FILES AND CODE");
    expect(COMPACT_PROMPT).toContain("UNRESOLVED THREADS");
    expect(COMPACT_PROMPT).toContain("TO REMEMBER");
    expect(COMPACT_PROMPT).toContain("do not invent facts");
  });
});

describe("shouldCompact", () => {
  it("fires exactly at the threshold window - reserve - keepRecent", () => {
    const opts = { window: 1000, reserve: 100, keepRecent: 100 };
    expect(shouldCompact({ tokensUsed: 799, ...opts })).toBe(false);
    expect(shouldCompact({ tokensUsed: 800, ...opts })).toBe(true);
    expect(shouldCompact({ tokensUsed: 5000, ...opts })).toBe(true);
  });

  it("defaults to reserve 16000 and keepRecent 20000", () => {
    expect(DEFAULT_COMPACTION_RESERVE).toBe(16_000);
    expect(DEFAULT_COMPACTION_KEEP_RECENT).toBe(20_000);
    expect(shouldCompact({ tokensUsed: 63_999, window: 100_000 })).toBe(false);
    expect(shouldCompact({ tokensUsed: 64_000, window: 100_000 })).toBe(true);
  });
});

const SYSTEM: Message = { role: "system", content: "You are chantier." };

const summarizeTurn: ModelEvent[] = [
  { type: "text-delta", text: "  SUMMARY TEXT  " },
  { type: "finish", stopReason: "end_turn" },
];

describe("compactConversation", () => {
  it("walks the keepRecent boundary back so no tool pair is split", async () => {
    const adapter = scriptedAdapter([summarizeTurn]);
    const messages: Message[] = [
      SYSTEM,
      userMessage("a".repeat(100)),
      assistantWithCalls({ id: "c1", name: "read", args: { path: "x" } }),
      toolResult("c1", "read", "b".repeat(8000)),
      assistantWithCalls({ id: "c2", name: "read", args: { path: "y" } }),
      toolResult("c2", "read", "r2"),
      userMessage("u2"),
    ];
    const result = await compactConversation({
      adapter,
      messages,
      keepRecent: 100,
      window: 10_000,
      reserve: 1_000,
    });
    // keepRecent accumulates u2 + r2 + c2 (all small), then the huge r1 pushes
    // the boundary onto r1; safety walks it back to the assistant holding c1.
    expect(result.keptMessages.map((message) => message.role)).toEqual([
      "assistant",
      "tool-result",
      "assistant",
      "tool-result",
      "user",
    ]);
    expect(result.keptMessages[0]).toEqual(
      assistantWithCalls({ id: "c1", name: "read", args: { path: "x" } }),
    );
    expect(result.keptStart).toBe(2);
    expectPairingIntact(result.keptMessages);
  });

  it("prunes old tool-result payloads in the summarized span and calls the adapter once with no tools", async () => {
    const adapter = scriptedAdapter([summarizeTurn]);
    const messages: Message[] = [
      SYSTEM,
      userMessage("read both"),
      assistantWithCalls({ id: "c1", name: "read", args: { path: "x" } }),
      toolResult("c1", "read", `${"b".repeat(5000)}NEEDLE_HIDDEN.${"b".repeat(5000)}`),
      assistantWithCalls({ id: "c2", name: "read", args: { path: "y" } }),
      toolResult("c2", "read", "r2"),
      userMessage("u".repeat(500)),
      { role: "assistant", content: [{ type: "text", text: "closing" }] },
    ];
    const result = await compactConversation({
      adapter,
      messages,
      keepRecent: 100,
      window: 10_000,
      reserve: 1_000,
    });
    expect(adapter.count).toBe(1);
    expect(adapter.calls[0]?.toolNames).toEqual([]);
    const summarizerMessages = adapter.calls[0]?.messages ?? [];
    expect(summarizerMessages).toHaveLength(2);
    expect(summarizerMessages[0]?.role).toBe("system");
    const prompt =
      summarizerMessages[1]?.role === "user" ? summarizerMessages[1].content[0]?.text : "";
    expect(prompt).toContain(COMPACT_PROMPT);
    expect(prompt).toContain("<conversation>");
    expect(prompt).not.toContain("NEEDLE_HIDDEN");
    expect(prompt).toContain("[...tool result truncated, 10014 chars total]");
    // summary is trimmed adapter text
    expect(result.summary).toBe("SUMMARY TEXT");
    expect(result.tokensBefore).toBeGreaterThan(result.estimatedAfter);
    expectPairingIntact(result.keptMessages);
  });

  it("returns an empty summary (and keeps everything) when there is nothing to summarize", async () => {
    const adapter = scriptedAdapter([]);
    const messages: Message[] = [
      SYSTEM,
      userMessage("only"),
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
    ];
    const result = await compactConversation({
      adapter,
      messages,
      keepRecent: 5_000,
      window: 10_000,
      reserve: 1_000,
    });
    expect(adapter.count).toBe(0);
    expect(result.summary).toBe("");
    expect(result.keptMessages).toEqual(messages.slice(1));
  });

  it("rejects a window that reserve + keepRecent cannot fit", async () => {
    const adapter = scriptedAdapter([]);
    await expect(
      compactConversation({
        adapter,
        messages: [SYSTEM, userMessage("hi")],
        keepRecent: 100,
        window: 150,
        reserve: 100,
      }),
    ).rejects.toThrow(RangeError);
  });

  it("requires the leading SystemMessage", async () => {
    const adapter = scriptedAdapter([]);
    await expect(
      compactConversation({
        adapter,
        messages: [userMessage("hi")],
        keepRecent: 100,
        window: 10_000,
        reserve: 100,
      }),
    ).rejects.toThrow("SystemMessage");
  });
});

describe("compactedSummaryMessage", () => {
  it("prefixes the summary with the compaction marker", () => {
    const message = compactedSummaryMessage("S");
    expect(message.role).toBe("user");
    expect(message.content[0]?.text).toBe(`${COMPACTED_MARKER}S`);
  });
});

describe("sessionView vs load", () => {
  it("replaces pre-compaction messages with the summary message and keeps load() full", () => {
    const user1 = userMessage("one");
    const assistant = { role: "assistant", content: [{ type: "text", text: "two" }] } as Message;
    const summaryMessage = compactedSummaryMessage("the summary");
    const user2 = userMessage("after compaction");
    const entries: SessionEntry[] = [
      {
        type: "compaction",
        summary: "the summary",
        firstKeptMessageIndex: 2,
        tokensBefore: 900,
        createdAt: new Date().toISOString(),
      },
      { type: "message", message: user1 },
      { type: "message", message: assistant },
      { type: "message", message: summaryMessage },
      { type: "message", message: user2 },
    ];
    const view = sessionView(entries);
    expect(view).toEqual([summaryMessage, user2]);
    const load = entries.filter((entry) => entry.type === "message").map((entry) => entry.message);
    expect(load).toEqual([user1, assistant, summaryMessage, user2]);
  });

  it("uses the last compaction entry when several accumulated", () => {
    const entries: SessionEntry[] = [
      { type: "message", message: userMessage("m0") },
      { type: "message", message: userMessage("m1") },
      {
        type: "compaction",
        summary: "s1",
        firstKeptMessageIndex: 1,
        tokensBefore: 800,
        createdAt: new Date().toISOString(),
      },
      { type: "message", message: compactedSummaryMessage("s1") },
      { type: "message", message: userMessage("m2") },
      {
        type: "compaction",
        summary: "s2",
        firstKeptMessageIndex: 3,
        tokensBefore: 900,
        createdAt: new Date().toISOString(),
      },
      { type: "message", message: compactedSummaryMessage("s2") },
    ];
    const view = sessionView(entries);
    // s2 keeps from ordinal 3, so s1's summary message (ordinal 2, re-summarized
    // into s2) drops and only m2 survives; s2's summary message is hoisted first.
    expect(
      view.map((message) => (message.role === "user" ? message.content[0]?.text : message.role)),
    ).toEqual([`${COMPACTED_MARKER}s2`, "m2"]);
  });

  it("round-trips a compaction entry through the JSONL store", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "chantier-compaction-"));
    const store = await createSessionStore({
      cwd: "/tmp/fake-project",
      provider: "ollama",
      model: "m",
      sessionsRoot: root,
    });
    const summaryMessage = compactedSummaryMessage("the summary");
    await store.append({ type: "message", message: userMessage("before") });
    await store.append({
      type: "compaction",
      summary: "the summary",
      firstKeptMessageIndex: 1,
      tokensBefore: 900,
      createdAt: new Date().toISOString(),
    });
    await store.append({ type: "message", message: summaryMessage });
    await store.append({ type: "message", message: userMessage("after") });

    const view = await store.view?.(store.id);
    expect(
      view?.map((message) => (message.role === "user" ? message.content[0]?.text : message.role)),
    ).toEqual([`${COMPACTED_MARKER}the summary`, "after"]);
    const all = await store.load(store.id);
    expect(all[2]).toMatchObject({
      type: "compaction",
      firstKeptMessageIndex: 1,
      tokensBefore: 900,
    });
    expect(all.filter((entry) => entry.type === "message")).toHaveLength(3);
  });
});

const BASE = {
  tools: [readTool],
  permission: createPermissionEngine({}),
  sink: createAllowAllSink(),
  system: "You are chantier.",
  cwd: "/tmp/fake-project",
  signal: new AbortController().signal,
};

describe("runAgent compaction", () => {
  it("auto-compacts between turns when usage crosses the threshold and re-injects the summary", async () => {
    const session = memorySession();
    const startUser = userMessage(`please read a.ts\n${"context".repeat(500)}`);
    await session.append({ type: "message", message: startUser });
    const adapter = scriptedAdapter([
      [
        { type: "text-delta", text: "Let me read." },
        { type: "tool-call", id: "c1", name: "read", args: { path: "a.ts" } },
        { type: "finish", stopReason: "end_turn", usage: { inputTokens: 700, outputTokens: 200 } },
      ],
      summarizeTurn,
      [
        { type: "text-delta", text: "All done." },
        { type: "finish", stopReason: "end_turn" },
      ],
    ]);

    const events = await collect(
      runAgent({
        ...BASE,
        adapter,
        session,
        messages: [startUser],
        contextWindow: 1000,
        compaction: { reserve: 100, keepRecent: 5 },
      }),
    );

    // 700 + 200 + turn delta >= 800 → compaction fired exactly once
    const compactions = compactionEventsOf(events);
    expect(compactions).toHaveLength(1);
    expect(compactions[0]?.tokensBefore).toBeGreaterThan(0);
    expect(compactions[0]?.tokensAfter).toBeLessThan(compactions[0]?.tokensBefore ?? 0);
    expect(compactions[0]?.summaryChars).toBe("SUMMARY TEXT".length);

    // session log: entry + summary message appended after the tool result
    const entries = session.lines;
    const compactionIndex = entries.findIndex((entry) => entry.type === "compaction");
    expect(compactionIndex).toBe(3); // user, assistant, tool-result, then the entry
    const entry = entries[compactionIndex];
    expect(entry).toMatchObject({
      type: "compaction",
      summary: "SUMMARY TEXT",
      firstKeptMessageIndex: 1,
    });
    expect(entries[compactionIndex + 1]).toMatchObject({
      type: "message",
      message: { role: "user" },
    });
    // load() stays full replay: startUser, assistant, tool-result, summary, turn-2 assistant
    expect(entries.filter((entry) => entry.type === "message")).toHaveLength(5);

    // view() = summary message + kept tail; pairings preserved
    const view = sessionView(await session.load(session.id));
    expectPairingIntact(view);
    expect(
      view.map((message) => (message.role === "user" ? message.content[0]?.text : message.role)),
    ).toEqual([`${COMPACTED_MARKER}SUMMARY TEXT`, "assistant", "tool-result", "assistant"]);

    // re-injection shape for the next turn: system + summary user + kept tail
    const turn2Messages = adapter.calls[2]?.messages ?? [];
    expect(turn2Messages[0]).toEqual({ role: "system", content: "You are chantier." });
    const turn2Summary = turn2Messages[1];
    expect(turn2Summary?.role).toBe("user");
    if (turn2Summary?.role === "user") {
      expect(turn2Summary.content[0]?.text).toBe(`${COMPACTED_MARKER}SUMMARY TEXT`);
    }
    expectPairingIntact(turn2Messages.slice(2));
    // summarizer call carried no tools
    expect(adapter.calls[1]?.toolNames).toEqual([]);
    expect(resultOf(events).stopReason).toBe("end_turn");
  });

  it("falls back to the chars/4 estimator when the provider reports no usage", async () => {
    const session = memorySession();
    const startUser = userMessage("x".repeat(4000));
    await session.append({ type: "message", message: startUser });
    const adapter = scriptedAdapter([
      [
        { type: "tool-call", id: "c1", name: "read", args: { path: "a.ts" } },
        { type: "finish", stopReason: "end_turn" },
      ],
      summarizeTurn,
      [{ type: "finish", stopReason: "end_turn" }],
    ]);

    const events = await collect(
      runAgent({
        ...BASE,
        adapter,
        session,
        messages: [startUser],
        contextWindow: 1000,
        compaction: { reserve: 100, keepRecent: 5 },
      }),
    );

    // 4000 chars ≈ 1000 tokens ≥ 800 threshold, with no usage reported at all
    expect(compactionEventsOf(events)).toHaveLength(1);
    expect(session.lines.some((entry) => entry.type === "compaction")).toBe(true);
  });

  it("does not compact when the usage stays below the threshold", async () => {
    const session = memorySession();
    const adapter = scriptedAdapter([
      [
        { type: "tool-call", id: "c1", name: "read", args: { path: "a.ts" } },
        { type: "finish", stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5 } },
      ],
      [{ type: "finish", stopReason: "end_turn" }],
    ]);

    await collect(
      runAgent({
        ...BASE,
        adapter,
        session,
        contextWindow: 1000,
        compaction: { reserve: 100, keepRecent: 5 },
      }),
    );
    expect(session.lines.some((entry) => entry.type === "compaction")).toBe(false);
    expect(adapter.count).toBe(2);
  });

  it("is disabled without contextWindow even when usage is huge", async () => {
    const session = memorySession();
    const adapter = scriptedAdapter([
      [
        { type: "tool-call", id: "c1", name: "read", args: { path: "a.ts" } },
        {
          type: "finish",
          stopReason: "end_turn",
          usage: { inputTokens: 500_000, outputTokens: 1000 },
        },
      ],
      [{ type: "finish", stopReason: "end_turn" }],
    ]);

    await collect(runAgent({ ...BASE, adapter, session }));
    expect(session.lines.some((entry) => entry.type === "compaction")).toBe(false);
    expect(adapter.count).toBe(2);
  });

  it("recovers once from a context-overflow stream error via reactive compaction", async () => {
    const session = memorySession();
    const startUser = userMessage("please read a.ts");
    await session.append({ type: "message", message: startUser });
    const overflow = new Error("This model's maximum context length is 4096 tokens");
    const adapter = scriptedAdapter([
      [
        { type: "tool-call", id: "c1", name: "read", args: { path: "a.ts" } },
        { type: "finish", stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5 } },
      ],
      overflow,
      summarizeTurn,
      [{ type: "finish", stopReason: "end_turn" }],
    ]);

    const events = await collect(
      runAgent({
        ...BASE,
        adapter,
        session,
        messages: [startUser],
        contextWindow: 1000,
        compaction: { reserve: 100, keepRecent: 5 },
      }),
    );

    expect(compactionEventsOf(events)).toHaveLength(1);
    expect(session.lines.some((entry) => entry.type === "compaction")).toBe(true);
    // turn 1, failed stream, summarizer, retried turn 2
    expect(adapter.count).toBe(4);
    expect(resultOf(events).stopReason).toBe("end_turn");
  });

  it("surfaces the original error when the retry still overflows", async () => {
    const session = memorySession();
    const startUser = userMessage("please read a.ts");
    await session.append({ type: "message", message: startUser });
    const first = new Error("context length exceeded (attempt 1)");
    const second = new Error("context length exceeded (attempt 2)");
    const adapter = scriptedAdapter([
      [
        { type: "tool-call", id: "c1", name: "read", args: { path: "a.ts" } },
        { type: "finish", stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5 } },
      ],
      first,
      summarizeTurn,
      second,
    ]);

    await expect(
      collect(
        runAgent({
          ...BASE,
          adapter,
          session,
          messages: [startUser],
          contextWindow: 1000,
          compaction: { reserve: 100, keepRecent: 5 },
        }),
      ),
    ).rejects.toThrow("context length exceeded (attempt 1)");
    expect(adapter.count).toBe(4);
  });

  it("gives up reactive compaction when the summarizer yields nothing", async () => {
    const session = memorySession();
    const overflow = new Error("input length exceeds context window");
    const adapter = scriptedAdapter([overflow, [{ type: "finish", stopReason: "end_turn" }]]);

    await expect(
      collect(
        runAgent({
          ...BASE,
          adapter,
          session,
          contextWindow: 1000,
          compaction: { reserve: 100, keepRecent: 5 },
        }),
      ),
    ).rejects.toThrow("input length exceeds context window");
    expect(session.lines.some((entry) => entry.type === "compaction")).toBe(false);
  });
});

describe("alignedMessageOrdinals", () => {
  it("matches a plain log exactly", () => {
    const entries: SessionEntry[] = [
      { type: "message", message: userMessage("a") },
      { type: "message", message: userMessage("b") },
    ];
    expect(alignedMessageOrdinals(entries, [userMessage("a"), userMessage("b")])).toEqual([0, 1]);
  });

  it("aligns the compaction view by true ordinals (hoisted summary keeps its late ordinal)", () => {
    const summary = compactedSummaryMessage("s");
    const entries: SessionEntry[] = [
      { type: "message", message: userMessage("u0") },
      { type: "message", message: userMessage("u1") },
      {
        type: "compaction",
        summary: "s",
        firstKeptMessageIndex: 1,
        tokensBefore: 900,
        createdAt: "t",
      },
      { type: "message", message: summary },
      { type: "message", message: userMessage("u2") },
    ];
    const view = sessionView(entries); // [summary, u1, u2]
    expect(alignedMessageOrdinals(entries, view)).toEqual([2, 1, 3]);
  });

  it("returns null for a full replay of a compacted log (caller falls back)", () => {
    const summary = compactedSummaryMessage("s");
    const entries: SessionEntry[] = [
      { type: "message", message: userMessage("u0") },
      {
        type: "compaction",
        summary: "s",
        firstKeptMessageIndex: 1,
        tokensBefore: 900,
        createdAt: "t",
      },
      { type: "message", message: summary },
    ];
    const fullReplay = entries
      .filter((entry) => entry.type === "message")
      .map((entry) => entry.message);
    expect(alignedMessageOrdinals(entries, fullReplay)).toBeNull();
  });
});

describe("compactSession", () => {
  it("compacts, appends entry + summary with the true boundary, and folds the view", async () => {
    const session = memorySession();
    const logged: Message[] = [
      userMessage("u".repeat(800)),
      assistantWithCalls({ id: "c1", name: "read" }),
      toolResult("c1", "read", "r1"),
      userMessage("v".repeat(800)),
      assistantWithCalls({ id: "c2", name: "read" }),
      toolResult("c2", "read", "r2"),
    ];
    for (const message of logged) await session.append({ type: "message", message });
    const adapter = scriptedAdapter([summarizeTurn]);

    const outcome = await compactSession({
      store: session,
      adapter,
      system: "You are chantier.",
      contextWindow: 500,
      reserve: 50,
      keepRecent: 200,
    });

    // ~411 estimated tokens >= 500 - 50 - 200; the recent tail (u1, a2, r2)
    // stays verbatim, u0/a1/r1 are summarized.
    expect(outcome).toEqual({
      tokensBefore: expect.any(Number),
      tokensAfter: expect.any(Number),
      summaryChars: "SUMMARY TEXT".length,
    });
    expect(outcome?.tokensAfter).toBeLessThan(outcome?.tokensBefore ?? 0);
    const entryIndex = session.lines.findIndex((entry) => entry.type === "compaction");
    expect(entryIndex).toBe(6);
    expect(session.lines[entryIndex]).toMatchObject({
      type: "compaction",
      firstKeptMessageIndex: 3,
      summary: "SUMMARY TEXT",
    });
    expect(session.lines[entryIndex + 1]).toMatchObject({
      type: "message",
      message: { role: "user" },
    });
    const view = sessionView(await session.load(session.id));
    expect(
      view.map((message) => (message.role === "user" ? message.content[0]?.text : message.role)),
    ).toEqual([`${COMPACTED_MARKER}SUMMARY TEXT`, "v".repeat(800), "assistant", "tool-result"]);
    expectPairingIntact(view.slice(1));
    expect(adapter.count).toBe(1);
  });

  it("returns null below the threshold and appends nothing", async () => {
    const session = memorySession();
    await session.append({ type: "message", message: userMessage("tiny") });
    const adapter = scriptedAdapter([]);
    const outcome = await compactSession({
      store: session,
      adapter,
      system: "You are chantier.",
      contextWindow: 1000,
      reserve: 100,
      keepRecent: 5,
    });
    expect(outcome).toBeNull();
    expect(adapter.count).toBe(0);
    expect(session.lines).toHaveLength(1);
  });

  it("returns null when nothing needs summarizing (tail already covers keepRecent)", async () => {
    const session = memorySession();
    await session.append({ type: "message", message: userMessage("x".repeat(4000)) });
    const adapter = scriptedAdapter([]);
    const outcome = await compactSession({
      store: session,
      adapter,
      system: "You are chantier.",
      contextWindow: 100_000,
      reserve: 100,
      keepRecent: 20_000,
    });
    expect(outcome).toBeNull();
    expect(adapter.count).toBe(0);
  });
});
