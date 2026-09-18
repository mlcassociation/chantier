import type { ModelAdapter, ModelEvent, SessionEntry, SessionStore } from "@chantier/core";
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
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type InteractiveDeps, runInteractive, subagentInfo } from "../src/interactive.ts";

/**
 * The runInteractive seam, driven end to end with a scripted ModelAdapter and
 * a spec-conformant store double: the store implements the frozen §1 contract
 * (TuiStore & TuiStoreV5, items/queued/running/usage) so these tests pin the
 * LOOP wiring (setRunning calls, §6d queue drain incl. the post-abort drain,
 * exit codes) without depending on either tree's store.ts implementation.
 * They hold for the v0.4 driveAgent body in this tree and for the v0.5 body
 * landing from the parallel worker's tree.
 */

interface FakeStore extends TuiStore, TuiStoreV5 {
  readonly items: Array<TuiItem>;
  readonly recorded: {
    runningCalls: Array<RunningState | null>;
    flashes: Array<string>;
  };
  /** Test hook: hands a task (or null) to the pending awaitTask call. */
  resolveTask(task: string | null): void;
}

const fakeTui = vi.hoisted(() => {
  const stores: Array<FakeStore> = [];
  const buildFakeStore = (handlers: {
    onAbort: (kind: "escape" | "ctrl-c") => void;
  }): FakeStore => {
    const items: Array<TuiItem> = [];
    const queued: Array<string> = [];
    const runningCalls: Array<RunningState | null> = [];
    const flashes: Array<string> = [];
    let running: RunningState | null = null;
    let usage: UsageTotals | undefined;
    let mailbox: string | null | undefined;
    let pending: ((task: string | null) => void) | null = null;
    const state: TuiState = {
      mode: "input",
      items,
      streamText: "",
      todos: [],
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
      todos: [],
      setTodos: () => {},
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
      ask: async () => ({ approved: true }),
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
      flashStatus: (text) => {
        flashes.push(text);
      },
      recorded: { runningCalls, flashes },
      resolveTask: (task) => {
        if (pending !== null) {
          const resolve = pending;
          pending = null;
          resolve(task);
          return;
        }
        mailbox = task;
      },
    };
    stores.push(store);
    return store;
  };
  return { stores, buildFakeStore };
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
    id: "loop-test-session",
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
 * Scripted adapter: events stream in push order; a `{hold}` entry suspends
 * the stream until the promise settles, so tests can queue rows (or abort)
 * while the run is genuinely open. `Promise.withResolvers` gates let the test
 * reject the hold to emulate an aborted stream.
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

function makeDeps(session: SessionStore, adapter: ModelAdapter): InteractiveDeps {
  return {
    adapter,
    tools: [],
    permission: createRememberingEngine(createPermissionEngine({})),
    session,
    cwd: "/tmp/fake-project",
    system: "You are chantier.",
    messages: [],
  };
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

function currentStore(): FakeStore {
  const store = fakeTui.stores[0];
  if (store === undefined) throw new Error("runInteractive did not create a store");
  return store;
}

/**
 * Bounded real-clock poll for cross-promise coordination (the loop and the
 * adapter gate resolve on real promises; there is no deterministic signal
 * for "the run has settled" other than observing the store contract).
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
});

// --- Loop wiring -----------------------------------------------------------------

describe("runInteractive loop (§6d)", () => {
  it("drains queued texts as one composite task when a run settles", async () => {
    const session = memorySession();
    const { adapter, push } = scriptedAdapter();
    const hold = Promise.withResolvers<void>();
    push({ type: "text-delta", text: "hello" });
    // Park the first run inside the hold so the queue can fill while the
    // run is genuinely streaming.
    push({ hold: hold.promise });
    const run = runInteractive(makeDeps(session, adapter));
    const store = currentStore();
    try {
      store.resolveTask("first task");
      await waitFor(() => store.recorded.runningCalls.length > 0);
      // Queue two rows mid-run; the second run's script must exist before
      // the first settles.
      store.pushQueued("queued one");
      store.pushQueued("queued two");
      push({ type: "text-delta", text: "second" });
      push({ type: "finish", stopReason: "end_turn" });
      hold.resolve();
      await waitFor(() => store.queued.length === 0);
      // The drain joined both rows in push order as the next task.
      expect(userTexts(session.lines)).toEqual(["first task", "queued one\n\nqueued two"]);
      await waitFor(
        () => store.recorded.runningCalls.length === 4 && store.recorded.runningCalls[3] === null,
      );
    } finally {
      store.resolveTask(null);
    }
    expect(await run).toBe(0);
    // setRunning wires the widget state per run and clears on settle.
    expect(store.recorded.runningCalls).toHaveLength(4);
    expect(store.recorded.runningCalls[0]).not.toBeNull();
    expect(store.recorded.runningCalls[1]).toBeNull();
    expect(store.recorded.runningCalls[2]).not.toBeNull();
    expect(store.recorded.runningCalls[3]).toBeNull();
  });

  it("drains the queue as the next task right after an esc-interrupt", async () => {
    const session = memorySession();
    const { adapter, push } = scriptedAdapter();
    const hold = Promise.withResolvers<void>();
    push({ type: "text-delta", text: "partial" });
    push({ hold: hold.promise });
    const run = runInteractive(makeDeps(session, adapter));
    const store = currentStore();
    try {
      store.resolveTask("first");
      await waitFor(() => store.recorded.runningCalls.length > 0);
      store.pushQueued("after abort");
      push({ type: "text-delta", text: "resumed" });
      push({ type: "finish", stopReason: "end_turn" });
      // Esc-interrupt, then the queued message sends (CC semantics).
      store.abort("escape");
      hold.reject(new Error("stream aborted"));
      await waitFor(() => userTexts(session.lines).length === 2);
      expect(userTexts(session.lines)).toEqual(["first", "after abort"]);
    } finally {
      store.resolveTask(null);
    }
    expect(await run).toBe(0);
    expect(store.recorded.runningCalls).toHaveLength(4);
    expect(store.recorded.runningCalls[3]).toBeNull();
  });

  it("quits with exit 130 on ctrl-c mid-run and never drains the queue", async () => {
    const session = memorySession();
    const { adapter, push } = scriptedAdapter();
    const hold = Promise.withResolvers<void>();
    push({ type: "text-delta", text: "partial" });
    push({ hold: hold.promise });
    const run = runInteractive(makeDeps(session, adapter));
    const store = currentStore();
    store.resolveTask("running task");
    await waitFor(() => store.recorded.runningCalls.length > 0);
    store.pushQueued("should not run");
    store.abort("ctrl-c");
    hold.reject(new Error("stream aborted"));
    expect(await run).toBe(130);
    expect(userTexts(session.lines)).toEqual(["running task"]);
    expect(store.queued).toEqual(["should not run"]);
    // Running state is cleared on the way out.
    expect(store.recorded.runningCalls.at(-1)).toBeNull();
  });

  it("routes /compact without touching the running state", async () => {
    const session = memorySession();
    const { adapter } = scriptedAdapter();
    const run = runInteractive(makeDeps(session, adapter));
    const store = currentStore();
    store.resolveTask("/compact");
    await waitFor(() => store.items.length > 0);
    expect(store.items.map((item) => (item.kind === "info" ? item.text : ""))).toEqual([
      "compaction unavailable: no context window for this model",
    ]);
    store.resolveTask(null);
    expect(await run).toBe(0);
    expect(store.recorded.runningCalls).toEqual([]);
  });

  it("exits 0 when the prompt resolves null and never starts a run", async () => {
    const session = memorySession();
    const { adapter } = scriptedAdapter();
    const run = runInteractive(makeDeps(session, adapter));
    const store = currentStore();
    store.resolveTask(null);
    expect(await run).toBe(0);
    expect(store.recorded.runningCalls).toEqual([]);
    expect(session.lines).toEqual([]);
  });
});

describe("subagentInfo (§4b lane payload)", () => {
  it("splits the task footer into summary + session id", () => {
    const info = subagentInfo(
      "read the auth module and summarized it.\n\n(subagent session: 9f2c1a8b)",
    );
    expect(info).toEqual({
      sessionId: "9f2c1a8b",
      summary: "read the auth module and summarized it.",
    });
  });
  it("returns undefined without a session footer", () => {
    expect(subagentInfo("plain tool output")).toBeUndefined();
  });
});
