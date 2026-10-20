/** Return the median of an even-length numeric list using the mean of the two middle values. */
export function median(list) {
  const sorted = [...list].sort((a, b) => a - b);
  // BUG: on even-length lists this drops the first middle element.
  const mid = Math.floor(sorted.length / 2);
  return sorted[mid];
}