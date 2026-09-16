/**
 * Minimal unified-diff summarization for approval prompts. The TUI shows a
 * capped preview with add/del coloring and announces the change size to
 * screen readers via an aria-label, so raw diffs never reach the buffer
 * unbounded.
 */
export type DiffLineKind = "add" | "del" | "meta" | "context";

const META_PREFIXES = ["diff --git ", "--- ", "+++ ", "index ", "@@"];

/** Classifies one unified-diff line for rendering (add=green, del=red, meta=dim). */
export function classifyUnifiedDiffLine(line: string): DiffLineKind {
  for (const prefix of META_PREFIXES) {
    if (line.startsWith(prefix)) return "meta";
  }
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "context";
}

export interface DiffPreview {
  /** Lines to display, capped at maxLines. */
  readonly lines: readonly string[];
  readonly additions: number;
  readonly deletions: number;
  /** Lines beyond the display cap; the "+N more lines" tail count. */
  readonly hiddenLines: number;
}

export const DIFF_PREVIEW_MAX_LINES = 10;

/** Counts add/del lines across the whole diff and caps the displayed lines. */
export function summarizeUnifiedDiff(
  diff: string,
  maxLines: number = DIFF_PREVIEW_MAX_LINES,
): DiffPreview {
  const split = diff.split("\n");
  if (split.length > 0 && split[split.length - 1] === "") split.pop();
  let additions = 0;
  let deletions = 0;
  for (const line of split) {
    const kind = classifyUnifiedDiffLine(line);
    if (kind === "add") additions += 1;
    else if (kind === "del") deletions += 1;
  }
  return {
    lines: split.slice(0, maxLines),
    additions,
    deletions,
    hiddenLines: Math.max(0, split.length - maxLines),
  };
}
