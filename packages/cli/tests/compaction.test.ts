import type {
  Message,
  ModelAdapter,
  ModelEvent,
  SessionEntry,
  SessionStore,
  ToolDefinition,
} from "@chantier/core";
import {
  createAllowAllSink,
  createPermissionEngine,
  createRememberingEngine,
} from "@chantier/permissions";
import { createTuiStore } from "@chantier/tui";
import { describe, expect, it } from "vitest";
import {
  compactionNotice,
  compactTaskContext,
  driveAgent,
  type InteractiveDeps,
  writeHeadlessCompactionNotice,
} from "../src/interactive.ts";

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

function scriptedAdapter(turns: Array<ModelEvent[] | Error>): ModelAdapter & { count: number } {
  let index = 0;
  return {
    count: 0,
    async *stream() {
      this.count += 1;
      const turn = turns[index];
      index += 1;
      if (turn instanceof Error) throw turn;
      for (const event of turn ?? []) yield event;
    },
  } as ModelAdapter & { count: number };
}

const summarizeTurn: ModelEvent[] = [
  { type: "text-delta", text: "  SUMMARY TEXT  " },
  { type: "finish", stopReason: "end_turn" },
];

const readTool: ToolDefinition = {
  name: "read",
  description: "reads",
  inputSchema: { type: "object", properties: { path: { type: "string" } } },
  readOnly: true,
  handler: async (input) => `contents of ${String(input.path)}`,
};

function userMessage(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}

function makeDeps(
  session: SessionStore,
  messages: Message[],
  adapter: ModelAdapter,
  contextWindow?: number,
): InteractiveDeps {
  return {
    adapter,
    tools: [readTool],
    permission: createRememberingEngine(createPermissionEngine({})),
    session,
    cwd: "/tmp/fake-project",
    system: "You are chantier.",
    messages,
    contextWindow,
  };
}

describe("driveAgent compaction event", () => {
  it("surfaces a runAgent compaction as one plain transcript line", async () => {
    const session = memorySession();
    const logged: Message[] = [userMessage("a".repeat(80_000)), userMessage("b".repeat(80_000))];
    for (const message of logged) await session.append({ type: "message", message });
    const store = createTuiStore({ onAbort: () => {} });
    const deps = makeDeps(
      session,
      [...logged],
      scriptedAdapter([
        [
          { type: "tool-call", id: "c1", name: "read", args: { path: "a.ts" } },
          { type: "finish", stopReason: "end_turn" },
        ],
        summarizeTurn,
        [
          { type: "text-delta", text: "All done." },
          { type: "finish", stopReason: "end_turn" },
        ],
      ]),
      50_000,
    );

    await driveAgent(
      store,
      deps,
      createAllowAllSink(),
      "please continue",
      new AbortController().signal,
    );

    const notice = store.state.items.find(
      (item) =>
        item.kind === "divider" && /^context compacted: ~\d+ -> ~\d+ tokens$/.test(item.text),
    );
    expect(notice).toBeDefined();
    // The compaction landed in the log: entry + summary message appended.
    expect(session.lines.some((entry) => entry.type === "compaction")).toBe(true);
  });
});

describe("compactTaskContext", () => {
  it("auto-compacts an over-threshold view before the next task and reloads the fold", async () => {
    const session = memorySession();
    const logged: Message[] = [
      userMessage("a".repeat(20_000)),
      userMessage("b".repeat(20_000)),
      userMessage("c".repeat(20_000)),
      userMessage("d".repeat(20_000)),
      userMessage("e".repeat(20_000)),
      userMessage("f".repeat(20_000)),
    ];
    for (const message of logged) await session.append({ type: "message", message });
    const store = createTuiStore({ onAbort: () => {} });
    const deps = makeDeps(session, [...logged], scriptedAdapter([summarizeTurn]), 50_000);

    await compactTaskContext(store, deps, {});

    expect(session.lines.some((entry) => entry.type === "compaction")).toBe(true);
    const entryIndex = session.lines.findIndex((entry) => entry.type === "compaction");
    expect(session.lines[entryIndex]).toMatchObject({ firstKeptMessageIndex: 2 });
    // deps.messages reloaded from the folded view: summary + kept tail.
    expect(deps.messages).toHaveLength(5);
    expect(deps.messages[0]?.role).toBe("user");
    expect(
      store.state.items.some(
        (item) =>
          item.kind === "divider" && /^context compacted: ~\d+ -> ~\d+ tokens$/.test(item.text),
      ),
    ).toBe(true);
  });

  it("pushes a no-op notice on a manual /compact under the threshold", async () => {
    const session = memorySession();
    await session.append({ type: "message", message: userMessage("tiny") });
    const store = createTuiStore({ onAbort: () => {} });
    const entries = await session.load(session.id);
    const deps = makeDeps(
      session,
      entries.filter((entry) => entry.type === "message").map((entry) => entry.message),
      scriptedAdapter([]),
      50_000,
    );

    await compactTaskContext(store, deps, { manual: true });

    expect(
      store.state.items.some(
        (item) =>
          item.kind === "info" &&
          /^context compacted \(no-op\): ~\d+ tokens in view$/.test(item.text),
      ),
    ).toBe(true);
    expect(session.lines).toHaveLength(1);
  });

  it("stays silent on an automatic no-op and reports a missing window on manual", async () => {
    const session = memorySession();
    const store = createTuiStore({ onAbort: () => {} });
    const deps = makeDeps(session, [userMessage("hi")], scriptedAdapter([]));

    await compactTaskContext(store, deps, {});
    expect(store.state.items).toEqual([]);

    await compactTaskContext(store, deps, { manual: true });
    expect(store.state.items).toEqual([
      { kind: "info", text: "compaction unavailable: no context window for this model" },
    ]);
    expect(session.lines).toHaveLength(0);
  });
});

describe("notices", () => {
  it("formats the compaction notice deterministically", () => {
    expect(compactionNotice(30000, 2100)).toBe("context compacted: ~30000 -> ~2100 tokens");
  });

  it("prints the headless stderr notice only under --verbose", () => {
    const event = {
      type: "compaction" as const,
      tokensBefore: 900,
      tokensAfter: 120,
      summaryChars: 40,
    };
    const written: string[] = [];
    const write = (line: string): void => {
      written.push(line);
    };
    writeHeadlessCompactionNotice(event, false, write);
    expect(written).toEqual([]);
    writeHeadlessCompactionNotice(event, true, write);
    expect(written).toEqual(["context compacted: ~900 -> ~120 tokens"]);
  });
});
