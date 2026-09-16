# Changelog

## 0.3.0 — 2026-09-16

First npmjs.com release. All packages publish at 0.3.0: `chantier` (CLI) and
`@chantier/core`, `@chantier/permissions`, `@chantier/providers`,
`@chantier/tools`, `@chantier/tui`.

### Interactive TUI

- Approval card with inline diff previews before every mutation.
- Remembered grants: "always allow" persists for the session.
- Exit codes: 0 on success, 130 on Ctrl-C interrupt.

### Accessibility

- Screen-reader mode for non-visual terminals.
- Labeled lines for assistive navigation.
- NO_COLOR respected; ASCII fallback replaces box-drawing glyphs.

### Compaction

- Compaction is a derived view over the append-only JSONL session log; the
  session file is never rewritten.
- `/compact` command, an automatic trigger near the context window, and a
  reactive fallback when a provider call fails mid-turn.
- `includeUsage` is requested from providers that support it so token
  accounting stays exact (Ollama needs it).

### Auth

- `chantier auth login`, `chantier auth status`, and `chantier auth logout`.
- API keys are stored with 0600 permissions; environment variables still work
  as a fallback.

### Tools

- grep: output modes and pagination, plus guidance in the no-match case.
- read: continuation notices when output is truncated.
- bash: output spills to a file past the size cap; working-directory control.
- edit: CRLF handling and a diff channel for reviewing changes.