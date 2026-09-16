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
}

export const UNICODE_SYMBOLS: TuiSymbols = {
  border: "round",
  hintSeparator: "·",
  ellipsis: "…",
};

export const ASCII_SYMBOLS: TuiSymbols = {
  border: "single",
  hintSeparator: "|",
  ellipsis: "...",
};

export function resolveSymbols(ascii: boolean): TuiSymbols {
  return ascii ? ASCII_SYMBOLS : UNICODE_SYMBOLS;
}

/** CHANTIER_ASCII=1 requests the ASCII-safe rendering. */
export function isAsciiEnv(env: string | undefined): boolean {
  return env === "1";
}
