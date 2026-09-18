import { Box, Text } from "ink";
import { createElement, type ReactNode } from "react";
import type { TuiSymbols } from "./symbols.ts";

/**
 * v0.6 slash palette + @ file picker (spec §Theme 3): a pure tiered fuzzy
 * scorer and the rows component. No new dependency — the ladder is
 * basename exact < basename prefix < basename substring < path substring <
 * subsequence, with deterministic tie-breaks (rank, length, text). The
 * component is props-driven like the rest of the widgets; nothing here
 * touches the store or ink's input pipeline.
 */

/**
 * Structural twin of core's CommandSpec (frozen contract §Theme 3): the
 * registry's `list()` passes in unchanged; the TUI keeps its own type so the
 * widget stays decoupled from the core package surface.
 */
export interface PaletteCommand {
  /** `[a-z0-9-]+`, without the leading slash. */
  readonly name: string;
  readonly description: string;
  readonly kind: "action" | "expand";
}

/** One palette row: the inserted label plus an optional dim description. */
export interface PaletteRow {
  readonly label: string;
  readonly detail?: string;
}

/** Palette list cap (§Theme 3): at most 7 visible rows. */
export const PALETTE_MAX_ROWS = 7;

/** Per-row width cap (§Theme 3): rows truncate instead of wrapping the list taller. */
export const PALETTE_MAX_WIDTH = 80;

// Tier ladder. Commands use exact/prefix/substring/subsequence; files add
// the basename vs full-path split (basename substring beats path substring).
const RANK_EXACT = 0;
const RANK_PREFIX = 1;
const RANK_SUBSTRING = 2;
const RANK_PATH = 3;
const RANK_SUBSEQUENCE = 4;

/** Greedy in-order character match; an empty query trivially submatches. */
function isSubsequence(query: string, target: string): boolean {
  let at = 0;
  for (const char of target) {
    if (char === query[at]) at += 1;
    if (at === query.length) return true;
  }
  return query.length === 0;
}

/** Ladder rank of a plain-text target (name or basename); null = no match. */
function textRank(query: string, target: string): number | null {
  if (query.length === 0) return RANK_EXACT;
  if (target === query) return RANK_EXACT;
  if (target.startsWith(query)) return RANK_PREFIX;
  if (target.includes(query)) return RANK_SUBSTRING;
  return null;
}

/** File ladder: basename tiers, then the full path, then subsequence. */
function fileRank(query: string, path: string, basename: string): number | null {
  const base = textRank(query, basename);
  if (base !== null) return base;
  if (query.length > 0 && path.includes(query)) return RANK_PATH;
  if (isSubsequence(query, basename) || isSubsequence(query, path)) return RANK_SUBSEQUENCE;
  return null;
}

/**
 * Ranks commands for the slash palette: exact name < prefix < substring <
 * subsequence, ties broken by (rank, name length, name). An empty query
 * lists everything in registration order (all rank equal).
 */
export function matchCommands(
  commands: readonly PaletteCommand[],
  query: string,
  cap: number = PALETTE_MAX_ROWS,
): readonly PaletteCommand[] {
  const q = query.toLowerCase();
  if (q.length === 0) return commands.slice(0, Math.max(0, cap));
  return commands
    .map((command) => {
      const name = command.name.toLowerCase();
      const rank = textRank(q, name) ?? (isSubsequence(q, name) ? RANK_SUBSEQUENCE : null);
      return { command, rank };
    })
    .filter((entry): entry is { command: PaletteCommand; rank: number } => entry.rank !== null)
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        a.command.name.length - b.command.name.length ||
        a.command.name.localeCompare(b.command.name),
    )
    .slice(0, Math.max(0, cap))
    .map((entry) => entry.command);
}

/**
 * Lowercased basenames per file, computed once per palette open and reused
 * across keystrokes (spec §Theme 3 "cache lowercase basenames per open").
 */
export function fileBasenames(files: readonly string[]): readonly string[] {
  return files.map((file) => {
    const cut = Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\")) + 1;
    return file.slice(cut).toLowerCase();
  });
}

/**
 * File matches for the @ picker: basename exact < basename prefix <
 * basename substring < path substring < subsequence, ties broken by
 * (rank, length, path).
 */
export function matchFiles(
  files: readonly string[],
  basenames: readonly string[],
  query: string,
  cap: number = PALETTE_MAX_ROWS,
): readonly string[] {
  const q = query.toLowerCase();
  return files
    .map((file, index) => ({
      file,
      rank: fileRank(q, file.toLowerCase(), basenames[index] ?? ""),
    }))
    .filter((entry): entry is { file: string; rank: number } => entry.rank !== null)
    .sort(
      (a, b) => a.rank - b.rank || a.file.length - b.file.length || a.file.localeCompare(b.file),
    )
    .slice(0, Math.max(0, cap))
    .map((entry) => entry.file);
}

/** Slash rows: `/name` plus the dim description. */
export function commandRows(commands: readonly PaletteCommand[]): readonly PaletteRow[] {
  return commands.map((command) => ({
    label: `/${command.name}`,
    ...(command.description.length > 0 ? { detail: command.description } : {}),
  }));
}

/** File rows: the relative path verbatim. */
export function fileRows(files: readonly string[]): readonly PaletteRow[] {
  return files.map((file) => ({ label: file }));
}

/** SR announcement (codex #11823 precedent): count once, never per key. */
export function paletteSrLabel(count: number): string {
  return count === 0 ? "no matches" : `${count} matches — up to list`;
}

/**
 * Clamps one row to the width cap: the label first, then the detail
 * (truncated with the symbol ellipsis). The row never wraps, so the list
 * stays one line per row even for deep node_modules paths.
 */
export function clampPaletteRow(
  row: PaletteRow,
  symbols: TuiSymbols,
): { readonly label: string; readonly detail?: string } {
  const ellipsis = symbols.ellipsis;
  if (row.label.length > PALETTE_MAX_WIDTH) {
    return { label: `${row.label.slice(0, PALETTE_MAX_WIDTH - ellipsis.length)}${ellipsis}` };
  }
  if (row.detail === undefined) return { label: row.label };
  const budget = PALETTE_MAX_WIDTH - row.label.length - 2;
  if (row.detail.length <= budget) return { label: row.label, detail: row.detail };
  const keep = budget - ellipsis.length;
  if (keep <= 0) return { label: row.label };
  return { label: row.label, detail: `${row.detail.slice(0, keep)}${ellipsis}` };
}

export interface PaletteProps {
  readonly rows: readonly PaletteRow[];
  /** Selected row index, or -1 when nothing matches. */
  readonly selected: number;
  readonly symbols: TuiSymbols;
  readonly screenReader?: boolean;
}

/**
 * The palette list under the editor: ≤7 rows clamped to the width cap, the
 * selected row highlighted with inverse video + the prompt glyph (the same
 * selection convention as the editor cursor; legible at chalk level 0).
 * SR mode renders the selected row only, with the count announced through
 * the label (flat, no per-keystroke re-render); ASCII mode strips
 * decorative glyphs (the marker resolves to ">").
 */
export function Palette({
  rows,
  selected,
  symbols,
  screenReader = false,
}: PaletteProps): ReactNode {
  const shown = rows.slice(0, PALETTE_MAX_ROWS);
  if (screenReader) {
    const selectedRow = selected >= 0 ? shown[selected] : undefined;
    const text =
      selectedRow === undefined
        ? paletteSrLabel(0)
        : selectedRow.detail === undefined
          ? selectedRow.label
          : `${selectedRow.label} — ${selectedRow.detail}`;
    return createElement(Text, { "aria-label": paletteSrLabel(rows.length) }, text);
  }
  if (shown.length === 0) {
    return createElement(Text, { dimColor: true }, paletteSrLabel(0));
  }
  return createElement(
    Box,
    { flexDirection: "column" },
    ...shown.map((row, index) => {
      const cells = clampPaletteRow(row, symbols);
      const isSelected = index === selected;
      return createElement(
        Box,
        { key: index, flexDirection: "row" },
        createElement(
          Text,
          {
            key: "mark",
            ...(isSelected ? { color: "cyan", bold: true, inverse: true } : {}),
          },
          isSelected ? `${symbols.promptGlyph} ` : "  ",
        ),
        createElement(
          Text,
          {
            key: "label",
            ...(isSelected ? { color: "cyan", bold: true, inverse: true } : {}),
          },
          cells.label,
        ),
        ...(cells.detail === undefined
          ? []
          : [createElement(Text, { key: "detail", dimColor: true }, `  ${cells.detail}`)]),
      );
    }),
  );
}
