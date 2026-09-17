import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type ApprovalRequest,
  type ApprovalSink,
  createDenyAllSink,
  createPermissionEngine,
  createRememberingEngine,
} from "@chantier/permissions";
import { describe, expect, it } from "vitest";
import { loadNewestSessionId, resumeSessionStore } from "../src/session.ts";
import { type SubagentDeps, spawnSubagent } from "../src/subagent.ts";
import type {
  Message,
  ModelAdapter,
  ModelEvent,
  SessionEntry,
  ToolContext,
  ToolDefinition,
} from "../src/types.ts";

interface FakeToolState {
  reads: number;
  writes: string[];
}

/** Minimal read/write stand-ins for the builtin set, with call recording. */
function fakeTools(): { state: FakeToolState; tools: ToolDefinition[] } {
  const state: FakeToolState = { reads: 0, writes: [] };
  const readTool: ToolDefinition = {
    name: "read",
    description: "reads",
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
    readOnly: true,
    specifier: (input) => (typeof input.path === "string" ? input.path : undefined),
    handler: async () => {
      state.reads += 1;
      return "file contents";
    },
  };
  const writeTool: ToolDefinition = {
    name: "write",
    description: "writes",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
    },
    readOnly: false,
    specifier: (input) => (typeof input.path === "string" ? input.path : undefined),
    handler: async (input) => {
      state.writes.push(String(input.path));
      return `wrote ${String(input.content)} to ${String(input.path)}`;
    },
  };
  return { state, tools: [readTool, writeTool] };
}

function deps(over: {
  adapter: ModelAdapter;
  rules?: SubagentDeps["rules"];
  sink?: ApprovalSink;
  tools?: ToolDefinition[];
}): SubagentDeps {
  return {
    adapter: over.adapter,
    rules: over.rules ?? {},
    sink: over.sink ?? createDenyAllSink(),
    provider: "ollama",
    model: "test-model",
    tools: over.tools ?? fakeTools().tools,
  };
}
function testCtx(cwd: string, signal: AbortSignal): ToolContext {
  return {
    cwd,
    session: { id: "parent-session", dir: cwd, append: async () => {}, load: async () => [] },
    permission: createPermissionEngine({}),
    signal,
  };
}

interface StreamCapture {
  /** The system prompt the child's adapter received, once per stream call. */
  systems: string[];
  /** The child's model-facing tool names, once per stream call. */
  toolNames: string[][];
  /** A snapshot of the child's in-memory context at the start of each turn. */
  turns: Message[][];
}

function capturingAdapter(turns: ModelEvent[][]): {
  adapter: ModelAdapter & { calls: number };
  capture: StreamCapture;
} {
  const capture: StreamCapture = { systems: [], toolNames: [], turns: [] };
  let index = 0;
  const adapter = {
    calls: 0,
    async *stream(messages: Message[], tools: ToolDefinition[]) {
      this.calls += 1;
      const system = messages[0];
      capture.systems.push(system?.role === "system" ? system.content : "");
      capture.toolNames.push(tools.map((tool) => tool.name));
      capture.turns.push(structuredClone(messages));
      const events = turns[index] ?? [];
      index += 1;
      for (const event of events) yield event;
    },
  } as ModelAdapter & { calls: number };
  return { adapter, capture };
}

function toolResults(messages: Message[] | undefined) {
  return (messages ?? []).filter(
    (message): message is Extract<Message, { role: "tool-result" }> =>
      message.role === "tool-result",
  );
}

/** Loads the child transcript for a fresh temp cwd: the only session created there. */
async function loadChildEntries(cwd: string): Promise<SessionEntry[]> {
  const id = await loadNewestSessionId(cwd);
  if (id === null) throw new Error("child session was not created");
  const store = await resumeSessionStore({ cwd, id });
  return store.load(id);
}

async function tempCwd(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "chantier-subagent-"));
}

describe("spawnSubagent", () => {
  it("gives the child a task-free toolset: no task entry and a child task call is not available", async () => {
    const cwd = await tempCwd();
    const { tools } = fakeTools();
    // The CLI passes buildTools() as deps.tools; the depth cap is structural
    // (the builtin set contains no task tool), so the child sees exactly this.
    const { adapter, capture } = capturingAdapter([
      [
        { type: "tool-call", id: "t1", name: "task", args: { prompt: "recurse" } },
        { type: "finish", stopReason: "end_turn" },
      ],
      [{ type: "finish", stopReason: "end_turn" }],
    ]);
    await spawnSubagent(
      { prompt: "outer task" },
      deps({ adapter, tools }),
      testCtx(cwd, new AbortController().signal),
    );

    expect(capture.toolNames[0]).toEqual(["read", "write"]);
    const system = capture.systems[0] ?? "";
    expect(system).toContain("# Subagent role");
    expect(system).toContain("- read (read-only)");
    expect(system).not.toMatch(/^- task\b/m);

    const denial = toolResults(capture.turns[1])[0];
    expect(denial?.toolName).toBe("task");
    expect(denial?.content).toContain('tool "task" is not available');
  });

  it("applies the parent's deny rules to the child even when the sink would approve", async () => {
    const cwd = await tempCwd();
    const { state, tools } = fakeTools();
    const asks: ApprovalRequest[] = [];
    const approvingSink: ApprovalSink = {
      ask: async (req) => {
        asks.push(req);
        return { approved: true };
      },
    };
    const { adapter, capture } = capturingAdapter([
      [
        {
          type: "tool-call",
          id: "w1",
          name: "write",
          args: { path: "dist/out.txt", content: "hi" },
        },
        { type: "finish", stopReason: "end_turn" },
      ],
      [{ type: "finish", stopReason: "end_turn" }],
    ]);
    const result = await spawnSubagent(
      { prompt: "produce the dist bundle" },
      deps({ adapter, sink: approvingSink, rules: { deny: ["write(dist/**)"] }, tools }),
      testCtx(cwd, new AbortController().signal),
    );

    expect(state.writes).toEqual([]);
    expect(asks).toEqual([]); // deny short-circuits: the sink is never consulted
    expect(result.truncated).toBe(false);
    const denial = toolResults(capture.turns[1])[0];
    expect(denial?.content).toContain("denied by permission rules");
  });

  it("starts the child permission fresh: remembered parent grants do not carry over", async () => {
    const cwd = await tempCwd();
    const { state, tools } = fakeTools();
    const rules = { ask: ["write"] };
    // The parent's engine remembers a bare write grant for its own session.
    const parent = createRememberingEngine(createPermissionEngine(rules));
    parent.remember("write");
    expect(parent.evaluate("write", "notes.txt", false)).toBe("allow");

    const asks: ApprovalRequest[] = [];
    const denyingSink: ApprovalSink = {
      ask: async (req) => {
        asks.push(req);
        return { approved: false, reason: "denied by the test sink" };
      },
    };
    const { adapter, capture } = capturingAdapter([
      [
        { type: "tool-call", id: "w1", name: "write", args: { path: "notes.txt", content: "hi" } },
        { type: "finish", stopReason: "end_turn" },
      ],
      [{ type: "finish", stopReason: "end_turn" }],
    ]);
    await spawnSubagent(
      { prompt: "take notes" },
      deps({ adapter, sink: denyingSink, rules, tools }),
      testCtx(cwd, new AbortController().signal),
    );

    // The child's fresh engine starts empty: the write still hits the parent's sink.
    expect(asks).toHaveLength(1);
    expect(state.writes).toEqual([]); // denied by the sink, never executed
    const denial = toolResults(capture.turns[1])[0];
    expect(denial?.content).toContain("was not approved");
  });

  it("routes the child's ask to the parent's sink as a fresh decision", async () => {
    const cwd = await tempCwd();
    const { state, tools } = fakeTools();
    const asks: ApprovalRequest[] = [];
    const approvingSink: ApprovalSink = {
      ask: async (req) => {
        asks.push(req);
        return { approved: true };
      },
    };
    const { adapter } = capturingAdapter([
      [
        { type: "tool-call", id: "w1", name: "write", args: { path: "notes.txt", content: "hi" } },
        { type: "finish", stopReason: "end_turn" },
      ],
      [{ type: "finish", stopReason: "end_turn" }],
    ]);
    await spawnSubagent(
      { prompt: "take notes" },
      deps({ adapter, sink: approvingSink, tools }),
      testCtx(cwd, new AbortController().signal),
    );

    expect(asks).toHaveLength(1);
    expect(asks[0]?.tool).toBe("write");
    expect(asks[0]?.input).toEqual({ path: "notes.txt", content: "hi" });
    expect(asks[0]?.reason).toBe("write notes.txt");
    // Approved by the parent's sink, so the child's write executed.
    expect(state.writes).toEqual(["notes.txt"]);
  });

  it("caps the returned summary at 50 KiB with a marker and the child session id", async () => {
    const cwd = await tempCwd();
    const { adapter } = capturingAdapter([
      [
        { type: "text-delta", text: "x".repeat(60_000) },
        { type: "finish", stopReason: "end_turn" },
      ],
    ]);
    const result = await spawnSubagent(
      { prompt: "summarize a lot" },
      deps({ adapter }),
      testCtx(cwd, new AbortController().signal),
    );

    expect(result.truncated).toBe(true);
    expect(result.text.slice(0, 50 * 1024)).toBe("x".repeat(50 * 1024));
    expect(
      result.text.endsWith(
        `\n[truncated: subagent summary exceeded 50 KiB cap; full transcript session id: ${result.sessionId}]`,
      ),
    ).toBe(true);
    // The reported session id is the child's real transcript on disk.
    const childId = await loadNewestSessionId(cwd);
    expect(childId).toBe(result.sessionId);
  });

  it("propagates abort: the child loop stops and nothing further is appended", async () => {
    const cwd = await tempCwd();
    const controller = new AbortController();
    const { state, tools } = fakeTools();
    let calls = 0;
    // The adapter itself signals when the post-abort-hang point is reached; no
    // wall-clock polling. The hang must resolve via the real AbortSignal.
    const secondStreamStarted = Promise.withResolvers<void>();
    const adapter: ModelAdapter = {
      async *stream(_messages, _tools, signal) {
        calls += 1;
        if (calls === 1) {
          yield { type: "tool-call", id: "c1", name: "read", args: { path: "a.txt" } };
          yield { type: "finish", stopReason: "end_turn" };
          return;
        }
        secondStreamStarted.resolve();
        if (signal.aborted) throw signal.reason;
        const { promise, reject } = Promise.withResolvers<never>();
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        await promise;
      },
    };
    const run = spawnSubagent(
      { prompt: "read stuff" },
      deps({ adapter, tools }),
      testCtx(cwd, controller.signal),
    );
    await secondStreamStarted.promise;
    controller.abort();
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(state.reads).toBe(1); // turn 1 completed before the abort
    expect(calls).toBe(2); // no stream call was made after the abort

    // Nothing was appended after the abort: header, user prompt, the turn-1
    // assistant call, and its result. Once the run rejected, no append can
    // still be in flight (appends happen strictly inside the child loop), so a
    // fresh read of the file is conclusive without a settle delay.
    const entries = await loadChildEntries(cwd);
    expect(entries).toHaveLength(4);
    expect(entries.at(-1)).toMatchObject({
      type: "message",
      message: { role: "tool-result", toolCallId: "c1" },
    });
  });
});
