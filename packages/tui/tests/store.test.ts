import { describe, expect, it, vi } from "vitest";
import { createTuiStore } from "../src/store.ts";

/**
 * The stream coalescing timer is store-internal scheduling (setTimeout), not
 * ink's stdin pipeline, so fake timers drive it deterministically here. The
 * ink-level input tests keep their named real-timer exception in
 * prompt.test.ts; this file does not need it.
 */
describe("stream coalescing", () => {
  it("lands buffered chunks in one state write per timer tick, not per chunk", () => {
    vi.useFakeTimers();
    try {
      const store = createTuiStore({ onAbort: () => {} });
      let notifications = 0;
      store.subscribe(() => {
        notifications += 1;
      });
      store.appendStream("hel");
      store.appendStream("lo w");
      store.appendStream("orld");
      // Nothing lands synchronously: the chunks wait for the coalesce tick.
      expect(store.state.streamText).toBe("");
      expect(notifications).toBe(0);
      vi.runOnlyPendingTimers();
      expect(store.state.streamText).toBe("hello world");
      // Exactly one listener notification for three chunks.
      expect(notifications).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps accumulating across coalesce ticks until flushStream", () => {
    vi.useFakeTimers();
    try {
      const store = createTuiStore({ onAbort: () => {} });
      store.appendStream("one");
      vi.runOnlyPendingTimers();
      store.appendStream("two");
      vi.runOnlyPendingTimers();
      expect(store.state.streamText).toBe("onetwo");
      expect(store.state.items).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("flushStream finalizes pending and live text as ONE markdown item", () => {
    vi.useFakeTimers();
    try {
      const store = createTuiStore({ onAbort: () => {} });
      store.appendStream("para one");
      vi.runOnlyPendingTimers();
      store.appendStream(" plus\n\npending");
      store.flushStream();
      expect(store.state.streamText).toBe("");
      // The blank-line split bug is fixed: one item, no empty Static rows.
      expect(store.state.items).toEqual([{ kind: "markdown", text: "para one plus\n\npending" }]);
      store.appendStream("a\nb");
      store.flushStream();
      expect(store.state.items).toEqual([
        { kind: "markdown", text: "para one plus\n\npending" },
        { kind: "markdown", text: "a\nb" },
      ]);
      expect(store.state.streamText).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });

  it("flushStream is a no-op with nothing buffered", () => {
    const store = createTuiStore({ onAbort: () => {} });
    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });
    store.flushStream();
    expect(notifications).toBe(0);
    expect(store.state.items).toEqual([]);
  });
});

describe("ask detail normalization", () => {
  it("keeps a non-empty string diff and clears it on decide", async () => {
    const store = createTuiStore({ onAbort: () => {} });
    const pending = store.ask({ tool: "edit", input: {} }, { diff: "--- a\n+++ b\n+a\n" });
    expect(store.state.prompt).not.toBeNull();
    expect(store.state.promptDetail).toEqual({ diff: "--- a\n+++ b\n+a\n" });
    store.decide({ approved: true });
    await pending;
    expect(store.state.promptDetail).toBe(null);
  });

  it("drops empty, malformed, or absent details", async () => {
    const store = createTuiStore({ onAbort: () => {} });
    const pending = store.ask({ tool: "edit", input: {} }, { diff: "" });
    expect(store.state.promptDetail).toBe(null);
    store.decide({ approved: true });
    await pending;

    const second = store.ask({ tool: "edit", input: {} });
    expect(store.state.promptDetail).toBe(null);
    store.decide({ approved: true });
    await second;
  });
});

describe("safe flush (BUG-2 flush point)", () => {
  it("lands the flushed prefix as a markdown item and keeps the remainder live", () => {
    vi.useFakeTimers();
    try {
      const store = createTuiStore({ onAbort: () => {} });
      store.appendStream("first para\n\nopen ```fence");
      vi.runOnlyPendingTimers();
      store.flushStream({ safe: true });
      expect(store.state.items).toEqual([{ kind: "markdown", text: "first para\n\n" }]);
      expect(store.state.streamText).toBe("open ```fence");
    } finally {
      vi.useRealTimers();
    }
  });

  it("splits BEFORE the fence start when the buffer ends inside an open fence", () => {
    vi.useFakeTimers();
    try {
      const store = createTuiStore({ onAbort: () => {} });
      store.appendStream("intro\n```ts\ncode without close");
      vi.runOnlyPendingTimers();
      store.flushStream({ safe: true });
      expect(store.state.items).toEqual([{ kind: "markdown", text: "intro\n" }]);
      expect(store.state.streamText).toBe("```ts\ncode without close");
    } finally {
      vi.useRealTimers();
    }
  });

  it("is a no-op mid-paragraph: nothing finalizes, listeners are not called", () => {
    vi.useFakeTimers();
    try {
      const store = createTuiStore({ onAbort: () => {} });
      store.appendStream("half a paragraph");
      vi.runOnlyPendingTimers();
      let notifications = 0;
      store.subscribe(() => {
        notifications += 1;
      });
      store.flushStream({ safe: true });
      expect(store.state.items).toEqual([]);
      expect(store.state.streamText).toBe("half a paragraph");
      expect(notifications).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("items transitions", () => {
  it("pushItem appends typed items in order", () => {
    const store = createTuiStore({ onAbort: () => {} });
    store.pushItem({ kind: "markdown", text: "hello" });
    store.pushItem({
      kind: "tool",
      toolName: "read",
      argsSummary: "{}",
      outcome: "done",
      detail: "1 import x",
    });
    store.pushItem({ kind: "divider", text: "compacted · ~24k → ~8k tokens" });
    store.pushItem({ kind: "info", text: "cancelled." });
    store.pushItem({ kind: "error", text: "boom" });
    expect(store.state.items).toEqual([
      { kind: "markdown", text: "hello" },
      { kind: "tool", toolName: "read", argsSummary: "{}", outcome: "done", detail: "1 import x" },
      { kind: "divider", text: "compacted · ~24k → ~8k tokens" },
      { kind: "info", text: "cancelled." },
      { kind: "error", text: "boom" },
    ]);
  });
});

describe("queue ops", () => {
  it("push appends, editQueued replaces the last, dropQueued removes it", () => {
    const store = createTuiStore({ onAbort: () => {} });
    store.pushQueued("first");
    store.pushQueued("second");
    expect(store.state.queued).toEqual(["first", "second"]);
    store.editQueued("SECOND");
    expect(store.state.queued).toEqual(["first", "SECOND"]);
    store.dropQueued();
    expect(store.state.queued).toEqual(["first"]);
    store.dropQueued();
    expect(store.state.queued).toEqual([]);
  });

  it("edit/drop are no-ops on an empty queue (no listener calls)", () => {
    const store = createTuiStore({ onAbort: () => {} });
    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });
    store.editQueued("x");
    store.dropQueued();
    expect(store.state.queued).toEqual([]);
    expect(notifications).toBe(0);
  });

  it("the queue survives an abort and a task submission", () => {
    const store = createTuiStore({ onAbort: () => {} });
    store.pushQueued("queued while streaming");
    store.abort("escape");
    expect(store.state.queued).toEqual(["queued while streaming"]);
    store.submitTask("next task");
    expect(store.state.queued).toEqual(["queued while streaming"]);
    expect(store.state.mode).toBe("running");
  });
});

describe("usage and running", () => {
  it("usage is undefined until set, then set/replace/clear", () => {
    const store = createTuiStore({ onAbort: () => {} });
    expect(store.state.usage).toBeUndefined();
    store.setUsage({ inputTokens: 12400, outputTokens: 1100 });
    expect(store.state.usage).toEqual({ inputTokens: 12400, outputTokens: 1100 });
    store.setUsage(undefined);
    expect(store.state.usage).toBeUndefined();
  });

  it("running is set with detail and cleared with null", () => {
    const store = createTuiStore({ onAbort: () => {} });
    expect(store.state.running).toBeNull();
    store.setRunning({ sinceMs: 1000, detail: "task → subagent" });
    expect(store.state.running).toEqual({ sinceMs: 1000, detail: "task → subagent" });
    store.setRunning(null);
    expect(store.state.running).toBeNull();
  });
});

describe("status flash", () => {
  it("shows the flash and falls back to the persistent status after ~5s", () => {
    vi.useFakeTimers();
    try {
      const store = createTuiStore({ onAbort: () => {} });
      store.setStatus("thinking…");
      store.flashStatus("saved");
      expect(store.state.statusFlash).toBe("saved");
      expect(store.state.status).toBe("thinking…");
      vi.advanceTimersByTime(5000);
      expect(store.state.statusFlash).toBe("");
      expect(store.state.status).toBe("thinking…");
    } finally {
      vi.useRealTimers();
    }
  });

  it("an empty flash text clears immediately", () => {
    vi.useFakeTimers();
    try {
      const store = createTuiStore({ onAbort: () => {} });
      store.flashStatus("notice");
      store.flashStatus("");
      expect(store.state.statusFlash).toBe("");
      vi.advanceTimersByTime(10_000);
      expect(store.state.statusFlash).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });
});
