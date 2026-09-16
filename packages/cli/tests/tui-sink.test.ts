import type { ApprovalRequest, RememberingEngine } from "@chantier/permissions";
import { createTuiStore } from "@chantier/tui";
import { describe, expect, it } from "vitest";
import { createTuiSink } from "../src/interactive.ts";

function stubRememberingEngine(): RememberingEngine & { remembered: string[] } {
  const allowSet = new Set<string>();
  return {
    remember(tool: string): void {
      allowSet.add(tool);
    },
    get remembered(): string[] {
      return [...allowSet];
    },
    evaluate() {
      return "ask";
    },
    isRemoved() {
      return false;
    },
  };
}

describe("createTuiSink", () => {
  it("forwards the diff attachment from the request into the store prompt", async () => {
    const store = createTuiStore({ onAbort: () => {} });
    const sink = createTuiSink(store, {
      permission: stubRememberingEngine(),
    });
    const req = {
      tool: "edit",
      input: { file_path: "src/a.ts" },
      detail: { diff: "--- a/src/a.ts\n+++ b/src/a.ts\n+new line\n" },
    };
    const pending = sink.ask(req);
    expect(store.state.promptDetail).toEqual({
      diff: "--- a/src/a.ts\n+++ b/src/a.ts\n+new line\n",
    });
    store.decide({ approved: true });
    await pending;
    expect(store.state.lines).toEqual(["tool: approved: edit"]);
  });

  it("ignores malformed or absent detail attachments", async () => {
    const store = createTuiStore({ onAbort: () => {} });
    const sink = createTuiSink(store, { permission: stubRememberingEngine() });
    // Malformed on purpose: the runtime payload bypassing the type must be
    // ignored by the sink, not crash the prompt.
    const req = {
      tool: "write",
      input: {},
      detail: { diff: 42 },
    } as unknown as ApprovalRequest;
    const pending = sink.ask(req);
    store.decide({ approved: false, reason: "not now" });
    await pending;
    expect(store.state.lines).toEqual(["tool: denied (not now)"]);
  });

  it("labels decisions with the always qualifier and remembers on grant", async () => {
    const store = createTuiStore({ onAbort: () => {} });
    const permission = stubRememberingEngine();
    const sink = createTuiSink(store, { permission });
    const pending = sink.ask({ tool: "bash", input: {} });
    store.decide({ approved: true, remember: true });
    await pending;
    expect(store.state.lines).toEqual(["tool: approved (always): bash"]);
    expect(permission.remembered).toEqual(["bash"]);
  });

  it("rings the bell when the approval card appears", async () => {
    const store = createTuiStore({ onAbort: () => {} });
    const bells: string[] = [];
    const sink = createTuiSink(store, {
      permission: stubRememberingEngine(),
      bell: () => bells.push("\x07"),
    });
    const pending = sink.ask({ tool: "write", input: {} });
    expect(bells).toEqual(["\x07"]);
    store.decide({ approved: true });
    await pending;
  });
});
