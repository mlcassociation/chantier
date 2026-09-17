import { describe, expect, it } from "vitest";
import {
  ACTION_CHORDS,
  type Keychord,
  keypressToDecision,
  matches,
} from "../src/keys.ts";

const ALL_IDS = Object.keys(ACTION_CHORDS) as Array<keyof typeof ACTION_CHORDS>;

describe("action chord table", () => {
  it("binds every action id to at least one non-empty chord set", () => {
    expect(ALL_IDS.length).toBeGreaterThanOrEqual(19);
    for (const id of ALL_IDS) {
      expect(ACTION_CHORDS[id]?.length).toBeGreaterThan(0);
    }
  });

  it("resolves each editor chord", () => {
    expect(matches({ input: "a", ctrl: true }, "app.editor.home")).toBe(true);
    expect(matches({ input: "e", ctrl: true }, "app.editor.end")).toBe(true);
    expect(matches({ input: "b", ctrl: true }, "app.editor.char.back")).toBe(true);
    expect(matches({ input: "f", ctrl: true }, "app.editor.char.forward")).toBe(true);
    expect(matches({ input: "k", ctrl: true }, "app.editor.kill.to-end")).toBe(true);
    expect(matches({ input: "u", ctrl: true }, "app.editor.kill.line")).toBe(true);
    expect(matches({ input: "w", ctrl: true }, "app.editor.kill.word")).toBe(true);
    expect(matches({ backspace: true }, "app.editor.backspace")).toBe(true);
    expect(matches({ delete: true }, "app.editor.backspace")).toBe(true);
  });

  it("resolves navigation and submit chords", () => {
    expect(matches({ upArrow: true }, "app.history.prev")).toBe(true);
    expect(matches({ downArrow: true }, "app.history.next")).toBe(true);
    expect(matches({ upArrow: true }, "app.queue.edit")).toBe(true);
    expect(matches({ return: true }, "app.submit")).toBe(true);
    expect(matches({ escape: true }, "app.interrupt")).toBe(true);
    expect(matches({ escape: true }, "app.decide.abort")).toBe(true);
  });

  it("resolves approval decision chords and strips bundled Enter", () => {
    expect(matches({ input: "y\r" }, "app.decide.allow")).toBe(true);
    expect(matches({ input: "a\r" }, "app.decide.always")).toBe(true);
    expect(matches({ input: "n\r" }, "app.decide.deny")).toBe(true);
    expect(matches({ input: "y" }, "app.decide.always")).toBe(false);
  });

  it("is strict about non-matching fields", () => {
    expect(matches({ input: "a" }, "app.editor.home")).toBe(false);
    expect(matches({ escape: true }, "app.submit")).toBe(false);
    expect(matches({ upArrow: true }, "app.history.next")).toBe(false);
  });
});

describe("ctrl-c is the only quit chord (BUG-3)", () => {
  it("matches ctrl-c exactly", () => {
    expect(matches({ input: "c", ctrl: true }, "app.quit")).toBe(true);
  });

  it("never matches other ctrl-modified keys", () => {
    expect(matches({ input: "x", ctrl: true }, "app.quit")).toBe(false);
    expect(matches({ input: "d", ctrl: true }, "app.quit")).toBe(false);
    // ctrl-l is the redraw hook point, not a quit path.
    expect(matches({ input: "l", ctrl: true }, "app.quit")).toBe(false);
    expect(matches({ input: "l", ctrl: true }, "app.redraw")).toBe(true);
  });

  it("does not match the bare letter c", () => {
    expect(matches({ input: "c" }, "app.quit")).toBe(false);
  });
});

describe("keypressToDecision (moved unchanged from app.ts)", () => {
  it("maps y, a, and n to decisions", () => {
    expect(keypressToDecision("y")).toEqual({ approved: true });
    expect(keypressToDecision("a")).toEqual({ approved: true, remember: true });
    expect(keypressToDecision("n")).toEqual({ approved: false, reason: "user denied" });
    expect(keypressToDecision("q")).toBeNull();
  });

  it("handles a PTY chunk that bundles the key with its Enter", () => {
    expect(keypressToDecision("y\r")).toEqual({ approved: true });
    expect(keypressToDecision("n\n")).toEqual({ approved: false, reason: "user denied" });
  });
});