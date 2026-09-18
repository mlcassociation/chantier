import { render } from "ink-testing-library";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import type { TuiItem } from "../src/items.ts";
import { ASCII_SYMBOLS, UNICODE_SYMBOLS } from "../src/symbols.ts";
import {
  approvalCardSpec,
  ctxBar,
  Divider,
  dividerLine,
  footerSegments,
  formatDuration,
  formatElapsed,
  formatTokenCount,
  formatTokens,
  previewLine,
  queuePreviewLines,
  StatusWidget,
  SUBAGENT_SUMMARY_MAX_LINES,
  spinnerFrame,
  statusLines,
  subagentLines,
  toolRowLines,
  toolRowSrText,
  withErrorBackstop,
} from "../src/widgets.ts";

/**
 * EXCEPTION to the no-test-timers rule (named per policy): the status widget
 * spins via ink's shared useAnimation timer, which schedules real
 * setTimeout-based renders; fake timers do not drive ink's internal loop.
 * The component test below polls with short real intervals, bounded.
 */

const U = UNICODE_SYMBOLS;
const A = ASCII_SYMBOLS;

describe("glyph resolution (§0 principle 2)", () => {
  it("keeps frame counts and glyph parity across modes", () => {
    expect(U.spinnerFrames.length).toBe(10);
    expect(A.spinnerFrames).toEqual(["|", "/", "-", "\\"]);
    expect(U.runGlyph).toBe("▸");
    expect(A.runGlyph).toBe(">");
    expect(U.errorGlyph).toBe("✗");
    expect(A.errorGlyph).toBe("x");
    expect(spinnerFrame(0, U)).toBe("⠋");
    expect(spinnerFrame(1, U)).toBe("⠙");
    expect(spinnerFrame(3, A)).toBe("\\");
    // Negative and overflow indices stay in range (no undefined glyphs).
    expect(spinnerFrame(-1, U)).toBe("⠏");
    expect(spinnerFrame(10, U)).toBe("⠋");
  });
});

describe("tool row collapse ladder (§2c)", () => {
  it("renders two lines for read/edit/task with a detail preview", () => {
    const rows = toolRowLines(
      {
        kind: "tool",
        toolName: "read",
        argsSummary: '{"path":"src/config.ts"}',
        outcome: "done",
        detail: "1 import { readFile } from node:fs/promises;",
      },
      U,
    );
    expect(rows.length).toBe(2);
    expect(rows[0]?.text).toBe('▸ read({"path":"src/config.ts"})');
    expect(rows[1]?.text).toBe("  1 import { readFile } from node:fs/promises;");
    expect(rows[1]?.dim).toBe(true);
  });

  it("renders one line for bash/grep/glob and for tools without detail", () => {
    const bash = toolRowLines(
      { kind: "tool", toolName: "bash", argsSummary: '{"command":"ls"}', outcome: "done" },
      U,
    );
    expect(bash.length).toBe(1);
    const readNoDetail = toolRowLines(
      { kind: "tool", toolName: "read", argsSummary: "{}", outcome: "done" },
      U,
    );
    expect(readNoDetail.length).toBe(1);
  });

  it("turns the glyph red and keeps two lines for a failed read", () => {
    const rows = toolRowLines(
      {
        kind: "tool",
        toolName: "read",
        argsSummary: "{}",
        outcome: "error",
        detail: "ENOENT: no such file",
      },
      U,
    );
    expect(rows[0]?.text).toBe("✗ read({})");
    expect(rows[0]?.color).toBe("red");
    expect(rows[1]?.color).toBe("red");
  });

  it("shows a duration tail", () => {
    const rows = toolRowLines(
      { kind: "tool", toolName: "bash", argsSummary: "{}", outcome: "done", durationMs: 45 },
      U,
    );
    expect(rows[0]?.text).toBe("▸ bash({}) 45ms");
  });

  it("caps the detail preview at 120 chars with the mode ellipsis", () => {
    const long = "x".repeat(200);
    expect(previewLine(long, U.ellipsis)).toBe(`${"x".repeat(120)}…`);
    expect(previewLine(long, A.ellipsis)).toBe(`${"x".repeat(120)}...`);
    expect(previewLine("\n\n  hello \n", U.ellipsis)).toBe("hello");
  });

  it("keeps SR parity: labeled line only", () => {
    expect(
      toolRowSrText({
        kind: "tool",
        toolName: "read",
        argsSummary: "src/config.ts",
        outcome: "done",
      }),
    ).toBe("tool: read(src/config.ts) done");
  });

  it("formats durations across magnitudes", () => {
    expect(formatDuration(0.4)).toBe("1ms");
    expect(formatDuration(999)).toBe("999ms");
    expect(formatDuration(34_000)).toBe("34s");
    expect(formatDuration(72_000)).toBe("1m 12s");
    expect(formatDuration(undefined)).toBe("");
  });
});

describe("subagent card (§4b)", () => {
  const item = {
    kind: "tool" as const,
    toolName: "task",
    argsSummary: '{"prompt":"read the auth module"}',
    outcome: "done" as const,
    durationMs: 34_000,
    subagent: {
      sessionId: "9f2c1a8b44cc",
      summary: Array.from({ length: 12 }, (_, i) => `summary line ${i + 1}`).join("\n"),
    },
  };

  it("renders the header, caps the summary at 8 lines, and points at the child session", () => {
    const rows = subagentLines(item, U);
    expect(rows[0]?.text).toBe("▸ task → subagent (session 9f2c1a8b) 34s");
    const summaryRows = rows.slice(1, 1 + SUBAGENT_SUMMARY_MAX_LINES);
    expect(summaryRows.length).toBe(SUBAGENT_SUMMARY_MAX_LINES);
    expect(summaryRows[0]?.text).toBe("    summary line 1");
    expect(rows[rows.length - 1]?.text).toBe("    … full summary in child session");
    expect(rows.length).toBe(1 + SUBAGENT_SUMMARY_MAX_LINES + 1);
  });

  it("keeps the whole summary when it is short", () => {
    const rows = subagentLines(
      { ...item, subagent: { sessionId: "abcd1234", summary: "done" } },
      A,
    );
    expect(rows.length).toBe(3);
    expect(rows[1]?.text).toBe("    done");
    expect(rows[2]?.text).toBe("    ... full summary in child session");
  });
});

describe("status widget (§4a)", () => {
  it("pads the verb so the tail never shifts across verbs", () => {
    const base = {
      sinceMs: 0,
    };
    const working = statusLines(0, base, "", U, 72_000);
    const delegating = statusLines(0, { sinceMs: 0, detail: "task → subagent" }, "", U, 72_000);
    const thinking = statusLines(0, base, "thinking…", U, 72_000);
    expect(working[0]?.text.startsWith("⠋ working    · 1m 12s · esc to interrupt")).toBe(true);
    expect(delegating[0]?.text.startsWith("⠋ delegating · 1m 12s · esc to interrupt")).toBe(true);
    expect(working[0]?.text.length).toBe(delegating[0]?.text.length);
    expect(thinking[0]?.text.startsWith("⠋ thinking   · 1m 12s · esc to interrupt")).toBe(true);
  });

  it("keeps the verb width stable across spinner frames", () => {
    const base = { sinceMs: 0, detail: undefined };
    const f0 = statusLines(0, base, "", U, 0);
    const f4 = statusLines(4, base, "", U, 0);
    expect(f0[0]?.text.length).toBe(f4[0]?.text.length);
    expect(f0[0]?.text).toContain("⠋");
    expect(f4[0]?.text).toContain("⠼");
  });

  it("bounds the elapsed clock", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(12_000)).toBe("12s");
    expect(formatElapsed(72_000)).toBe("1m 12s");
    expect(formatElapsed(3_780_000)).toBe("1h 3m");
    expect(formatElapsed(100 * 3600_000)).toBe("99h+");
  });

  it("renders at most 3 detail lines under the header", () => {
    const rows = statusLines(0, { sinceMs: 0, detail: "a\nb\nc\nd" }, "", U, 0);
    expect(rows.length).toBe(4);
    expect(rows[1]?.text).toBe("└ a");
    expect(rows[3]?.text).toBe("└ c");
  });

  it("hides the row in SR mode and renders the row when running", async () => {
    const started = Date.now();
    const instance = render(
      createElement(StatusWidget, {
        running: { sinceMs: started - 1000 },
        status: "",
        symbols: U,
      }),
    );
    try {
      await new Promise((r) => setTimeout(r, 150));
      const frame1 = instance.lastFrame() ?? "";
      expect(frame1).toContain("working");
      expect(frame1).toContain("esc to interrupt");
      // 150ms > one 120ms tick: the spinner has advanced at least once.
      await new Promise((r) => setTimeout(r, 150));
      const frame2 = instance.lastFrame() ?? "";
      expect(frame2.length).toBeGreaterThan(0);
      // Anti-jitter: the verb column stays aligned between frames.
      const verbIndex1 = frame1.indexOf("working");
      const verbIndex2 = frame2.indexOf("working");
      expect(verbIndex1).toBe(verbIndex2);
    } finally {
      instance.unmount();
    }
  });
});

describe("footer segments (§5)", () => {
  const base = {
    model: "glm-5.3-flash:cloud",
    ctxFraction: 0.34,
    usage: { inputTokens: 12_400, outputTokens: 1_100 },
    sessionId: "9f2c1a8b44cc",
    symbols: U,
  };

  it("shrinks whole segments at the 64/80 breakpoints", () => {
    expect(footerSegments({ ...base, columns: 40 })[0]?.text).toBe(
      "glm-5.3-flash:cloud · ▮▮▮▯▯▯▯▯ 34%",
    );
    expect(footerSegments({ ...base, columns: 64 })[0]?.text).toBe(
      "glm-5.3-flash:cloud · ▮▮▮▯▯▯▯▯ 34% · 9f2c1a8b",
    );
    expect(footerSegments({ ...base, columns: 80 })[0]?.text).toBe(
      "glm-5.3-flash:cloud · ▮▮▮▯▯▯▯▯ 34% · 12.4k in / 1.1k out · 9f2c1a8b",
    );
    expect(footerSegments({ ...base, columns: 120 })[0]?.text).toBe(
      footerSegments({ ...base, columns: 80 })[0]?.text,
    );
  });

  it("never mid-truncates: segments are whole", () => {
    for (const columns of [10, 40, 63, 64, 79, 80, 200]) {
      const text = footerSegments({ ...base, columns })[0]?.text ?? "";
      expect(text.endsWith("9f2c1a8b") || text.includes("34%")).toBe(true);
      expect(text.includes("…")).toBe(false);
    }
  });

  it("renders the 8-cell bar with threshold colors and the compaction pulse", () => {
    expect(ctxBar(0.34, U)).toBe("▮▮▮▯▯▯▯▯");
    expect(ctxBar(0, A)).toBe("--------");
    expect(ctxBar(1, A)).toBe("########");
    const near = footerSegments({ ...base, ctxFraction: 0.87, compactSoon: true, columns: 120 });
    expect(near[0]?.text).toContain("compaction soon");
    expect(near[0]?.color).toBe("red");
    const calm = footerSegments({ ...base, ctxFraction: 0.3, columns: 120 });
    expect(calm[0]?.color).toBe("gray");
    const warm = footerSegments({ ...base, ctxFraction: 0.6, columns: 120 });
    expect(warm[0]?.color).toBe("yellow");
    const hot = footerSegments({ ...base, ctxFraction: 0.96, columns: 120 });
    expect(hot[0]?.bold).toBe(true);
  });

  it("formats token counts like the §5 mockup", () => {
    const tokens = footerSegments({ ...base, columns: 80 })[0]?.text ?? "";
    expect(tokens).toContain("12.4k in / 1.1k out");
    expect(formatTokenCount(990)).toBe("990");
    expect(formatTokenCount(12_345)).toBe("12.3k");
  });

  it("hides the ctx segment when no window is declared", () => {
    const noWindow = footerSegments({ ...base, ctxFraction: undefined, columns: 120 });
    expect(noWindow[0]?.text).toBe("glm-5.3-flash:cloud · 12.4k in / 1.1k out · 9f2c1a8b");
  });
});

describe("queue preview (§6d)", () => {
  it("shows at most two dimmed rows plus a +N more tail", () => {
    const rows = queuePreviewLines(["also update the README", "second task", "third task"], U);
    expect(rows.length).toBe(3);
    expect(rows[0]?.text).toBe("queued: also update the README (↑ to edit)");
    expect(rows[0]?.dim).toBe(true);
    expect(rows[2]?.text).toBe("+1 more");
  });

  it("collapses whitespace and resolves the ASCII arrow", () => {
    const rows = queuePreviewLines(["line one\nline two"], A);
    expect(rows[0]?.text).toBe("queued: line one line two (^ to edit)");
  });

  it("renders nothing for an empty queue", () => {
    expect(queuePreviewLines([], U)).toEqual([]);
  });
});

describe("approval card v2 (§7)", () => {
  const diff = [
    "--- a/src/config.ts",
    "+++ b/src/config.ts",
    "@@ -12,7 +12,7 @@",
    "- timeout: 1000,",
    "+ timeout: 5000,",
    "  context line",
  ].join("\n");

  it("humanizes an edit with a ~-shortened path and counts", () => {
    const spec = approvalCardSpec({
      request: { tool: "edit", input: { file_path: "/home/deb/proj/src/config.ts" } },
      detail: { diff },
      symbols: U,
      cwd: "/home/deb/proj",
    });
    expect(spec.title).toBe("approve edit?");
    expect(spec.subject?.text).toBe("~/src/config.ts  +1 −1");
    expect(spec.diffLines.length).toBe(6);
    expect(spec.hiddenLines).toBe(0);
    expect(spec.hints).toBe("y allow · a always · n deny · esc abort");
  });

  it("caps a bash command at 80 chars and elides", () => {
    const command = "echo".repeat(40);
    const spec = approvalCardSpec({
      request: { tool: "bash", input: { command } },
      detail: null,
      symbols: A,
    });
    expect(spec.subject?.text).toBe(`${command.slice(0, 80)}...`);
  });

  it("uses the specifier for read/grep/glob and the first prompt line for task", () => {
    const read = approvalCardSpec({
      request: { tool: "read", input: { path: "src/x.ts" } },
      detail: null,
      symbols: U,
    });
    expect(read.subject?.text).toBe("src/x.ts");
    const grep = approvalCardSpec({
      request: { tool: "grep", input: { pattern: "TODO", path: "src" } },
      detail: null,
      symbols: U,
    });
    expect(grep.subject?.text).toBe("TODO");
    const task = approvalCardSpec({
      request: { tool: "task", input: { prompt: "read the auth module\n\nmore context" } },
      detail: null,
      symbols: U,
    });
    expect(task.subject?.text).toBe("read the auth module");
  });

  it("caps the diff at 10 lines and shows the more-tail", () => {
    const longDiff = Array.from(
      { length: 14 },
      (_, i) => `${i % 2 === 0 ? "+" : "-"} line ${i}`,
    ).join("\n");
    const spec = approvalCardSpec({
      request: { tool: "edit", input: { file_path: "src/x.ts" } },
      detail: { diff: longDiff },
      symbols: U,
    });
    expect(spec.diffLines.length).toBe(10);
    expect(spec.hiddenLines).toBe(4);
    expect(spec.srLabel).toBe("edit src/x.ts: +7 -7");
  });

  it("renders the SR parity label without the card frame", () => {
    const spec = approvalCardSpec({
      request: { tool: "edit", input: { file_path: "src/x.ts" } },
      detail: { diff: "+only\n" },
      symbols: A,
    });
    expect(spec.srLabel).toBe("edit src/x.ts: +1 -0");
  });
});

describe("divider (§2d)", () => {
  it("wraps the text with mode rules", () => {
    expect(dividerLine("compacted · ~24k → ~8k tokens", U)).toBe(
      "── compacted · ~24k → ~8k tokens ──",
    );
    expect(dividerLine("context compacted: ~24000 -> ~8000 tokens", A)).toBe(
      "-- context compacted: ~24000 -> ~8000 tokens --",
    );
    expect(formatTokens(24_000)).toBe("24k");
    expect(formatTokens(8_100)).toBe("8.1k");
    expect(formatTokens(950)).toBe("950");
  });

  it("renders a dim rule line", () => {
    const instance = render(
      createElement(Divider, { text: "compacted · ~24k → ~8k tokens", symbols: U }),
    );
    try {
      expect(instance.lastFrame() ?? "").toContain("── compacted · ~24k → ~8k tokens ──");
    } finally {
      instance.unmount();
    }
  });
});

describe("all-hidden backstop (§4c)", () => {
  const toolItem: TuiItem = {
    kind: "tool",
    toolName: "read",
    argsSummary: "{}",
    outcome: "done",
  };

  it("forces the last error back into view when quiet mode hides all tool rows", () => {
    const items: TuiItem[] = [
      { kind: "markdown", text: "hello" },
      toolItem,
      { kind: "info", text: "note" },
      { kind: "error", text: "boom" },
    ];
    const quiet = (item: TuiItem): boolean => item.kind !== "tool";
    const visible = withErrorBackstop(items, quiet);
    expect(visible.some((item) => item.kind === "tool")).toBe(false);
    expect(visible.at(-1)).toEqual({ kind: "error", text: "boom" });
  });

  it("keeps everything visible when tool rows survive the filter", () => {
    const items: TuiItem[] = [toolItem, { kind: "error", text: "boom" }];
    const quiet = (item: TuiItem): boolean => item.kind !== "tool";
    expect(withErrorBackstop(items, quiet).length).toBe(1);
    expect(withErrorBackstop(items, () => true).length).toBe(2);
  });

  it("is a no-op without an error item", () => {
    const items: TuiItem[] = [toolItem, { kind: "info", text: "n" }];
    expect(withErrorBackstop(items, () => false).length).toBe(0);
  });
});
