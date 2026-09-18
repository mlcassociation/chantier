import { render } from "ink-testing-library";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { TuiApp } from "../src/app.ts";
import { createTuiStore, type TuiStore } from "../src/store.ts";
import { useTempHome } from "./helpers/home.ts";

/**
 * EXCEPTION to the no-test-timers rule (named per policy, same rationale as
 * prompt.test.ts): ink commits renders and React effects on the real event
 * loop, so the mount settle below uses a short real timeout — deterministic
 * fake timers cannot drive ink's internal scheduling.
 */
async function renderStore(store: TuiStore) {
  const instance = render(createElement(TuiApp, { store }));
  const settled = Promise.withResolvers<void>();
  setTimeout(settled.resolve, 100);
  await settled.promise;
  return { frame: () => instance.lastFrame() ?? "", unmount: instance.unmount };
}

describe("prompt echo (BUG-6)", () => {
  it("renders the submitted task as a you: line in flat modes", async () => {
    const restoreHome = await useTempHome();
    const previousAscii = process.env.CHANTIER_ASCII;
    process.env.CHANTIER_ASCII = "1";
    try {
      const store = createTuiStore({ onAbort: () => {} });
      store.pushItem({ kind: "prompt", text: "fix the bug" });
      const view = await renderStore(store);
      expect(view.frame()).toContain("you: fix the bug");
      view.unmount();
    } finally {
      if (previousAscii === undefined) delete process.env.CHANTIER_ASCII;
      else process.env.CHANTIER_ASCII = previousAscii;
      restoreHome();
    }
  });

  it("renders the accent prompt glyph in visual mode", async () => {
    const restoreHome = await useTempHome();
    try {
      const store = createTuiStore({ onAbort: () => {} });
      store.pushItem({ kind: "prompt", text: "fix the bug" });
      const view = await renderStore(store);
      expect(view.frame()).toContain("❯");
      expect(view.frame()).toContain("fix the bug");
      view.unmount();
    } finally {
      restoreHome();
    }
  });
});

describe("todo flush item", () => {
  it("renders the flushed checklist with state glyphs", async () => {
    const restoreHome = await useTempHome();
    try {
      const store = createTuiStore({ onAbort: () => {} });
      store.pushItem({ kind: "todo", text: "[x] map seams\n[~] render echo\n[ ] polish" });
      const view = await renderStore(store);
      const frame = view.frame();
      expect(frame).toContain("✓ map seams");
      expect(frame).toContain("● render echo");
      expect(frame).toContain("▢ polish");
      view.unmount();
    } finally {
      restoreHome();
    }
  });

  it("renders ASCII todo glyphs under CHANTIER_ASCII", async () => {
    const restoreHome = await useTempHome();
    const previousAscii = process.env.CHANTIER_ASCII;
    process.env.CHANTIER_ASCII = "1";
    try {
      const store = createTuiStore({ onAbort: () => {} });
      store.pushItem({ kind: "todo", text: "[x] map seams\n[ ] polish" });
      const view = await renderStore(store);
      const frame = view.frame();
      expect(frame).toContain("+ map seams");
      expect(frame).toContain("- polish");
      view.unmount();
    } finally {
      if (previousAscii === undefined) delete process.env.CHANTIER_ASCII;
      else process.env.CHANTIER_ASCII = previousAscii;
      restoreHome();
    }
  });
});
