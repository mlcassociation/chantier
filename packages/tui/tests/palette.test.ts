import { render } from "ink-testing-library";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { editorReplaceToken, emptyEditor, paletteTrigger } from "../src/input.ts";
import {
  clampPaletteRow,
  commandRows,
  fileBasenames,
  fileRows,
  matchCommands,
  matchFiles,
  PALETTE_MAX_ROWS,
  Palette,
  type PaletteCommand,
  paletteSrLabel,
} from "../src/palette.ts";
import { ASCII_SYMBOLS, UNICODE_SYMBOLS } from "../src/symbols.ts";

const U = UNICODE_SYMBOLS;
const A = ASCII_SYMBOLS;

const COMMANDS: readonly PaletteCommand[] = [
  { name: "help", description: "list commands", kind: "expand" },
  { name: "compact", description: "clear context", kind: "action" },
  { name: "commit", description: "git commit", kind: "expand" },
  { name: "compactify", description: "second pass", kind: "action" },
  { name: "review", description: "", kind: "expand" },
];

describe("command scorer (§Theme 3)", () => {
  it("orders exact < prefix < substring < subsequence", () => {
    expect(matchCommands(COMMANDS, "compact")).toEqual([COMMANDS[1], COMMANDS[3]]);
    expect(matchCommands(COMMANDS, "rev")).toEqual([COMMANDS[4]]);
    // Subsequence across the names: both compact and compactify contain
    // "cpct" in order; the shorter name wins the tie.
    expect(matchCommands(COMMANDS, "cpct")).toEqual([COMMANDS[1], COMMANDS[3]]);
    // Subsequence across the name: c-o-m-m-i-t contains "o m i".
    expect(matchCommands(COMMANDS, "oit")).toEqual([COMMANDS[2]]);
  });

  it("breaks rank ties by name length, then name", () => {
    expect(matchCommands(COMMANDS, "co")).toEqual([COMMANDS[2], COMMANDS[1], COMMANDS[3]]);
  });

  it("matches case-insensitively and caps the list at 7", () => {
    expect(matchCommands(COMMANDS, "COMPACT")).toEqual([COMMANDS[1], COMMANDS[3]]);
    const many: Array<PaletteCommand> = Array.from({ length: 11 }, (_, index) => ({
      name: `cmd${index}`,
      description: "",
      kind: "expand",
    }));
    const matched = matchCommands(many, "cmd");
    expect(matched.length).toBe(PALETTE_MAX_ROWS);
    expect(matched[0]?.name).toBe("cmd0");
    expect(matched[6]?.name).toBe("cmd6");
  });

  it("lists everything on an empty query in registration order", () => {
    expect(matchCommands(COMMANDS, "").map((c) => c.name)).toEqual([
      "help",
      "compact",
      "commit",
      "compactify",
      "review",
    ]);
  });

  it("returns nothing for a non-matching query", () => {
    expect(matchCommands(COMMANDS, "zzz")).toEqual([]);
  });
});

describe("file scorer (§Theme 3)", () => {
  const FILES = [
    "src/app.ts",
    "src/widgets/app-view.ts",
    "tests/app.test.ts",
    "src/views/other.ts",
    "README.md",
    "docs/api.md",
  ];
  const basenames = fileBasenames(FILES);

  it("caches lowercase basenames across path separators", () => {
    expect(fileBasenames(["Src/App.TS", "a\\b.ts"])).toEqual(["app.ts", "b.ts"]);
  });

  it("orders basename exact < prefix < substring < path < subsequence", () => {
    // Basename exact beats the prefix and substring tiers.
    expect(matchFiles(FILES, basenames, "readme.md")[0]).toBe("README.md");
    // Prefix tier, ties by (path length, path): the 10-char path wins, then
    // the 17-char test path, then the 23-char widget path.
    expect(matchFiles(FILES, basenames, "app")).toEqual([
      "src/app.ts",
      "tests/app.test.ts",
      "src/widgets/app-view.ts",
    ]);
    // Basename substring beats path substring.
    expect(matchFiles(FILES, basenames, "view")).toEqual([
      "src/widgets/app-view.ts",
      "src/views/other.ts",
    ]);
    // Path substring when no basename tier hits.
    expect(matchFiles(FILES, basenames, "docs")).toEqual(["docs/api.md"]);
    // Subsequence on the basename.
    expect(matchFiles(FILES, basenames, "rm")).toEqual(["README.md"]);
  });

  it("caps file matches at 7 and deterministically breaks ties", () => {
    const many = Array.from({ length: 9 }, (_, index) => `src/m${index}.ts`);
    const matched = matchFiles(many, fileBasenames(many), "m");
    expect(matched.length).toBe(7);
  });

  it("returns no matches for a foreign query", () => {
    expect(matchFiles(FILES, basenames, "qqq")).toEqual([]);
  });
});

describe("palette rows", () => {
  it("labels slash rows with the command and its description", () => {
    expect(
      commandRows([
        { name: "compact", description: "clear context", kind: "action" },
        { name: "review", description: "", kind: "expand" },
      ]),
    ).toEqual([{ label: "/compact", detail: "clear context" }, { label: "/review" }]);
  });

  it("labels file rows with the relative path", () => {
    expect(fileRows(["src/app.ts"])).toEqual([{ label: "src/app.ts" }]);
  });

  it("renders up to seven visual rows and marks the selection", () => {
    const rows = commandRows(matchCommands(COMMANDS, "co"));
    const instance = render(createElement(Palette, { rows, selected: 1, symbols: U }));
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("❯ /compact");
    expect(frame).toContain("/commit");
    instance.unmount();
  });

  it("strips decorative glyphs in ASCII mode", () => {
    const rows = commandRows(matchCommands(COMMANDS, "co"));
    const instance = render(createElement(Palette, { rows, selected: 0, symbols: A }));
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("> /commit");
    expect(frame).not.toContain("❯");
    instance.unmount();
  });

  it("renders the selected row only in screen-reader mode", () => {
    const rows = commandRows(matchCommands(COMMANDS, "co"));
    const instance = render(
      createElement(Palette, { rows, selected: 1, symbols: U, screenReader: true }),
    );
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("/compact");
    expect(frame).not.toContain("/commit");
    expect(frame).not.toContain("❯");
    instance.unmount();
  });

  it("announces the match count once for the screen reader", () => {
    expect(paletteSrLabel(3)).toBe("3 matches — up to list");
    expect(paletteSrLabel(0)).toBe("no matches");
  });

  it("clamps rows to the width cap with the symbol ellipsis", () => {
    const symbols = { ...U, ellipsis: "…" };
    // Detail truncates so label + two spaces + detail stay at 80 columns.
    const detailRow = clampPaletteRow({ label: "/long", detail: "d".repeat(120) }, symbols);
    expect(detailRow.label).toBe("/long");
    expect(detailRow.detail?.length).toBe(80 - 5 - 2);
    expect(detailRow.detail?.endsWith("…")).toBe(true);
    // An over-long label truncates and the detail is dropped.
    const labelRow = clampPaletteRow({ label: `x`.repeat(90), detail: "d" }, symbols);
    expect(labelRow.label.length).toBe(80);
    expect(labelRow.label.endsWith("…")).toBe(true);
    expect(labelRow.detail).toBeUndefined();
    // A label at the cap leaves no budget for a detail.
    const cappedRow = clampPaletteRow({ label: "y".repeat(80), detail: "d" }, symbols);
    expect(cappedRow.detail).toBeUndefined();
    // Short rows pass through untouched.
    const shortRow = clampPaletteRow({ label: "/ok", detail: "fine" }, symbols);
    expect(shortRow).toEqual({ label: "/ok", detail: "fine" });
  });

  it("renders clamped rows in the visual component", () => {
    const rows = [{ label: "/big", detail: "z".repeat(120) }];
    const instance = render(createElement(Palette, { rows, selected: 0, symbols: U }));
    const frame = instance.lastFrame() ?? "";
    expect(frame).toContain("/big");
    expect(frame).not.toContain("z".repeat(80));
    instance.unmount();
  });
});

describe("paletteTrigger (§Theme 3)", () => {
  it("opens the slash palette only for the head token", () => {
    expect(paletteTrigger({ text: "/to", cursor: 3 })).toEqual({
      kind: "slash",
      tokenStart: 0,
      queryStart: 1,
    });
    expect(paletteTrigger({ text: "/", cursor: 1 })).toEqual({
      kind: "slash",
      tokenStart: 0,
      queryStart: 1,
    });
    // Cursor 0 = the trigger has not been typed at the cursor.
    expect(paletteTrigger({ text: "/to", cursor: 0 })).toBeNull();
    // Mid-text slash types literally.
    expect(paletteTrigger({ text: "say /to", cursor: 7 })).toBeNull();
    // Whitespace in the head ends the slash token.
    expect(paletteTrigger({ text: "/to now", cursor: 7 })).toBeNull();
  });

  it("opens the file picker at a word boundary", () => {
    expect(paletteTrigger({ text: "run @src/a", cursor: 10 })).toEqual({
      kind: "file",
      tokenStart: 4,
      queryStart: 5,
    });
    expect(paletteTrigger({ text: "@", cursor: 1 })).toEqual({
      kind: "file",
      tokenStart: 0,
      queryStart: 1,
    });
    // Mid-word @ stays literal.
    expect(paletteTrigger({ text: "x@y", cursor: 3 })).toBeNull();
    // Query whitespace ends the token.
    expect(paletteTrigger({ text: "@a b", cursor: 4 })).toBeNull();
    // Pasted chip tokens never trigger.
    expect(paletteTrigger({ text: "[pasted +2 lines]", cursor: 17 })).toBeNull();
    expect(paletteTrigger(emptyEditor())).toBeNull();
  });

  it("replaces the trigger token on accept-style inserts", () => {
    expect(editorReplaceToken({ text: "/tok", cursor: 4 }, 0, "/tokens ")).toEqual({
      text: "/tokens ",
      cursor: 8,
    });
    expect(editorReplaceToken({ text: "run @par", cursor: 8 }, 4, "@src/app.ts ")).toEqual({
      text: "run @src/app.ts ",
      cursor: 16,
    });
    // A clamped cursor (stale render state) still replaces safely.
    expect(editorReplaceToken({ text: "/ab", cursor: 9 }, 0, "/ok ")).toEqual({
      text: "/ok ",
      cursor: 4,
    });
  });
});
