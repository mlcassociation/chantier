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
      expect(store.state.lines).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("flushStream finalizes pending and live text as transcript lines", () => {
    vi.useFakeTimers();
    try {
      const store = createTuiStore({ onAbort: () => {} });
      store.appendStream("para one");
      vi.runOnlyPendingTimers();
      store.appendStream(" plus pending");
      store.flushStream();
      expect(store.state.streamText).toBe("");
      expect(store.state.lines).toEqual(["para one plus pending"]);
      store.appendStream("a\nb");
      store.flushStream();
      expect(store.state.lines).toEqual(["para one plus pending", "a", "b"]);
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
    expect(store.state.lines).toEqual([]);
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
