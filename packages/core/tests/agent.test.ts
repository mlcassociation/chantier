import type { ModelAdapter, ModelEvent, SessionStore, ToolDefinition } from "@chantier/core";
import {
  createAllowAllSink,
  createDenyAllSink,
  createPermissionEngine,
} from "@chantier/permissions";
import { describe, expect, it } from "vitest";
import { type AgentEvent, runAgent } from "../src/agent.ts";

function scriptedAdapter(turns: ModelEvent[][]): ModelAdapter & { calls: number } {
  let index = 0;
  return {
    calls: 0,
    async *stream() {
      this.calls += 1;
      const events = turns[index] ?? [];
      index += 1;
      for (const event of events) yield event;
    },
  } as ModelAdapter & { calls: number };
}

interface MemorySession extends SessionStore {
  lines: unknown[];
}

function memorySession(): MemorySession {
  const lines: unknown[] = [];
  return {
    id: "test-session",
    dir: "/tmp",
    append: async (entry) => {
      lines.push(entry);
    },
    load: async () => structuredClone(lines) as never,
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
  handler: async (input) => `wrote ${String(input.content)} to ${String(input.path)}`,
};

const BASE = {
  tools: [readTool, writeTool],
  permission: createPermissionEngine({}),
  system: "You are chantier.",
  cwd: "/tmp/fake-project",
  signal: new AbortController().signal,
  messages: [],
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

describe("runAgent", () => {
  it("executes a tool call, appends the result, and terminates with a result event", async () => {
    const adapter = scriptedAdapter([
      [
        { type: "text-delta", text: "Let me read." },
        { type: "tool-call", id: "c1", name: "read", args: { path: "a.ts" } },
        { type: "finish", stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5 } },
      ],
      [
        { type: "text-delta", text: "Done." },
        { type: "finish", stopReason: "end_turn", usage: { inputTokens: 30, outputTokens: 3 } },
      ],
    ]);
    const session = memorySession();
    const events = await collect(
      runAgent({ ...BASE, adapter, session, sink: createDenyAllSink() }),
    );

    const toolResults = events.filter((event) => event.type === "tool-result");
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]).toMatchObject({
      toolName: "read",
      args: { path: "a.ts" },
      content: "contents of a.ts",
    });

    expect(resultOf(events)).toMatchObject({
      stopReason: "end_turn",
      usage: { inputTokens: 30, outputTokens: 3 },
    });

    const messages = session.lines
      .map((entry) => entry as { type: string; message?: { role: string } })
      .filter((entry) => entry.type === "message")
      .map((entry) => entry.message?.role);
    expect(messages).toEqual(["assistant", "tool-result", "assistant"]);
  });

  it("feeds a denied mutation back as a result and lets the model recover", async () => {
    const adapter = scriptedAdapter([
      [{ type: "tool-call", id: "c1", name: "write", args: { path: "x.txt", content: "hi" } }],
      [
        { type: "text-delta", text: "Understood, staying read-only." },
        { type: "finish", stopReason: "end_turn" },
      ],
    ]);
    const events = await collect(
      runAgent({ ...BASE, adapter, session: memorySession(), sink: createDenyAllSink() }),
    );
    const denial = events.find((event) => event.type === "tool-result") as
      | { content: string }
      | undefined;
    expect(denial?.content ?? "").toContain("mutation blocked in headless mode");
    expect(resultOf(events)).toMatchObject({ stopReason: "end_turn" });
  });

  it("approves mutations through the AllowAllSink", async () => {
    const adapter = scriptedAdapter([
      [{ type: "tool-call", id: "c1", name: "write", args: { path: "x.txt", content: "hi" } }],
      [{ type: "finish", stopReason: "end_turn" }],
    ]);
    const events = await collect(
      runAgent({ ...BASE, adapter, session: memorySession(), sink: createAllowAllSink() }),
    );
    const executed = events.find((event) => event.type === "tool-result") as
      | { content: string }
      | undefined;
    expect(executed?.content ?? "").toContain("wrote hi to x.txt");
  });

  it("runs consecutive readOnly calls concurrently and preserves order", async () => {
    let entered = 0;
    let releaseAllEntered: () => void = () => {};
    const bothEntered = new Promise<void>((resolve) => {
      releaseAllEntered = resolve;
    });
    const slowRead: ToolDefinition = {
      ...readTool,
      name: "slow-read",
      handler: async (input) => {
        entered += 1;
        if (entered === 2) releaseAllEntered(); // both handlers started → overlap proven
        await bothEntered;
        return `read ${String(input.path)}`;
      },
    };
    const adapter = scriptedAdapter([
      [
        { type: "tool-call", id: "c1", name: "slow-read", args: { path: "1" } },
        { type: "tool-call", id: "c2", name: "slow-read", args: { path: "2" } },
      ],
      [{ type: "finish", stopReason: "end_turn" }],
    ]);
    const events = await collect(
      runAgent({
        ...BASE,
        tools: [slowRead],
        adapter,
        session: memorySession(),
        sink: createDenyAllSink(),
      }),
    );
    const results = events.filter((event) => event.type === "tool-result");
    expect(results).toHaveLength(2);
    expect(String((results[0] as { content: string }).content)).toContain("read 1");
    expect(String((results[1] as { content: string }).content)).toContain("read 2"); // order kept
  });

  it("stops at max_turns with the max_turns stop reason", async () => {
    const endless: ModelEvent[] = [
      { type: "tool-call", id: "x", name: "read", args: { path: "loop" } },
    ];
    const adapter = scriptedAdapter([endless, endless, endless]);
    const events = await collect(
      runAgent({
        ...BASE,
        adapter,
        session: memorySession(),
        sink: createDenyAllSink(),
        maxTurns: 2,
      }),
    );
    expect(resultOf(events)).toMatchObject({ stopReason: "max_turns", turns: 2 });
  });

  it("excludes bare-denied tools from the model's toolset", async () => {
    let offered: string[] = [];
    const spyAdapter: ModelAdapter = {
      async *stream(_messages, tools) {
        offered = tools.map((tool) => tool.name);
        yield { type: "finish", stopReason: "end_turn" } as ModelEvent;
      },
    };
    await collect(
      runAgent({
        ...BASE,
        permission: createPermissionEngine({ deny: ["write"] }),
        adapter: spyAdapter,
        session: memorySession(),
        sink: createDenyAllSink(),
      }),
    );
    expect(offered).toEqual(["read"]);
  });
});
