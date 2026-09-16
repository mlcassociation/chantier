# Changelog

All notable changes are documented in the root
[CHANGELOG.md](../../CHANGELOG.md).

## 0.3.0 — 2026-09-16

- Compaction is a derived view over the append-only session log; callers drive
  `compactSession`, with `/compact`, an automatic trigger near the context
  window, and a reactive fallback.
- `includeUsage` is requested from providers so token accounting stays exact.

See the root changelog for the full list.