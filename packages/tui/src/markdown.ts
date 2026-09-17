import { Text } from "ink";
import { createElement, type ReactNode } from "react";
import type { TuiSymbols } from "./symbols.ts";

/**
 * The v0.5 reading surface (spec local://chantier-tui-v05-spec.md §2): a
 * dependency-free line-based markdown block parser plus the streaming flush
 * splitter. Everything here is pure so the fence/flush rules can be tested
 * without mounting ink.
 */

/** Result of splitting a stream buffer at its last safe paragraph boundary. */
export interface SafeFlush {
  /** Text that is safe to finalize (balanced blocks only); "" when nothing is. */
  readonly flushed: string;
  /** Text that must stay in the live region (may end inside an open fence). */
  readonly rest: string;
}

const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/;

function fenceMarker(line: string): string | null {
  const match = FENCE_OPEN_RE.exec(line);
  return match === null ? null : match[1];
}

/** A closing fence is the same marker run plus optional whitespace, nothing else. */
function closesFence(line: string, marker: string): boolean {
  const rest = line.replace(/^ {0,3}/, "");
  if (!rest.startsWith(marker[0])) return false;
  let run = 0;
  while (run < rest.length && rest[run] === marker[0]) run += 1;
  return run >= marker.length && rest.slice(run).trim() === "";
}

/**
 * Splits a stream buffer at its last safe split point: the final `\n\n`
 * outside an open fence. When the buffer ends inside an open fence and no
 * outside boundary exists, it splits BEFORE the fence start instead, so a
 * half-open code block is never emitted into the finalized transcript. With
 * neither a boundary nor an open fence, nothing flushes.
 */
export function takeSafeFlush(buffer: string): SafeFlush {
  if (buffer.length === 0) return { flushed: "", rest: buffer };
  const lines = buffer.split("\n");
  // Byte offset of each split line; line-array join would lose whether the
  // final element carried its own newline, so splits are computed on offsets.
  const offsets: number[] = [];
  let cursor = 0;
  for (const line of lines) {
    offsets.push(cursor);
    cursor += line.length + 1;
  }

  let inFence = false;
  let openMarker = "";
  let fenceStart = -1;
  let lastBoundaryLine = -1;

  for (let k = 0; k < lines.length; k += 1) {
    const line = lines[k];
    if (inFence) {
      if (closesFence(line, openMarker)) {
        inFence = false;
        openMarker = "";
      }
      continue;
    }
    const marker = fenceMarker(line);
    if (marker !== null) {
      inFence = true;
      openMarker = marker;
      fenceStart = k;
      continue;
    }
    // An empty line outside a fence means the `\n\n` before it (the previous
    // line's newline plus this line's own) is a paragraph boundary. The very
    // last split element of a buffer never carries a trailing newline of its
    // own, so it cannot complete a `\n\n` pair and is skipped.
    if (line === "" && k > 0 && k < lines.length - 1) lastBoundaryLine = k;
  }

  if (lastBoundaryLine >= 0) {
    const boundary = offsets[lastBoundaryLine] + 1;
    return { flushed: buffer.slice(0, boundary), rest: buffer.slice(boundary) };
  }
  if (inFence && fenceStart > 0) {
    const boundary = offsets[fenceStart];
    return { flushed: buffer.slice(0, boundary), rest: buffer.slice(boundary) };
  }
  // No safe split (also: the buffer is one open fence from byte 0, or plain
  // text with no paragraph break yet) — everything stays live.
  return { flushed: "", rest: buffer };
}

/**
 * Cheap streaming fast path (CC ch13): scans only the first 500 chars so a
 * plain-prose stream skips the block parser entirely. Triggers mirror the
 * parser's styled block set — headings, fences, lists, rules, and pipe-led
 * table rows — so a table or rule is never swallowed by the plain path.
 */
const FAST_PATH_WINDOW = 500;
const MARKDOWN_TRIGGER_RE =
  /(^ {0,3}(#{1,6}\s|```|~~~|[-*+]\s|\d{1,9}[.)]\s))|(^ {0,3}(-{3,}|\*{3,}|_{3,})\s*$)|(^\s*\|)/m;

export function hasMarkdownSyntax(text: string): boolean {
  return MARKDOWN_TRIGGER_RE.test(text.slice(0, FAST_PATH_WINDOW));
}

/**
 * Tool output and model text can embed ANSI escapes (color codes survive an
 * adapter round-trip); ink renders the raw escape bytes as garbage, so fenced
 * content is stripped before display. No ANSI passthrough, ever.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escape codes is this rule's whole purpose; the ESC byte must be matched literally
const ANSI_RE = /\u001B\[[0-9;:?]*[A-Za-z]|\u001B/g;
function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

type Block =
  | { kind: "heading"; text: string }
  | { kind: "fence"; lines: string[]; closed: boolean }
  | { kind: "list"; lines: string[] }
  | { kind: "rule" }
  | { kind: "table"; rows: string[][] }
  | { kind: "paragraph"; lines: string[] };

const HEADING_RE = /^ {0,3}#{1,6}\s+(.+)$/;
const HR_RE = /^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;
const LIST_ITEM_RE = /^ {0,3}(?:[-*+]|\d{1,9}[.)])\s+/;
const TABLE_SEPARATOR_RE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

/** Splits one table row into trimmed cells; edge pipes are dropped. */
function tableCells(line: string): string[] {
  let cells = line.split("|");
  if (line.trimStart().startsWith("|")) cells = cells.slice(1);
  if (line.trimEnd().endsWith("|")) cells = cells.slice(0, -1);
  return cells.map((cell) => cell.trim());
}

/** Line-based block parser (spec §2b). Blank lines are paragraph separators. */
function parseBlocks(text: string): Block[] {
  const lines = text.split("\n");
  const blocks: Block[] = [];
  let k = 0;
  while (k < lines.length) {
    const line = lines[k];
    if (line.trim() === "") {
      k += 1;
      continue;
    }
    const heading = HEADING_RE.exec(line);
    if (heading !== null) {
      blocks.push({ kind: "heading", text: heading[1].trim() });
      k += 1;
      continue;
    }
    const marker = fenceMarker(line);
    if (marker !== null) {
      const body: string[] = [];
      let closed = false;
      k += 1;
      while (k < lines.length) {
        if (closesFence(lines[k], marker)) {
          closed = true;
          k += 1;
          break;
        }
        body.push(lines[k]);
        k += 1;
      }
      blocks.push({ kind: "fence", lines: body, closed });
      continue;
    }
    if (HR_RE.test(line)) {
      blocks.push({ kind: "rule" });
      k += 1;
      continue;
    }
    if (LIST_ITEM_RE.test(line)) {
      const block: string[] = [];
      while (k < lines.length && lines[k].trim() !== "" && LIST_ITEM_RE.test(lines[k])) {
        block.push(lines[k]);
        k += 1;
      }
      blocks.push({ kind: "list", lines: block });
      continue;
    }
    if (line.includes("|") && k + 1 < lines.length && TABLE_SEPARATOR_RE.test(lines[k + 1])) {
      const rows = [tableCells(line)];
      k += 2;
      while (k < lines.length && lines[k].includes("|") && lines[k].trim() !== "") {
        rows.push(tableCells(lines[k]));
        k += 1;
      }
      blocks.push({ kind: "table", rows });
      continue;
    }
    // Paragraph: plain lines until a blank line or the start of another block.
    const paragraph: string[] = [];
    while (
      k < lines.length &&
      lines[k].trim() !== "" &&
      HEADING_RE.test(lines[k]) === false &&
      fenceMarker(lines[k]) === null &&
      HR_RE.test(lines[k]) === false &&
      LIST_ITEM_RE.test(lines[k]) === false
    ) {
      paragraph.push(lines[k]);
      k += 1;
    }
    blocks.push({ kind: "paragraph", lines: paragraph });
  }
  return blocks;
}

const DIVIDER_UNICODE = "\u2500";
const DIVIDER_ASCII = "-";
const DIVIDER_WIDTH = 40;

/**
 * Divider/hr rule character. symbols.ts belongs to the parallel activity
 * worker; its `border` field already encodes the ASCII-mode decision, so the
 * rule glyph derives from it until the integration owner migrates both call
 * sites onto that worker's dedicated symbols extension.
 */
function dividerGlyph(symbols: TuiSymbols): string {
  return symbols.border === "single" ? DIVIDER_ASCII : DIVIDER_UNICODE;
}

/** Longest cell per column; rows are padded to these for space alignment. */
function columnWidths(rows: string[][]): number[] {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, column) => {
      widths[column] = Math.max(widths[column] ?? 0, cell.length);
    });
  }
  return widths;
}

/** A dim rule wrapped around `text`; screen readers get the plain text only. */
export function markdownDivider(
  text: string,
  symbols: TuiSymbols,
  screenReader: boolean,
): ReactNode {
  if (screenReader) return createElement(Text, null, text);
  const glyph = dividerGlyph(symbols);
  const rule = glyph.repeat(DIVIDER_WIDTH);
  return createElement(Text, { dimColor: true }, `${rule} ${text} ${rule}`);
}

/** One rendered transcript row: its text plus the optional styling. */
interface RowSpec {
  readonly text: string;
  readonly dim?: boolean;
  readonly bold?: boolean;
  /** Screen-reader replacement (a label) for a purely decorative row. */
  readonly srLabel?: string;
}

/** Parses text into render rows; pure, so tests can assert without ink. */
function renderRows(text: string, symbols: TuiSymbols): RowSpec[] {
  if (!hasMarkdownSyntax(text)) {
    // Fast path: plain prose never touches the block parser (CC ch13).
    return text
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.trim() !== "")
      .map((line) => ({ text: line }));
  }
  const rows: RowSpec[] = [];
  for (const block of parseBlocks(text)) {
    switch (block.kind) {
      case "heading":
        rows.push({ text: block.text, bold: true });
        break;
      case "fence":
        if (block.closed) {
          for (const line of block.lines) {
            rows.push({ text: `  ${stripAnsi(line)}`, dim: true });
          }
        } else {
          // Tolerant live region: an open fence is plain text until closed.
          for (const line of block.lines) {
            rows.push({ text: stripAnsi(line) });
          }
        }
        break;
      case "list":
        for (const line of block.lines) {
          rows.push({
            // Uniform 2-space indent with the original marker kept; deeper
            // nested indents survive past the stripped first level.
            text: `  ${line.replace(/^ {1,3}/, "")}`,
          });
        }
        break;
      case "rule":
        rows.push({
          text: dividerGlyph(symbols).repeat(DIVIDER_WIDTH),
          dim: true,
          srLabel: "divider",
        });
        break;
      case "table": {
        const widths = columnWidths(block.rows);
        for (const row of block.rows) {
          rows.push({
            text: row.map((cell, column) => cell.padEnd(widths[column] ?? cell.length)).join("  "),
          });
        }
        break;
      }
      case "paragraph":
        for (const line of block.lines) {
          rows.push({ text: line });
        }
        break;
    }
  }
  return rows;
}

/**
 * Renders markdown text into ink elements (spec §2b): headings bold, lists
 * indented, fences dim + 2-space indented, rules as divider rows, tables as
 * space-aligned rows. Screen-reader mode renders the same rows unstyled, with
 * decorative rows replaced by their label, and plain input takes the fast
 * path and skips parsing entirely. Tolerant streaming: an unclosed fence
 * renders as plain text until closed, so the strict styling only ever
 * applies to balanced blocks.
 */
export function markdownToElements(
  text: string,
  symbols: TuiSymbols,
  screenReader: boolean,
): ReactNode[] {
  const rows = renderRows(text, symbols);
  if (screenReader) {
    return rows
      .filter((row) => row.text.trim() !== "")
      .map((row, index) => createElement(Text, { key: index }, row.srLabel ?? row.text));
  }
  return rows.map((row, index) =>
    createElement(
      Text,
      {
        key: index,
        ...(row.dim === true ? { dimColor: true } : {}),
        ...(row.bold === true ? { bold: true } : {}),
      },
      row.text,
    ),
  );
}
