# AGENTS.md — chantier repo conventions

- ESM only. No CommonJS, no `require`. `"type": "module"` everywhere.
- Strict TypeScript. No `any` unless a third-party boundary forces it; comment why.
- Tool output is model-facing text: prose, not stack traces. Errors that a model
  can correct (missing file, ambiguous edit) are corrective prose; errors a human
  must fix are one-line actionable messages thrown to the harness.
- Permissions are enforced by the harness, never negotiated by the model. The
  model never sees the permission rules; it sees only allow/deny outcomes.
- Every mutation goes through the approval sink. A mutating tool must never
  execute without an `allow` decision or a granted `ask`.
- Cross-package imports go through the exported interfaces in
  `packages/core/src/types.ts` and `packages/permissions/src/engine.ts` only.
- Permission rule wildcards: `*` matches within one path segment (never crosses
  `/`), `**` crosses segments, `**/` also matches zero segments. A rule that
  under-matches fails safe (falls to the default allow/ask decision); it never
  widens a grant. Bash-specifier rules are convenience, not a security boundary.
- Tests: vitest, colocated `*.test.ts`. Test observable behavior, not plumbing.
- Never use the model name `kimi-k3` anywhere (tests, docs, examples).