/**
 * The package's canonical object guard (no shared type-guard module exists
 * in this package; keep exactly one definition here and import it).
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
