import type { ApprovalRequest } from "@chantier/permissions";
import { Box, Text, useAnimation } from "ink";
import { createElement, type ReactNode } from "react";
import { classifyUnifiedDiffLine, summarizeUnifiedDiff } from "./diff.ts";
import type { RunningState, TuiItem, UsageTotals } from "./items.ts";
import { APPROVAL_HINT_PARTS } from "./keys.ts";
import type { TuiSymbols } from "./symbols.ts";

/**
 * v0.5 activity + status widgets (spec §2c/§2d/§4/§5/§7). These are
 * standalone, props-driven components: the parallel worker's app.ts mounts
 * them at integration, and tests feed plain data — nothing here imports the
 * store runtime. Every glyph routes through the provided `symbols`, and
 * screen-reader parity renders finalized labeled lines only (§8 matrix).
 */

// --- Shared row-spec helpers -------------------------------------------------

export interface RowSpec {
  readonly text: string;
  readonly color?: string;
  readonly bold?: boolean;
  readonly dim?: boolean;
}

/** Ladder set (§2c): these tools render a second detail line when present. */
const TWO_LINE_TOOLS: Record<string, true> = { task: true, read: true, edit: true };

/** First non-empty line of a tool result, capped for the row preview. */
export function previewLine(content: string, ellipsis: string, cap = 120): string {
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length > 0) {
      return trimmed.length > cap ? `${trimmed.slice(0, cap)}${ellipsis}` : trimmed;
    }
  }
  return "";
}

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return "";
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds - minutes * 60);
  return rest > 0 ? `${minutes}m ${rest}s` : `${minutes}m`;
}

/** "24k"-style token counts for the compaction divider (§2d mockup). */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  const k = tokens / 1000;
  const rounded = Math.round(k * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}k`;
}

function renderRows(rows: Array<RowSpec>): ReactNode {
  return createElement(
    Box,
    { flexDirection: "column" },
    ...rows.map((row, index) =>
      createElement(
        Text,
        {
          key: index,
          color: row.color,
          bold: row.bold === true,
          dimColor: row.dim === true,
        },
        row.text,
      ),
    ),
  );
}

// --- ToolRow (§2c collapse ladder) --------------------------------------------

export type ToolItem = Extract<TuiItem, { kind: "tool" }>;

export interface ToolRowProps {
  readonly item: ToolItem;
  readonly symbols: TuiSymbols;
  readonly screenReader?: boolean;
}

/**
 * Collapse ladder: task/read/edit render two lines (args + detail preview);
 * everything else renders one line. Errors turn the glyph red (§2c). The
 * full output stays in the transcript log; expand/collapse is v0.6.
 */
export function toolRowLines(item: ToolItem, symbols: TuiSymbols): Array<RowSpec> {
  const duration = formatDuration(item.durationMs);
  const durationTail = duration.length > 0 ? ` ${duration}` : "";
  const failed = item.outcome === "error";
  const glyph = failed ? symbols.errorGlyph : symbols.runGlyph;
  const head: RowSpec = {
    text: `${glyph} ${item.toolName}(${item.argsSummary})${durationTail}`,
    ...(failed ? { color: "red" } : {}),
  };
  const detail = item.detail ?? "";
  if (TWO_LINE_TOOLS[item.toolName] !== true || detail.length === 0) return [head];
  return [head, { text: `  ${detail}`, dim: true, ...(failed ? { color: "red" } : {}) }];
}

/** SR parity (§8): `tool: read(src/config.ts) done`. */
export function toolRowSrText(item: ToolItem): string {
  return `tool: ${item.toolName}(${item.argsSummary}) ${item.outcome}`;
}

export function ToolRow({ item, symbols, screenReader = false }: ToolRowProps): ReactNode {
  if (screenReader) return createElement(Text, { key: "sr" }, toolRowSrText(item));
  // A task result carrying a child session renders as the subagent card
  // instead of the plain ladder row (§4b).
  if (item.subagent !== undefined) {
    return createElement(SubagentCard, { item, symbols });
  }
  return renderRows(toolRowLines(item, symbols));
}

// --- SubagentCard (§4b honest wait) -------------------------------------------

export interface SubagentCardProps {
  readonly item: ToolItem & { subagent: { sessionId: string; summary: string } };
  readonly symbols: TuiSymbols;
}

/** Summary block cap: 8 dim lines, then the tail pointer to the child session. */
export const SUBAGENT_SUMMARY_MAX_LINES = 8;

export function subagentLines(
  item: SubagentCardProps["item"],
  symbols: TuiSymbols,
): Array<RowSpec> {
  const sessionId = item.subagent.sessionId.slice(0, 8);
  const duration = formatDuration(item.durationMs);
  const durationTail = duration.length > 0 ? ` ${duration}` : "";
  const head: RowSpec = {
    text: `${symbols.runGlyph} task ${symbols.arrow} subagent (session ${sessionId})${durationTail}`,
  };
  const lines = item.subagent.summary.split("\n");
  const shown: Array<RowSpec> = lines.slice(0, SUBAGENT_SUMMARY_MAX_LINES).map((line) => ({
    text: `    ${line}`,
    dim: true,
  }));
  const tail: RowSpec = {
    text: `    ${symbols.ellipsis} full summary in child session`,
    dim: true,
  };
  return [head, ...shown, tail];
}

export function SubagentCard({ item, symbols }: SubagentCardProps): ReactNode {
  return renderRows(subagentLines(item, symbols));
}

// --- StatusWidget (§4a) --------------------------------------------------------

export interface StatusWidgetProps {
  readonly running: RunningState | null;
  /** Persistent status text (e.g. "thinking…"); "" = none. */
  readonly status: string;
  readonly symbols: TuiSymbols;
  /** Injectable clock source; defaults to Date.now (tests pass a stub). */
  readonly now?: () => number;
  readonly screenReader?: boolean;
}

/** Verbs the widget ever uses; the tail padding pins to the widest one. */
const STATUS_VERBS = ["working", "delegating", "thinking"] as const;

export const STATUS_VERB_WIDTH = Math.max(...STATUS_VERBS.map((verb) => verb.length));

/** Elapsed clock with a bounded tail: s → "1m 12s" → "1h 2m" → "99h+". */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds - minutes * 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  if (hours > 99) return "99h+";
  return `${hours}h ${minutes - hours * 60}m`;
}

export function spinnerFrame(frame: number, symbols: TuiSymbols): string {
  const frames = symbols.spinnerFrames;
  return frames[((frame % frames.length) + frames.length) % frames.length] ?? "";
}

/**
 * The one-line running status: spinner + anti-jitter-padded verb + elapsed +
 * interrupt hint, with the detail line underneath. The verb padding is the
 * Hermes trick: the tail never shifts while the spinner cycles because the
 * verb column width is pinned to the widest verb the widget can show.
 */
export function statusLines(
  frame: number,
  running: RunningState,
  status: string,
  symbols: TuiSymbols,
  elapsedMs: number,
): Array<RowSpec> {
  // Verb derivation: a task delegation shows "delegating" (§4b); the
  // persistent "thinking…" status wins over the default "working".
  const verb = running.detail?.startsWith("task")
    ? "delegating"
    : status.startsWith("thinking")
      ? "thinking"
      : "working";
  const separator = ` ${symbols.hintSeparator} `;
  const head: RowSpec = {
    text: `${spinnerFrame(frame, symbols)} ${verb.padEnd(STATUS_VERB_WIDTH)}${separator}${formatElapsed(elapsedMs)}${separator}esc to interrupt`,
    dim: true,
  };
  const detailLines = (running.detail ?? "")
    .split("\n")
    .slice(0, 3)
    .filter((l) => l.length > 0);
  const detail: Array<RowSpec> = detailLines.map((line) => ({
    text: `${symbols.subGlyph} ${line}`,
    dim: true,
  }));
  return [head, ...detail];
}

export function StatusWidget({
  running,
  status,
  symbols,
  now = Date.now,
  screenReader = false,
}: StatusWidgetProps): ReactNode {
  // useAnimation must run unconditionally (rules of hooks); the shared timer
  // is simply unused when the row is hidden.
  const { frame } = useAnimation({ interval: 120 });
  // Parity §8: SR mode hides the spinner row; the result line carries stats.
  if (running === null || screenReader) return null;
  return renderRows(statusLines(frame, running, status, symbols, now() - running.sinceMs));
}

// --- FooterBar (§5 budgeted segments) ------------------------------------------

export interface FooterBarProps {
  readonly model: string;
  /** 0..1 context estimate; undefined (no declared window) hides the segment. */
  readonly ctxFraction?: number;
  /** Auto-compact reserve would trigger for this task (§5 "compaction soon"). */
  readonly compactSoon?: boolean;
  readonly usage?: UsageTotals;
  readonly sessionId: string;
  readonly columns: number;
  readonly symbols: TuiSymbols;
  /** Hidden entirely while an approval prompt is pending (§5). */
  readonly hidden?: boolean;
}

export function formatTokenCount(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  const k = Math.round((tokens / 1000) * 10) / 10;
  return `${k.toFixed(1)}k`;
}

/** 8-cell context bar; filled cells round to nearest, clamped to [0, 8]. */
export function ctxBar(fraction: number, symbols: TuiSymbols): string {
  const filled = Math.min(8, Math.max(0, Math.round(fraction * 8)));
  return `${symbols.barFilled.repeat(filled)}${symbols.barEmpty.repeat(8 - filled)}`;
}

function ctxLevel(fraction: number): { color?: string; bold?: boolean } {
  if (fraction < 0.5) return { color: "gray" };
  if (fraction < 0.8) return { color: "yellow" };
  return fraction >= 0.95 ? { color: "red", bold: true } : { color: "red" };
}

/**
 * Segment list under the width breakpoints: <64 → model + ctx%; <80 → +
 * session; ≥80 → all four. Whole segments only — never mid-truncate.
 */
export function footerSegments(props: Omit<FooterBarProps, "hidden">): Array<RowSpec> {
  const { model, ctxFraction, compactSoon, usage, sessionId, columns, symbols } = props;
  const showSession = columns >= 64;
  const showTokens = columns >= 80;
  const separator = ` ${symbols.hintSeparator} `;
  const parts: string[] = [model];
  if (ctxFraction !== undefined) {
    const soon = compactSoon === true ? `${separator}compaction soon` : "";
    parts.push(`${ctxBar(ctxFraction, symbols)} ${Math.round(ctxFraction * 100)}%${soon}`);
  }
  if (showTokens && usage !== undefined) {
    parts.push(
      `${formatTokenCount(usage.inputTokens)} in / ${formatTokenCount(usage.outputTokens)} out`,
    );
  }
  if (showSession) parts.push(sessionId.slice(0, 8));
  const level = ctxLevel(ctxFraction ?? 0);
  return [{ text: parts.join(separator), ...level }];
}

export function FooterBar({
  model,
  ctxFraction,
  compactSoon,
  usage,
  sessionId,
  columns,
  symbols,
  hidden = false,
}: FooterBarProps): ReactNode {
  // The whole bar is aria-hidden: SR users get the same numbers from the
  // result line, and a decorative footer would be announced as noise.
  if (hidden) return null;
  const [row] = footerSegments({
    model,
    ctxFraction,
    compactSoon,
    usage,
    sessionId,
    columns,
    symbols,
  });
  if (row === undefined) return null;
  return createElement(
    Box,
    { "aria-hidden": true },
    createElement(
      Text,
      { color: row.color, bold: row.bold === true, dimColor: row.dim === true },
      row.text,
    ),
  );
}

// --- QueuePreview (§6d) ---------------------------------------------------------

export interface QueuePreviewProps {
  readonly queued: readonly string[];
  readonly symbols: TuiSymbols;
}

export const QUEUE_PREVIEW_MAX_ROWS = 2;

/** ≤2 dimmed rows + "+N more"; collapses runs of whitespace per row. */
export function queuePreviewLines(queued: readonly string[], symbols: TuiSymbols): Array<RowSpec> {
  if (queued.length === 0) return [];
  const rows: Array<RowSpec> = queued.slice(0, QUEUE_PREVIEW_MAX_ROWS).map((text) => ({
    text: `queued: ${text.replace(/\s+/g, " ").trim()} (${symbols.arrowUp} to edit)`,
    dim: true,
  }));
  const more = queued.length - QUEUE_PREVIEW_MAX_ROWS;
  if (more > 0) rows.push({ text: `+${more} more`, dim: true });
  return rows;
}

export function QueuePreview({ queued, symbols }: QueuePreviewProps): ReactNode {
  const rows = queuePreviewLines(queued, symbols);
  if (rows.length === 0) return null;
  return createElement(
    Box,
    {
      flexDirection: "column",
      "aria-label": `${queued.length} task${queued.length === 1 ? "" : "s"} queued`,
    },
    ...rows.map((row, index) =>
      createElement(
        Text,
        {
          key: index,
          color: row.color,
          bold: row.bold === true,
          dimColor: row.dim === true,
        },
        row.text,
      ),
    ),
  );
}

// --- ApprovalCardV2 (§7) ---------------------------------------------------------

export interface ApprovalCardDetail {
  readonly diff?: string;
}

export interface ApprovalCardV2Props {
  readonly request: ApprovalRequest;
  readonly detail: ApprovalCardDetail | null;
  readonly symbols: TuiSymbols;
  /** cwd for the ~-shortened path display (CC label-shortening). */
  readonly cwd?: string;
  readonly screenReader?: boolean;
}

const COMMAND_CAP = 80;

function stringField(input: unknown, keys: readonly string[]): string {
  if (typeof input !== "object" || input === null) return "";
  const record = input as Record<string, unknown>;
  for (const key of keys) {
    const value: unknown = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "";
}

/** CC-style shortening: a path under the session cwd renders as ~/rest. */
export function shortenPath(path: string, cwd: string | undefined): string {
  if (cwd === undefined || cwd.length === 0) return path;
  const prefix = cwd.endsWith("/") ? cwd : `${cwd}/`;
  return path.startsWith(prefix) ? `~/${path.slice(prefix.length)}` : path;
}

function elide(text: string, cap: number, ellipsis: string): string {
  return text.length > cap ? `${text.slice(0, cap)}${ellipsis}` : text;
}

/** The ~-shortened edit/write target path (no counts; the SR label reuses it). */
function editTargetPath(input: unknown, cwd?: string): string {
  return shortenPath(stringField(input, ["file_path", "path", "file"]), cwd);
}

/**
 * Humanized subject per tool (§7): edit/write → ~-shortened path + ±counts
 * from the diff detail; bash → command (80 cap); read/grep → the pattern,
 * glob → its pattern; task → first line of the prompt.
 */
export function humanizeApproval(
  tool: string,
  input: unknown,
  detail: ApprovalCardDetail | null,
  symbols: TuiSymbols,
  cwd?: string,
): string {
  if (tool === "edit" || tool === "write") {
    const path = editTargetPath(input, cwd);
    if (detail?.diff !== undefined && detail.diff.length > 0) {
      const preview = summarizeUnifiedDiff(detail.diff);
      return `${path}  +${preview.additions} ${symbols.minus}${preview.deletions}`;
    }
    return path;
  }
  if (tool === "bash") {
    return elide(stringField(input, ["command"]), COMMAND_CAP, symbols.ellipsis);
  }
  if (tool === "task") {
    const firstLine = stringField(input, ["prompt"]).split("\n")[0] ?? "";
    return elide(firstLine, COMMAND_CAP, symbols.ellipsis);
  }
  if (tool === "grep") return stringField(input, ["pattern", "query", "path"]);
  if (tool === "glob") return stringField(input, ["pattern", "path"]);
  return stringField(input, ["path", "file_path", "file", "pattern", "query", "url"]);
}

/** SR parity (§8): `edit src/x.ts: +3 -1`. */
export function approvalSrLabel(
  tool: string,
  input: unknown,
  detail: ApprovalCardDetail | null,
  symbols: TuiSymbols,
  cwd?: string,
): string {
  if (tool === "edit" || tool === "write") {
    // SR parity (§8): plain ASCII signs regardless of render mode.
    const preview =
      detail?.diff !== undefined && detail.diff.length > 0
        ? summarizeUnifiedDiff(detail.diff)
        : null;
    const counts = preview === null ? "" : `: +${preview.additions} -${preview.deletions}`;
    return `${tool} ${editTargetPath(input, cwd)}${counts}`;
  }
  const subject = humanizeApproval(tool, input, detail, symbols, cwd);
  return `approve ${tool} ${subject}`.trim();
}

export interface ApprovalCardV2Spec {
  readonly title: string;
  readonly subject: RowSpec | null;
  readonly diffLines: Array<RowSpec>;
  readonly hiddenLines: number;
  readonly hints: string;
  readonly srLabel: string;
}

/** Pure card spec so tests assert content without mounting ink. */
export function approvalCardSpec(props: {
  request: ApprovalRequest;
  detail: ApprovalCardDetail | null;
  symbols: TuiSymbols;
  cwd?: string;
}): ApprovalCardV2Spec {
  const { request, detail, symbols, cwd } = props;
  const subjectText = humanizeApproval(request.tool, request.input, detail, symbols, cwd);
  const subject: RowSpec | null = subjectText.length > 0 ? { text: subjectText } : null;
  let diffLines: Array<RowSpec> = [];
  let hiddenLines = 0;
  if (detail?.diff !== undefined && detail.diff.length > 0) {
    const preview = summarizeUnifiedDiff(detail.diff);
    // Same line styling app.ts's v0.4 diffCard uses; integration reconciles
    // the two helpers into one when the card replaces the old prompt.
    diffLines = preview.lines.map((line) => {
      const kind = classifyUnifiedDiffLine(line);
      if (kind === "add") return { text: line, color: "green" };
      if (kind === "del") return { text: line, color: "red" };
      if (kind === "meta") return { text: line, dim: true };
      return { text: line };
    });
    hiddenLines = preview.hiddenLines;
  }
  return {
    title: `approve ${request.tool}?`,
    subject,
    diffLines,
    hiddenLines,
    hints: APPROVAL_HINT_PARTS.join(` ${symbols.hintSeparator} `),
    srLabel: approvalSrLabel(request.tool, request.input, detail, symbols, cwd),
  };
}

export function ApprovalCardV2({
  request,
  detail,
  symbols,
  cwd,
  screenReader = false,
}: ApprovalCardV2Props): ReactNode {
  const spec = approvalCardSpec({ request, detail, symbols, cwd });
  if (screenReader) return createElement(Text, null, spec.srLabel);
  return createElement(
    Box,
    {
      flexDirection: "column",
      borderStyle: symbols.border,
      borderColor: "yellow",
      paddingX: 1,
      "aria-role": "button",
      "aria-label": spec.srLabel,
    },
    createElement(Text, { bold: true, color: "yellow" }, spec.title),
    spec.subject !== null
      ? createElement(Text, { key: "subject", dimColor: true }, spec.subject.text)
      : null,
    ...spec.diffLines.map((row, index) =>
      createElement(
        Text,
        {
          key: index,
          color: row.color,
          bold: row.bold === true,
          dimColor: row.dim === true,
        },
        row.text,
      ),
    ),
    spec.hiddenLines > 0
      ? createElement(
          Text,
          { key: "more", dimColor: true },
          `${symbols.ellipsis} ${spec.hiddenLines} more lines`,
        )
      : null,
    createElement(Text, { key: "hints" }, spec.hints),
  );
}

// --- Divider (§2d compaction marker) ---------------------------------------------

export interface DividerProps {
  readonly text: string;
  readonly symbols: TuiSymbols;
  readonly screenReader?: boolean;
}

/** `── {text} ──` with the ASCII `--` fallback. */
export function dividerLine(text: string, symbols: TuiSymbols): string {
  const rule = symbols.rule.repeat(2);
  return `${rule} ${text} ${rule}`;
}

export function Divider({ text, symbols, screenReader = false }: DividerProps): ReactNode {
  // The compaction item text is built SR-aware by the caller; SR mode
  // renders it as a plain labeled line, no ornamental rules (§8).
  return createElement(
    Text,
    { dimColor: !screenReader },
    screenReader ? text : dividerLine(text, symbols),
  );
}

// --- All-hidden backstop (§4c) ---------------------------------------------------

/**
 * Hermes mechanism: when no tool item survives a visibility filter, the last
 * error item is forced back into view — quiet mode must never hide failures.
 */
export function withErrorBackstop(
  items: readonly TuiItem[],
  isVisible: (item: TuiItem) => boolean,
): readonly TuiItem[] {
  const visible = items.filter(isVisible);
  if (visible.some((item) => item.kind === "tool")) return visible;
  let lastError: TuiItem | undefined;
  for (const item of items) {
    if (item.kind === "error") lastError = item;
  }
  if (lastError === undefined) return visible;
  const forced = new Set<TuiItem>(visible);
  forced.add(lastError);
  return items.filter((item) => forced.has(item));
}
