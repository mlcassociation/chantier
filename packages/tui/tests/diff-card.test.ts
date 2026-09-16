import { render } from "ink-testing-library";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { TuiApp } from "../src/app.ts";
import { createTuiStore, type TuiStore } from "../src/store.ts";

/**
 * EXCEPTION to the no-test-timers rule (named per policy): these render
 * through ink's real render pipeline (same integration surface as
 * prompt.test.ts, whose stdin half needs real timers); the short settles give
 * ink's render commit a beat, and failure mode is a bounded await on the
 * frame content, not a guessed duration.
 */
function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const started = Date.now();
  const poll = () => {
    if (predicate()) return resolve();
    if (Date.now() - started > timeoutMs) return reject(new Error("condition not met"));
    setTimeout(poll, 25);
  };
  poll();
  return promise;
}

async function renderStore(store: TuiStore) {
  const instance = render(createElement(TuiApp, { store }));
  await new Promise((r) => setTimeout(r, 100));
  return {
    frame: () => instance.lastFrame() ?? "",
    unmount: instance.unmount,
  };
}

const FIXTURE_DIFF = [
  "diff --git a/src/hello.ts b/src/hello.ts",
  "--- a/src/hello.ts",
  "+++ b/src/hello.ts",
  "@@ -1,3 +1,4 @@",
  " function greet() {",
  '-  console.log("hi")',
  '+  console.log("hello")',
  '+  console.log("world")',
  " }",
].join("\n");

const LONG_DIFF = Array.from({ length: 14 }, (_, i) => `+line ${i + 1}`).join("\n");

describe("approval card diff attachment", () => {
  it("renders the diff block when the ask carries a diff", async () => {
    const store = createTuiStore({ onAbort: () => {} });
    store.ask({ tool: "edit", input: { file_path: "src/hello.ts" } }, { diff: FIXTURE_DIFF });
    await waitFor(() => store.state.prompt !== null);
    const view = await renderStore(store);
    const frame = view.frame();
    expect(frame).toContain("approve edit?");
    expect(frame).toContain("proposed change");
    expect(frame).toContain('-  console.log("hi")');
    expect(frame).toContain('+  console.log("hello")');
    expect(frame).not.toContain("more lines");
    view.unmount();
  });

  it("caps the preview at 10 lines with a hidden tail", async () => {
    const store = createTuiStore({ onAbort: () => {} });
    store.ask({ tool: "write", input: {} }, { diff: LONG_DIFF });
    await waitFor(() => store.state.prompt !== null);
    const view = await renderStore(store);
    const frame = view.frame();
    expect(frame).toContain("+line 10");
    expect(frame).not.toContain("+line 11");
    expect(frame).toContain("+4 more lines");
    view.unmount();
  });

  it("renders no diff block when the ask has no detail", async () => {
    const store = createTuiStore({ onAbort: () => {} });
    store.ask({ tool: "bash", input: { command: "ls" } });
    await waitFor(() => store.state.prompt !== null);
    const view = await renderStore(store);
    expect(view.frame()).not.toContain("proposed change");
    view.unmount();
  });
});
