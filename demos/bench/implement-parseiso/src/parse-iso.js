// ISO date parser. Spec: accept "YYYY-MM-DD" and "YYYY/MM/DD", return a
// { year, month, day } object with integer parts, or null for anything else.
// Note: "2026-02-30" (impossible date) must also return null — validate the
// resulting Date round-trips (month is 0-indexed for Date, not for output).
export function parseIso(input) {
  throw new Error("not implemented yet");
}