# Roadmap

chantier releases are small and regular; this is the honest map, not a promise.
Order can change with the terrain — the principles do not.

## Shipped

- **v0.3.0 (2026-09-16)** — headless core + interactive TUI: approval card with diff
  previews, remembered grants, deny-first ladder, screen-reader + ASCII modes,
  JSONL sessions, `/compact` + auto compaction, `chantier auth` flows, first npm release.
- **v0.5.0 (2026-09-18)** — reading + activity surfaces: markdown rendering with
  fence-safe streaming, visible tool results, subagent cards, footer gauge, message
  queueing, paste chips, persistent history, emacs editing.
- **v0.6.0 (2026-09-18)** — the extendable harness: skills (agentskills.io), MCP
  client, slash-command registry + fuzzy palette + `@` file picker, startup mark,
  activity ribbon, live todo trail, per-project MCP trust gate.

## Next

1. **Subagent orchestration** — parallel read-only child waves with per-wave and
   global token budgets; the orchestrator prompt that teaches the model *when* to
   delegate; artifact-passing by file reference instead of copied payloads.
2. **Writer isolation** — parallel mutating children with git worktree isolation and
   merge-back.
3. **Per-release transparency** — a small reproducible benchmark table per release
   (tokens per solved task, failure categories, model + prompt version) and
   "chantier wrote X% of this release" from its own session logs.
4. **Client/server split** — the session/state interface behind an HTTP server with
   disposable clients (TUI, IDE, CI share one session store).
5. **Repo map** — aider-style tree-sitter symbol index as a ~1k-token
   large-repo context hint.

## Deliberately not on the map

- Yolo by default. Approval-on-mutation is the product's spine.
- A permission system the model can see or negotiate. Rules stay harness-side.
- A provider count race. The `ModelAdapter` seam stays small; local/OpenAI-compatible
  and Anthropic stay the supported pair until a real ask appears.
- CLAs. DCO sign-off only.

## Non-goals, unchanged

No locked-in provider, no magic abstractions, no closed core. If a change makes the
repo harder to read in one sitting, it needs a better justification than novelty.