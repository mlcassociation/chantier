# Changelog

## 0.5.0 — 2026-09-18

### Reading surface

- Markdown rendering with a fence-safe streaming flush: finalized text renders
  styled (headers, lists, fenced code), and a half-open code fence is never
  committed mid-stream. Plain text skips the parser entirely.
- Tool results are now displayed: each tool call shows a 1–2 line output
  preview (previously the results were discarded).
- Compaction renders as an inline divider at its point in the transcript;
  the scrollback above it is untouched.

### Activity surface

- Per-tool rows with duration; task delegations render as a subagent card
  with the child's summary and its session id.
- A working indicator with spinner, elapsed clock, anti-jitter verb padding,
  and "esc to interrupt"; failures are never hidden even when detail is
  collapsed.

### Status surface

- Footer: model, context gauge (color thresholds 50/80/95% with a
  "compaction soon" warning sharing the real compaction math), token totals,
  and the session id — whole segments drop as the terminal narrows, never
  truncated mid-segment, and hidden entirely while an approval card is up.

### Input surface

- Queue messages while a run streams ("queued: … ↑ to edit"); the queue
  drains into the next task when the run settles, including right after an
  interrupt.
- Paste chips: large pastes collapse to `[pasted +N lines]` and submit in
  full; per-character paste storms are gone.
- Persistent command history (`~/.chantier/history.jsonl`, ↑/↓ recall) and
  emacs line editing (ctrl+a/e/b/f/k/u/w).
- Keyboard shortcuts route through named actions; ctrl-c is the only quit
  chord (a stray ctrl+key no longer exits), and escape no longer aborts an
  idle session. Two-stage ctrl-c guards against accidental exits mid-run.

### Fixes

- Streamed text finalizes at paragraph boundaries (previously a long
  text-only turn stayed in one live region; screen readers heard nothing
  until the run ended).
- The approval card shows a humanized header (path + change counts, command)
  instead of raw JSON.

## 0.4.0 — 2026-09-17

### Subagents

- The `task` tool delegates one self-contained subtask to a child agent run
  re-entering the same loop: same adapter, same permission rules, fresh
  session.
- Deny-first inheritance: the child's permission engine is built from the
  parent's rules verbatim; remembered grants never cross the boundary (a
  child starts with an empty remember set); denied child mutations surface in
  the parent's approval UI, never as auto-propagated approvals.
- Depth cap by construction: the child toolset is the builtin set and does
  not contain `task`, so children cannot spawn children.
- The child's final summary returns capped at 50 KiB; the full transcript
  lives in its own JSONL session file, referenced by session id.
- Ctrl-C aborts both parent and child promptly.

### System prompt composer

- The system prompt is now assembled from fixed sections in a fixed order:
  environment (cwd, date, git branch read from the filesystem), identity,
  doing-tasks discipline, permission-denial rule, tool catalog, tool usage
  rules, project AGENTS.md last.
- Model profiles: `glm-` and `claude-` model ids resolve family-specific
  identity guidance; other models get the default profile, byte-identical to
  the previous prompt.
- The CLI banner and `--version` derive from the package manifest, so the
  printed version can no longer drift from the published one.

### Eval ladder

- Rung 1: seeded property tests over the permission engine (deny-first
  precedence, allow-never-beats-deny, first-match stability, silence never
  approves) — always on in CI.
- Rung 2: behavioral scenarios over scripted tool-call sequences (denial
  handling, approval flow, read-only batching, max-turns, reactive
  compaction) — always on in CI, no live model calls.
- Rung 3: opt-in live-model recipes documented in `docs/evals.md`; never
  wired into CI.

### Release engineering

- Trusted publishing: `publish.yml` publishes all six packages on a `v*` tag
  push via GitHub Actions OIDC — no npm tokens, with provenance, gated on
  typecheck, lint, tests, and build in dependency order.

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