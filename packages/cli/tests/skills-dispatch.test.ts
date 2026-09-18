import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createTodoTool,
  loadSkills,
  type ModelAdapter,
  type ModelEvent,
  type SessionEntry,
  type SessionStore,
  type TodoStep,
  type ToolDefinition,
} from "@chantier/core";
import type { ApprovalDecision, ApprovalRequest } from "@chantier/permissions";
import { createPermissionEngine, createRememberingEngine } from "@chantier/permissions";
import type * as TuiModule from "@chantier/tui";
import type {
  RunningState,
  TuiItem,
  TuiState,
  TuiStore,
  TuiStoreV5,
  UsageTotals,
} from "@chantier/tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type InteractiveDeps, runInteractive } from "../src/interactive.ts";

/**
 * v0.6 loop seams driven end to end with a scripted adapter and a
 * spec-conformant store double: skills dispatch (expand rewrite + BUG-6
 * echo), /help, the project-skill trust gate, and the todo-trail flush.
 * The store double supplies the v0.6 todo fields (setTodos) the TUI worker
 * lands — the loop binds them through the deps bridge.
 */

const fakeTui = vi.hoisted(() => {
  type AskMode = "approved" | "declined";
  let askMode: AskMode = "approved";
  interface FakeStore extends TuiStore, TuiStoreV5 {
    readonly recorded: {
      runningCalls: Array<RunningState | null>;
      asks: Array<ApprovalRequest>;
      setTodosCalls: Array<readonly TodoStep[]>;
    };
    readonly items: Array<TuiItem>;
    readonly queued: Array<string>;
    resolveTask(task: string | null): void;
    setTodos(steps: readonly TodoStep[]): void;
  }
  const stores: Array<FakeStore> = [];
  const setAskMode = (mode: AskMode): void => {
    askMode = mode;
  };
  const buildFakeStore = (handlers: {
    onAbort: (kind: "escape" | "ctrl-c") => void;
  }): FakeStore => {
    const items: Array<TuiItem> = [];
    const queued: Array<string> = [];
    const runningCalls: Array<RunningState | null> = [];
    const asks: Array<ApprovalRequest> = [];
    const setTodosCalls: Array<readonly TodoStep[]> = [];
    let running: RunningState | null = null;
    let usage: UsageTotals | undefined;
    let mailbox: string | null | undefined;
    let pending: ((task: string | null) => void) | null = null;
    const state: TuiState = {
      mode: "input",
      items,
      streamText: "",
      status: "",
      running: null,
      queued: [],
      usage: undefined,
      statusFlash: "",
      prompt: null,
      promptDetail: null,
      inputText: "",
      finished: false,
    };
    const store: FakeStore = {
      state,
      subscribe: () => () => {},
      appendStream: () => {},
      flushStream: () => {},
      setStatus: () => {},
      awaitTask: async () => {
        if (mailbox !== undefined) {
          const value = mailbox;
          mailbox = undefined;
          return value;
        }
        const { promise, resolve } = Promise.withResolvers<string | null>();
        pending = resolve;
        return promise;
      },
      submitTask: (text) => {
        if (pending !== null) {
          const resolve = pending;
          pending = null;
          resolve(text);
        }
      },
      backspaceInput: () => {},
      typeInput: () => {},
      ask: async (req: ApprovalRequest): Promise<ApprovalDecision> => {
        asks.push(req);
        return askMode === "approved"
          ? { approved: true }
          : { approved: false, reason: "declined" };
      },
      decide: () => {},
      abort: (kind) => {
        handlers.onAbort(kind);
      },
      finish: () => {},
      items,
      pushItem: (item) => {
        items.push(item);
      },
      setRunning: (next) => {
        running = next;
        runningCalls.push(next);
      },
      get running() {
        return running;
      },
      queued,
      pushQueued: (text) => {
        queued.push(text);
      },
      editQueued: (text) => {
        if (queued.length > 0) queued[queued.length - 1] = text;
      },
      dropQueued: () => {
        queued.pop();
      },
      get usage() {
        return usage;
      },
      setUsage: (next) => {
        usage = next;
      },
      statusFlash: "",
      flashStatus: () => {},
      recorded: { runningCalls, asks, setTodosCalls },
      resolveTask: (task) => {
        if (pending !== null) {
          const resolve = pending;
          pending = null;
          resolve(task);
          return;
        }
        mailbox = task;
      },
      setTodos: (steps: readonly TodoStep[]) => {
        setTodosCalls.push(steps);
      },
    };
    stores.push(store);
    return store;
  };
  return { stores, buildFakeStore, setAskMode };
});

vi.mock("@chantier/tui", async (importOriginal) => {
  const actual = await importOriginal<typeof TuiModule>();
  return {
    ...actual,
    createTuiStore: (handlers: { onAbort: (kind: "escape" | "ctrl-c") => void }) =>
      fakeTui.buildFakeStore(handlers),
    startTui: () => ({ waitUntilExit: async () => {} }),
  };
});

// --- Harness ---------------------------------------------------------------------

interface MemorySession extends SessionStore {
  lines: Array<SessionEntry>;
}

function memorySession(): MemorySession {
  const lines: Array<SessionEntry> = [];
  return {
    id: "skills-test-session",
    dir: "/tmp",
    append: async (entry) => {
      lines.push(entry);
    },
    load: async () => structuredClone(lines),
    lines,
  };
}

type ScriptedEvent = ModelEvent | { hold: Promise<void> };

/**
 * Scripted adapter mirroring interactive-loop.test.ts: events stream in push
 * order; a `{hold}` entry suspends the stream until the promise settles.
 */
function scriptedAdapter(): {
  adapter: ModelAdapter;
  push: (event: ScriptedEvent) => void;
} {
  const queue: Array<ScriptedEvent> = [];
  const adapter: ModelAdapter = {
    async *stream() {
      for (;;) {
        const next: ScriptedEvent | undefined = queue.shift();
        if (next === undefined) throw new Error("scripted adapter exhausted");
        if ("hold" in next) {
          await next.hold;
          continue;
        }
        yield next;
        if (next.type === "finish") return;
      }
    },
  };
  return {
    adapter,
    push: (event) => {
      queue.push(event);
    },
  };
}

const dirs: Array<string> = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** One skill dir named `demo` inside a fresh root. */
async function makeSkillRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "chantier-skills-"));
  dirs.push(root);
  const dir = path.join(root, "demo");
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "SKILL.md"),
    "---\nname: demo\ndescription: Run the demo flow\n---\n\nDemo body instructions.\n",
    "utf8",
  );
  return root;
}

function makeDeps(
  overrides: Partial<InteractiveDeps> & { session: SessionStore; adapter: ModelAdapter },
): InteractiveDeps {
  return {
    tools: [],
    permission: createRememberingEngine(createPermissionEngine({})),
    cwd: "/tmp/fake-project",
    system: "You are chantier.",
    messages: [],
    ...overrides,
  };
}

function currentStore(): (typeof fakeTui)["stores"][number] {
  const store = fakeTui.stores[0];
  if (store === undefined) throw new Error("runInteractive did not create a store");
  return store;
}

/** User-text sequence in the session log, in append order. */
function userTexts(entries: Array<SessionEntry>): Array<string> {
  const texts: Array<string> = [];
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message.role !== "user") continue;
    const first = entry.message.content[0];
    if (first?.type === "text") texts.push(first.text);
  }
  return texts;
}

/** Submitted-prompt echo items (BUG-6 kind), in transcript order. */
function promptItems(store: { items: Array<TuiItem> }): Array<string> {
  const texts: Array<string> = [];
  for (const item of store.items) {
    if (item.kind === "prompt") texts.push(item.text);
  }
  return texts;
}

/**
 * Bounded real-clock poll for cross-promise coordination (the loop and the
 * adapter gate resolve on real promises; there is no deterministic signal
 * for "the run has settled" other than observing the store contract) — the
 * named no-test-timers exception, mirroring interactive-loop.test.ts.
 */
function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const started = Date.now();
  const poll = (): void => {
    if (predicate()) {
      resolve();
      return;
    }
    if (Date.now() - started > timeoutMs) {
      reject(new Error("condition not met"));
      return;
    }
    setTimeout(poll, 25);
  };
  poll();
  return promise;
}

beforeEach(() => {
  fakeTui.stores.length = 0;
  fakeTui.setAskMode("approved");
});

// --- Skills dispatch + BUG-6 echo -------------------------------------------------

describe("runInteractive skills + dispatch", () => {
  it("dispatches /name args to the skill body rewrite and echoes the submitted prompt (BUG-6)", async () => {
    const skills = await loadSkills([await makeSkillRoot()]);
    const session = memorySession();
    const { adapter, push } = scriptedAdapter();
    push({ type: "finish", stopReason: "end_turn" });
    const deps = makeDeps({ session, adapter, skills });
    const run = runInteractive(deps);
    const store = currentStore();
    store.resolveTask("/demo write tests");
    await waitFor(() => store.items.some((item) => item.kind === "prompt"));
    // BUG-6: the submitted prompt echoes verbatim.
    expect(promptItems(store)).toEqual(["/demo write tests"]);
    store.resolveTask(null);
    expect(await run).toBe(0);
    // The agent receives the skill body + ARGUMENTS, never the raw slash line.
    expect(userTexts(session.lines)).toEqual([
      '<skill_content name="demo">\nDemo body instructions.\n</skill_content>\n\nARGUMENTS: write tests',
    ]);
  });

  it("a bare /name rewrites without the ARGUMENTS line", async () => {
    const skills = await loadSkills([await makeSkillRoot()]);
    const session = memorySession();
    const { adapter, push } = scriptedAdapter();
    push({ type: "finish", stopReason: "end_turn" });
    const deps = makeDeps({ session, adapter, skills });
    const run = runInteractive(deps);
    const store = currentStore();
    store.resolveTask("/demo");
    await waitFor(() => userTexts(session.lines).length === 1);
    expect(userTexts(session.lines)[0]).toBe(
      '<skill_content name="demo">\nDemo body instructions.\n</skill_content>',
    );
    store.resolveTask(null);
    expect(await run).toBe(0);
  });

  it("/help lists the registry and dispatches without a run", async () => {
    const session = memorySession();
    const { adapter } = scriptedAdapter();
    const run = runInteractive(makeDeps({ session, adapter }));
    const store = currentStore();
    store.resolveTask("/help");
    await waitFor(() => store.items.length > 0);
    const info = store.items.find((item) => item.kind === "info");
    const text = info && info.kind === "info" ? info.text : "";
    expect(text).toContain("/compact — compact the conversation");
    expect(text).toContain("/help — list slash commands and skills");
    store.resolveTask(null);
    expect(await run).toBe(0);
    expect(session.lines).toEqual([]); // commands never reach the agent
  });

  it("an unregistered slash word goes to the agent verbatim (with the echo)", async () => {
    const session = memorySession();
    const { adapter, push } = scriptedAdapter();
    push({ type: "finish", stopReason: "end_turn" });
    const deps = makeDeps({ session, adapter });
    const run = runInteractive(deps);
    const store = currentStore();
    store.resolveTask("/nope extra");
    await waitFor(() => userTexts(session.lines).length === 1);
    expect(userTexts(session.lines)).toEqual(["/nope extra"]);
    expect(promptItems(store)).toEqual(["/nope extra"]);
    store.resolveTask(null);
    expect(await run).toBe(0);
  });

  it("drained queued texts echo at the same prompt site", async () => {
    const session = memorySession();
    const { adapter, push } = scriptedAdapter();
    const hold = Promise.withResolvers<void>();
    push({ type: "text-delta", text: "hello" });
    push({ hold: hold.promise });
    const deps = makeDeps({ session, adapter });
    const run = runInteractive(deps);
    const store = currentStore();
    store.resolveTask("first task");
    await waitFor(() => store.recorded.runningCalls.length > 0);
    store.pushQueued("queued one");
    store.pushQueued("queued two");
    push({ type: "finish", stopReason: "end_turn" });
    hold.resolve();
    await waitFor(() => store.queued.length === 0);
    await waitFor(() => promptItems(store).length === 2);
    expect(promptItems(store)).toEqual(["first task", "queued one\n\nqueued two"]);
    store.resolveTask(null);
    expect(await run).toBe(0);
  });
});

// --- Project-skill trust gate ------------------------------------------------------

describe("runInteractive project-skill trust gate", () => {
  it("asks once via the pseudo-tool, registers on approval, and rebuilds the system catalog", async () => {
    const projectRoot = await makeSkillRoot();
    const session = memorySession();
    const { adapter, push } = scriptedAdapter();
    push({ type: "finish", stopReason: "end_turn" });
    const deps = makeDeps({ session, adapter, projectSkillRoots: [projectRoot] });
    const run = runInteractive(deps);
    const store = currentStore();
    await waitFor(() => store.recorded.asks.length > 0);
    expect(store.recorded.asks[0]?.tool).toBe("project-skills");
    expect(store.recorded.asks[0]?.input).toEqual({ names: ["demo"] });
    store.resolveTask("/demo now");
    await waitFor(() => userTexts(session.lines).length === 1);
    expect(userTexts(session.lines)[0]).toContain('<skill_content name="demo">');
    expect(userTexts(session.lines)[0]).toContain("ARGUMENTS: now");
    // The tier-1 catalog was rebuilt to include the approved project skill.
    expect(deps.system).toContain("# Skills");
    expect(deps.system).toContain("- demo — Run the demo flow");
    store.resolveTask(null);
    expect(await run).toBe(0);
  });

  it("a declined gate leaves the skill unregistered and the task literal", async () => {
    fakeTui.setAskMode("declined");
    const projectRoot = await makeSkillRoot();
    const session = memorySession();
    const { adapter, push } = scriptedAdapter();
    push({ type: "finish", stopReason: "end_turn" });
    const deps = makeDeps({ session, adapter, projectSkillRoots: [projectRoot] });
    const run = runInteractive(deps);
    const store = currentStore();
    store.resolveTask("/demo now");
    await waitFor(() => userTexts(session.lines).length === 1);
    expect(userTexts(session.lines)).toEqual(["/demo now"]);
    expect(deps.system).not.toContain("# Skills");
    store.resolveTask(null);
    expect(await run).toBe(0);
  });

  it("no project skills means no gate ask at all", async () => {
    const emptyRoot = await mkdtemp(path.join(tmpdir(), "chantier-empty-"));
    dirs.push(emptyRoot);
    const session = memorySession();
    const { adapter, push } = scriptedAdapter();
    push({ type: "finish", stopReason: "end_turn" });
    const deps = makeDeps({ session, adapter, projectSkillRoots: [emptyRoot] });
    const run = runInteractive(deps);
    const store = currentStore();
    store.resolveTask("plain task");
    await waitFor(() => userTexts(session.lines).length === 1);
    expect(store.recorded.asks).toEqual([]);
    store.resolveTask(null);
    expect(await run).toBe(0);
  });
});

// --- Todo trail --------------------------------------------------------------------

describe("runInteractive todo trail", () => {
  it("binds the bridge to the live trail and flushes the final checklist on settle", async () => {
    const session = memorySession();
    const { adapter, push } = scriptedAdapter();
    const todoBridge: { onTodo?: (steps: readonly TodoStep[]) => void } = {};
    const todoTool: ToolDefinition = createTodoTool({
      onTodo: (steps) => todoBridge.onTodo?.(steps),
    });
    push({
      type: "tool-call",
      id: "t1",
      name: "todo",
      args: {
        items: [
          { content: "layout the plan", status: "in_progress" },
          { content: "ship it", status: "completed" },
        ],
      },
    });
    push({ type: "finish", stopReason: "end_turn" });
    const deps = makeDeps({ session, adapter, tools: [todoTool], todoBridge });
    const run = runInteractive(deps);
    const store = currentStore();
    store.resolveTask("do things");
    await waitFor(() => store.recorded.setTodosCalls.length > 0);
    // Live trail: whole-list replace with the normalized checklist.
    expect(store.recorded.setTodosCalls[0]).toEqual([
      { content: "layout the plan", status: "in_progress" },
      { content: "ship it", status: "completed" },
    ]);
    await waitFor(() => store.items.some((item) => item.kind === "todo"));
    // Final flush: one transcript item summarizing the settled state, then
    // the live trail clears.
    const flush = store.items.find((item) => item.kind === "todo");
    const flushText = flush && flush.kind === "todo" ? flush.text : "";
    expect(flushText).toBe("todo: 1 completed, 1 in progress, 0 pending");
    expect(store.recorded.setTodosCalls.at(-1)).toEqual([]);
    store.resolveTask(null);
    expect(await run).toBe(0);
  });
});
