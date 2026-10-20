export function wordcount(text, { unique = false } = {}) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (!unique) return words.length;
  throw new Error("not implemented yet");
}
