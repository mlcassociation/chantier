import { render } from "ink-testing-library";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { keypressToDecision, TuiApp } from "../src/app.ts";
import type { TuiStore } from "../src/store.ts";
import { createTuiStore } from "../src/store.ts";

/**
 * EXCEPTION to the no-test-timers rule (named per policy): ink's stdin
 * pipeline (readline decode → escape-code disambiguation → useInput) is
 * driven by node's real readline timers — the escape key alone waits out
 * node's escapeCodeTimeout before a keypress event exists, and fake timers
 * do not drive readline's internal scheduling. These are integration tests
 * of that pipeline, so the predicate is polled with short real intervals.
 */
function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error("condition not met"));
      setTimeout(poll, 25);
    };
    poll();
  });
}

async function renderStore(store: TuiStore) {
  const instance = render(createElement(TuiApp, { store }));
  await new Promise((r) => setTimeout(r, 100));
  return {
    frame: () => instance.lastFrame() ?? "",
    async key(text: string) {
      instance.stdin.write(text);
      // 100ms: ink's render + readline decode need a beat; under CI load
      // shorter settles flake (observed on the node:22 leg).
      await new Promise((r) => setTimeout(r, 100));
    },
    async escape() {
      await this.key("\x1b");
    },
    unmount: instance.unmount,
  };
}

describe("approval prompt", () => {
  it("maps prompt keypresses to decisions", () => {
    expect(keypressToDecision("y")).toEqual({ approved: true });
    expect(keypressToDecision("a")).toEqual({ approved: true, remember: true });
    expect(keypressToDecision("n")).toEqual({ approved: false, reason: "user denied" });
    expect(keypressToDecision("x")).toBe(null);
  });

  it("decides a PTY chunk that bundles the key with its Enter", () => {
    expect(keypressToDecision("y\r")).toEqual({ approved: true });
    expect(keypressToDecision("a\r")).toEqual({ approved: true, remember: true });
    expect(keypressToDecision("n\r")).toEqual({ approved: false, reason: "user denied" });
  });

  it("renders the pending tool and resolves allow on y", async () => {
    const store = createTuiStore({ onAbort: () => {} });
    const pending = store.ask({ tool: "write", input: { path: "hello.txt", content: "hi" } });
    const view = await renderStore(store);
    expect(view.frame()).toContain("approve write?");
    expect(view.frame()).toContain("hello.txt");
    await view.key("y");
    expect(await pending).toEqual({ approved: true });
    view.unmount();
  });

  it("flags remember on a and denies with reason on n", async () => {
    const store = createTuiStore({ onAbort: () => {} });
    const view = await renderStore(store);
    const first = store.ask({ tool: "bash", input: { command: "tail -n 50 build.log" } });
    await view.key("a");
    await waitFor(() => store.state.prompt === null);
    expect(await first).toEqual({ approved: true, remember: true });
    const second = store.ask({ tool: "write", input: {} });
    await waitFor(() => store.state.prompt !== null);
    await view.key("n");
    await waitFor(() => store.state.prompt === null);
    expect(await second).toEqual({ approved: false, reason: "user denied" });
    view.unmount();
  });

  it("escape aborts: denies the pending prompt and fires onAbort", async () => {
    const aborts: string[] = [];
    const store = createTuiStore({ onAbort: () => aborts.push("escape") });
    const pending = store.ask({ tool: "write", input: {} });
    const view = await renderStore(store);
    await view.escape();
    await waitFor(() => store.state.prompt === null);
    expect(await pending).toEqual({ approved: false, reason: "user aborted" });
    expect(aborts).toEqual(["escape"]);
    view.unmount();
  });

  it("escape with no pending prompt aborts mid-run without a decision", async () => {
    const aborts: string[] = [];
    const store = createTuiStore({ onAbort: () => aborts.push("escape") });
    store.appendStream("partial text");
    const view = await renderStore(store);
    expect(view.frame()).toContain("partial text");
    await view.escape();
    await waitFor(() => aborts.length > 0);
    expect(aborts).toEqual(["escape"]);
    view.unmount();
  });

  it("task prompt: typed text flows to submitTask; q quits", async () => {
    const store = createTuiStore({ onAbort: () => {} });
    const taskPending = store.awaitTask();
    const view = await renderStore(store);
    for (const char of "write hi.txt") {
      await view.key(char);
    }
    expect(store.state.inputText).toBe("write hi.txt");
    await view.key("\r");
    await waitFor(() => store.state.mode === "running");
    expect(await taskPending).toBe("write hi.txt");
    expect(store.state.mode).toBe("running");

    const quitPending = store.awaitTask();
    await view.key("q");
    await view.key("\r");
    expect(await quitPending).toBe(null);
    view.unmount();
  });

  it("submits a PTY-canonical line delivered as one bundled chunk", async () => {
    const store = createTuiStore({ onAbort: () => {} });
    const taskPending = store.awaitTask();
    const view = await renderStore(store);
    // Canonical-mode PTYs deliver a whole line plus Enter as one chunk.
    await view.key("list files\r");
    await waitFor(() => store.state.mode === "running");
    expect(await taskPending).toBe("list files");
    view.unmount();
  });
});
