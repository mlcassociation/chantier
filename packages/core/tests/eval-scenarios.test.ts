import type {
  AgentEvent,
  Message,
  SessionEntry,
  SessionStore,
  ToolDefinition,
} from "@chantier/core";
import type { ApprovalRequest, ApprovalSink } from "@chantier/permissions";
import { createAllowAllSink, createPermissionEngine } from "@chantier/permissions";
import { describe, expect, it } from "vitest";
import { runAgent } from "../src/agent.ts";
import { scriptedAdapter } from "./helpers/scripted.ts";

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

const writeTool: ToolDefinition = {
  name: "write",
  description: "writes",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" }, content: { type: "string" } },
  },
  readOnly: false,
  specifier: (input) => String(input.path ?? ""),
  handler: async (input) => `wrote ${String(input.content)} to ${String(input.path)}`,
};

const BASE = {
  tools: [readTool, writeTool],
  permission: createPermissionEngine({}),
  system: "You are chantier.",
  cwd: "/tmp/fake-project",
  signal: new AbortController().signal,
  messages: [] as Message[],
};

async function collect(generator: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of generator) events.push(event);
  return events;
}

function resultOf(events: AgentEvent[]): Extract<AgentEvent, { type: "result" }> {
  const last = events.at(-1);
  if (last?.type !== "result") throw new Error("expected a result event");
  return last;
}

function toolResultsOf(events: AgentEvent[]): Array<Extract<AgentEvent, { type: "tool-result" }>> {
  return events.filter(
    (event): event is Extract<AgentEvent, { type: "tool-result" }> => event.type === "tool-result",
  );
}

function recordingSink(approved: boolean): ApprovalSink & { requests: ApprovalRequest[] } {
  const requests: ApprovalRequest[] = [];
  return {
    requests,
    async ask(request) {
      requests.push(structuredClone(request));
      return { approved };
    },
  };
}

describe("eval scenarios: tool-call sequences and result contracts", () => {
  it("an engine-denied mutation comes back as a denial result and the model finishes with a text-only turn", async () => {
    const adapter = scriptedAdapter([
      [{ type: "tool-call", id: "c1", name: "write", args: { path: "x.txt", content: "hi" } }],
      [
        {
          type: "text-delta",
          text: "Acknowledged — the write was denied; continuing with what is allowed.",
        },
        { type: "finish", stopReason: "end_turn" },
      ],
    ]);
    const events = await collect(
      runAgent({
        ...BASE,
        adapter,
        session: memorySession(),
        permission: createPermissionEngine({ deny: ["write(x.txt)"] }),
        sink: createAllowAllSink(),
      }),
    );

    // Sequence: exactly one executed (denied) call, no retry, no further calls.
    expect(adapter.calls).toBe(2);
    const results = toolResultsOf(events);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ toolName: "write", args: { path: "x.txt" } });
    expect(results[0]?.content).toContain("Permission denied");
    expect(results[0]?.content).toContain("denied by permission rules");
    expect(results[0]?.content).toContain("do not retry");

    const result = resultOf(events);
    expect(result).toMatchObject({ stopReason: "end_turn", turns: 2 });
    expect(result.text).toContain("denied");
  });

  it("an ask-decision approved by the sink executes the mutation", async () => {
    const adapter = scriptedAdapter([
      [{ type: "tool-call", id: "c1", name: "write", args: { path: "x.txt", content: "hi" } }],
      [{ type: "finish", stopReason: "end_turn" }],
    ]);
    const sink = recordingSink(true);
    const events = await collect(runAgent({ ...BASE, adapter, session: memorySession(), sink }));

    const results = toolResultsOf(events);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      toolName: "write",
      content: "wrote hi to x.txt",
    });
    expect(sink.requests).toHaveLength(1);
    expect(sink.requests[0]).toMatchObject({ tool: "write", input: { path: "x.txt" } });
    expect(resultOf(events)).toMatchObject({ stopReason: "end_turn" });
  });

  it("an ask-decision rejected by the sink returns the approval-denied content with the headless hint", async () => {
    const adapter = scriptedAdapter([
      [{ type: "tool-call", id: "c1", name: "write", args: { path: "x.txt", content: "hi" } }],
      [{ type: "finish", stopReason: "end_turn" }],
    ]);
    const events = await collect(
      runAgent({ ...BASE, adapter, session: memorySession(), sink: recordingSink(false) }),
    );

    const results = toolResultsOf(events);
    expect(results).toHaveLength(1);
    expect(results[0]?.content).toContain("was not approved");
    expect(results[0]?.content).toContain("rerun with --yolo");
    expect(results[0]?.content).toContain(".chantier/settings.json");
    expect(resultOf(events)).toMatchObject({ stopReason: "end_turn" });
  });

  it("read-only batching: two read calls run to completion before the mutating call starts", async () => {
    const entryLog: string[] = [];
    const trackedRead: ToolDefinition = {
      ...readTool,
      handler: async (input) => {
        entryLog.push(`read ${String(input.path)}`);
        return `read ${String(input.path)}`;
      },
    };
    const trackedWrite: ToolDefinition = {
      ...writeTool,
      handler: async (input) => {
        entryLog.push(`write ${String(input.path)}`);
        return `wrote to ${String(input.path)}`;
      },
    };
    const adapter = scriptedAdapter([
      [
        { type: "tool-call", id: "r1", name: "read", args: { path: "a.ts" } },
        { type: "tool-call", id: "r2", name: "read", args: { path: "b.ts" } },
        { type: "tool-call", id: "w1", name: "write", args: { path: "c.txt", content: "x" } },
      ],
      [{ type: "finish", stopReason: "end_turn" }],
    ]);
    const events = await collect(
      runAgent({
        ...BASE,
        tools: [trackedRead, trackedWrite],
        adapter,
        session: memorySession(),
        sink: createAllowAllSink(),
      }),
    );

    // Event order: the two read results precede the write's result.
    expect(toolResultsOf(events).map((event) => event.toolCallId)).toEqual(["r1", "r2", "w1"]);
    // Handler entry order proves both reads ran before the mutation started.
    expect(entryLog).toEqual(["read a.ts", "read b.ts", "write c.txt"]);
    expect(resultOf(events)).toMatchObject({ stopReason: "end_turn" });
  });

  it("maxTurns=1 on a tool-calling model stops with max_turns and returns the last text", async () => {
    const adapter = scriptedAdapter([
      [
        { type: "text-delta", text: "Reading the file." },
        { type: "tool-call", id: "c1", name: "read", args: { path: "a.ts" } },
        { type: "finish", stopReason: "end_turn" },
      ],
    ]);
    const events = await collect(
      runAgent({
        ...BASE,
        adapter,
        session: memorySession(),
        sink: createAllowAllSink(),
        maxTurns: 1,
      }),
    );

    expect(toolResultsOf(events).map((event) => event.toolName)).toEqual(["read"]);
    expect(resultOf(events)).toMatchObject({ stopReason: "max_turns", turns: 1 });
    expect((resultOf(events) as { text: string }).text).toBe("Reading the file.");
  });

  it("a context-overflow stream error recovers once via reactive compaction and the retry succeeds", async () => {
    const session = memorySession();
    const startUser: Message = { role: "user", content: [{ type: "text", text: "read a.ts" }] };
    await session.append({ type: "message", message: startUser });
    const overflow = new Error("input length exceeds context window");
    const adapter = scriptedAdapter([
      [
        { type: "tool-call", id: "c1", name: "read", args: { path: "a.ts" } },
        { type: "finish", stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5 } },
      ],
      overflow,
      [
        { type: "text-delta", text: "SUMMARY TEXT" },
        { type: "finish", stopReason: "end_turn" },
      ],
      [
        { type: "text-delta", text: "Recovered." },
        { type: "finish", stopReason: "end_turn" },
      ],
    ]);
    const events = await collect(
      runAgent({
        ...BASE,
        adapter,
        session,
        messages: [startUser],
        sink: createAllowAllSink(),
        contextWindow: 1000,
        compaction: { reserve: 100, keepRecent: 5 },
      }),
    );

    // Sequence: tool turn → failed stream → summarizer → retried text-only turn.
    expect(adapter.calls).toBe(4);
    const compactions = events.filter((event) => event.type === "compaction");
    expect(compactions).toHaveLength(1);
    expect(session.lines.some((entry) => entry.type === "compaction")).toBe(true);
    // The retried turn must not re-run the read: exactly one tool result.
    expect(toolResultsOf(events).map((event) => event.toolName)).toEqual(["read"]);
    expect(resultOf(events)).toMatchObject({ stopReason: "end_turn" });
  });
});
