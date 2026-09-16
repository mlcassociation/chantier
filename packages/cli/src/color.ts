import chalk from "chalk";

/**
 * Disables ANSI styling process-wide by zeroing the shared chalk level (the
 * same singleton ink's colorize and border renderers use). Needed explicitly
 * because chalk 5.6.2's vendored supports-color honors --no-color argv and
 * FORCE_COLOR but NOT the NO_COLOR environment variable.
 */
export function disableColors(
  noColorFlag: boolean | undefined,
  noColorEnv: string | undefined,
): void {
  if (noColorFlag === true || (noColorEnv ?? "") !== "") chalk.level = 0;
}
