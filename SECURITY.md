# Security Policy

## Reporting a vulnerability

**Do not open a public issue for a security report.**

Use GitHub's **Private vulnerability reporting** on this repository
(Security tab → Report a vulnerability). If that is unavailable to you, contact a
maintainer through a private channel (e.g. a GitHub message to the org owner) and
mark it as a security disclosure.

We aim to acknowledge within 7 days and to ship a fix for confirmed issues in the
next regular release.

## Supported versions

| Version | Supported |
|---|---|
| 0.6.x | yes |
| < 0.6 | no — upgrade; releases are small and frequent |

## Scope notes for reporters

- **The permission rule system is not a sandbox.** Rules (`deny`/`ask`/`allow`) are
  a consent UX for the operator; the approval prompt is the real gate. Bash-specifier
  rules are explicitly documented as convenience, not a security boundary. Reports
  about model-authored commands evading *text* rules are best written up as doc
  improvements; reports about the *engine* ignoring a matching deny rule are a bug.
- In scope: permission engine precedence bugs, approval-prompt bypasses, tools
  executing without a sink decision, auth key storage (`~/.chantier/auth.json`, 0600),
  MCP trust gate behavior, headless `--yolo` semantics.
- Out of scope: your own `--yolo` usage, sandboxing chantier does not yet provide
  (OS-level isolation is on the roadmap), model output quality.

## Hardening tips for operators

- Keep deny rules for the files you never want touched (`.env`, `secrets/**`).
- Prefer not running chantier with `--yolo` in directories containing credentials.
- chantier does not yet ship OS-level sandboxing; for hostile workspaces, run it in
  a container or throwaway VM.