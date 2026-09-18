import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
// Real timers only: ink's readline pipeline drives real timeouts and cannot
// be fake-timed (the no-test-timers integration exception named in
// tests/prompt.test.ts applies to every mounting test here).
import { MARK_TIPS, MARK_WORDMARK, pickTip, renderMark, tuiVersion } from "../src/mark.ts";
import { resolveSymbols } from "../src/symbols.ts";

const base = {
  version: "0.6.0",
  model: "glm-5.3-flash:cloud",
  sessionId: "2026-09-18T07-41-39-116Z-84df8c38",
  tips: true,
};

describe("startup Mark (§Theme 4)", () => {
  it("renders the full block art tier on wide terminals", () => {
    const frame = render(
      renderMark({
        ...base,
        columns: 90,
        symbols: resolveSymbols(false),
        screenReader: false,
        tips: true,
      }),
    ).lastFrame();
    expect(frame).toContain("chantier");
    expect(frame).toContain("the coding harness");
    expect(frame).toContain("model glm-5.3-flash:cloud");
    expect(frame).toContain("session 84df8c38");
    expect(frame).toContain("tip: ");
  });

  it("collapses to the short tier between 48 and 71 columns", () => {
    const frame = render(
      renderMark({
        ...base,
        columns: 60,
        symbols: resolveSymbols(false),
        screenReader: false,
        tips: true,
      }),
    ).lastFrame();
    expect(frame).toContain("chantier · harness");
    expect(frame).not.toContain("▐█▛");
  });

  it("falls back to the wordmark under 48 columns", () => {
    const frame = render(
      renderMark({
        ...base,
        columns: 40,
        symbols: resolveSymbols(false),
        screenReader: false,
        tips: true,
      }),
    ).lastFrame();
    expect(frame).toContain(MARK_WORDMARK);
    expect(frame).not.toContain("█");
  });

  it("uses the plain wordmark tier when symbols have no art (ASCII mode)", () => {
    const frame = render(
      renderMark({
        ...base,
        columns: 90,
        symbols: resolveSymbols(true),
        screenReader: false,
        tips: true,
      }),
    ).lastFrame();
    expect(frame).toContain(MARK_WORDMARK);
    expect(frame).not.toContain("█");
  });

  it("renders flat labeled lines in screen-reader mode", () => {
    const frame = render(
      renderMark({
        ...base,
        columns: 90,
        symbols: resolveSymbols(true),
        screenReader: true,
        tips: true,
      }),
    ).lastFrame();
    expect(frame).toContain("chantier — the coding harness");
    expect(frame).toContain("version ");
    expect(frame).toContain("hints: ");
    expect(frame).not.toContain("█");
  });

  it("silences the tip line with tips: false", () => {
    const frame = render(
      renderMark({
        ...base,
        columns: 90,
        symbols: resolveSymbols(false),
        screenReader: false,
        tips: false,
      }),
    ).lastFrame();
    expect(frame).not.toContain("tip: ");
  });

  it("picks a stable tip per session id across the pool", () => {
    const first = pickTip("session-a", MARK_TIPS);
    expect(pickTip("session-a", MARK_TIPS)).toBe(first);
    expect(MARK_TIPS).toContain(first);
  });

  it("reads the version from the manifest", () => {
    expect(tuiVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("keeps all text legible without color (render never depends on chalk)", () => {
    const frame = render(
      renderMark({
        ...base,
        columns: 90,
        symbols: resolveSymbols(false),
        screenReader: false,
        tips: true,
      }),
    ).lastFrame();
    for (const line of ["chantier", MARK_WORDMARK, "/ commands", "@ files"]) {
      expect(frame).toContain(line.replace(MARK_WORDMARK, "chantier"));
    }
  });
});
