/**
 * Screen-reader mode: ink serializes the tree to plain linear text (no
 * borders, no colors), keeps `<Static>` append-only, and rewrites the dynamic
 * region only when it changes. Enabled by the `--screen-reader` flag or the
 * CHANTIER_SCREEN_READER=1 environment alias.
 */
export function resolveScreenReader(flag: boolean | undefined, env: string | undefined): boolean {
  return flag === true || env === "1";
}
