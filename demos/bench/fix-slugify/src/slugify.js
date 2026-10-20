/** Turn arbitrary text into a URL slug: lowercase, spaces → "-", keep
 * [a-z0-9-] only, collapse runs of separators to one dash, trim dashes. */
export function slugify(text) {
  // BUG: this passes uppercase and punctuation through unfixed.
  return String(text).trim().replace(/\s+/g, "-");
}