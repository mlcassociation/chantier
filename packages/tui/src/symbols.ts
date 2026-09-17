/**
 * Decorative characters and box borders used by the TUI. Screen readers skip
 * or garble ornamental unicode (arrows, checkmarks, middle dots), and border
 * glyphs pollute magnified review, so everything resolves to ASCII-safe
 * variants when ASCII mode is requested. All TUI call sites gate through
 * `resolveSymbols` so the fallback can never leak (gemini-cli #18298).
 */
export interface TuiSymbols {
  /** Box border style: "round" normally, "single" in ASCII mode. */
  readonly border: "round" | "single";
  /** Separator inside hint lines: "·" normally, "|" in ASCII mode. */
  readonly hintSeparator: string;
  /** Truncation ellipsis: "…" normally, "..." in ASCII mode. */
  readonly ellipsis: string;
  /**
   * Spinner animation frames (v0.5 status widget, spec §4a). Both variants
   * keep the same frame count so timing code is width-agnostic.
   */
  readonly spinnerFrames: readonly string[];
  /** Tool/task row bullet: "▸" normally, ">" in ASCII mode (§8 parity). */
  readonly runGlyph: string;
  /** Tree corner for detail and summary blocks: "└" normally, "+" in ASCII. */
  readonly subGlyph: string;
  /** Failed-tool glyph: "✗" normally, "x" in ASCII mode. */
  readonly errorGlyph: string;
  /** Divider rule cell: "─" normally, "-" in ASCII mode (§2d). */
  readonly rule: string;
  /** Context-bar cells: filled "▮" / empty "▯", ASCII "#" / "-" (§5). */
  readonly barFilled: string;
  readonly barEmpty: string;
  /** Forward arrow: "→" normally, "->" in ASCII mode (divider text, §2d). */
  readonly arrow: string;
  /** Recall hint arrow: "↑" normally, "^" in ASCII mode (queue preview §6d). */
  readonly arrowUp: string;
  /** Minus sign in diff counts: "−" normally, "-" in ASCII mode (§7). */
  readonly minus: string;
}

export const UNICODE_SYMBOLS: TuiSymbols = {
  border: "round",
  hintSeparator: "·",
  ellipsis: "…",
  spinnerFrames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
  runGlyph: "▸",
  subGlyph: "└",
  errorGlyph: "✗",
  rule: "─",
  barFilled: "▮",
  barEmpty: "▯",
  arrow: "→",
  arrowUp: "↑",
  minus: "−",
};

export const ASCII_SYMBOLS: TuiSymbols = {
  border: "single",
  hintSeparator: "|",
  ellipsis: "...",
  spinnerFrames: ["|", "/", "-", "\\"],
  runGlyph: ">",
  subGlyph: "+",
  errorGlyph: "x",
  rule: "-",
  barFilled: "#",
  barEmpty: "-",
  arrow: "->",
  arrowUp: "^",
  minus: "-",
};


export function resolveSymbols(ascii: boolean): TuiSymbols {
  return ascii ? ASCII_SYMBOLS : UNICODE_SYMBOLS;
}

/** CHANTIER_ASCII=1 requests the ASCII-safe rendering. */
export function isAsciiEnv(env: string | undefined): boolean {
  return env === "1";
}
