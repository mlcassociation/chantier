export function fetchData(url) {
  if (typeof url !== "string" || !url.startsWith("https://")) {
    throw new TypeError(`https URL required, got: ${String(url)}`);
  }
  // Deterministic fake transport so tests never touch the network.
  return { ok: true, url };
}