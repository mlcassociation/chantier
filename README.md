# chantier

[![npm](https://img.shields.io/npm/v/chantier)](https://www.npmjs.com/package/chantier)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22-green)](https://nodejs.org)
[![ci](https://github.com/mlcassociation/chantier/actions/workflows/ci.yml/badge.svg)](https://github.com/mlcassociation/chantier/actions/workflows/ci.yml)

The readable open-source coding agent. A terminal harness that turns a model into a
coding agent: a small loop, eight built-in tools, and a deny-first permission ladder —
no locked-in provider, no magic, nothing mutating your files without an approval.

[![chantier demo](docs/demo.gif)](demos/README.md)

Built around three commitments:

- **Readable.** Sessions are plain JSONL you can open with `jq`. The whole harness is
  ~9k lines of strict TypeScript in seven small packages; you can read the core loop
  end-to-end in an afternoon.
- **Consent-first.** Every mutation — file write, edit, shell command — asks first.
  Deny rules always win; allow rules can never punch through a deny. The model never
  sees the rules, only the outcomes.
- **Provider-agnostic.** Anthropic and any OpenAI-compatible endpoint (Ollama, vLLM,
  llama.cpp, LM Studio) out of the box; one adapter seam if you want more.

## Quickstart

```sh
npm install -g chantier
cd your-project
chantier
```

That drops you into the terminal UI. Type a task; the agent works; mutations ask
before they touch anything.

Headless, for scripts and CI:

```sh
chantier -p "Run the test suite and summarize failures"
```

Common flags: `-p` headless one-shot · `--continue` resume the latest session ·
`--model` override · `--max-turns N` · `--screen-reader` · `--no-color` ·
`--yolo` (headless auto-approve — think before you use it).

## Providers

```sh
chantier auth login anthropic   # stores the key in ~/.chantier/auth.json, chmod 0600
```

or point chantier at anything OpenAI-compatible in `~/.chantier/config.json`:

```json
{
  "provider": "ollama",
  "ollama": {
    "baseUrl": "http://127.0.0.1:11434/v1",
    "model": "glm-5.3-flash:cloud"
  }
}
```

Copy [`examples/config.json`](examples/config.json) to start. Environment variables
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) also work. The OpenAI-compatible adapter sends
`Authorization: Bearer ollama` by default because some compatible servers reject an
empty key — Ollama ignores the header; change it in config if a strict server objects.

## The permission ladder

Rules live in `~/.chantier/settings.json` and/or a project `.chantier/settings.json`
(project arrays replace home arrays). Three lists, one engine:

```json
{
  "deny": ["write(.env)", "write(.env.*)", "bash(rm *)"],
  "ask": ["write(dist/**)", "bash(npm run *)"],
  "allow": ["read", "glob", "grep"]
}
```

- Precedence is **deny → ask → allow, first match wins**. A deny is final.
- `*` matches within one path segment, `**` crosses segments; an under-matching rule
  fails safe (falls to the default decision): read-only tools run; mutations ask.
- Headless `chantier -p` refuses mutations unless an allow rule covers them or you
  pass `--yolo`.
- Subagents inherit your rules verbatim. "Always allow" grants you accept in the TUI
  never cross into a child session.

## What's inside

- **Eight tools** — `read` `write` `edit` `bash` `glob` `grep` `webfetch` `task` —
  each with token-capped, model-facing output and corrective error prose instead of
  stack traces.
- **Subagents.** `task` delegates a self-contained subtask to a fresh child session
  that re-enters the same loop. Only the child's final summary returns (capped at
  50 KiB); children cannot spawn children.
- **Compaction.** Context management is a derived view over the append-only session
  log: `/compact` on demand, automatic near the model's window, reactive fallback on
  provider overflow. The session file is never rewritten.
- **Skills** ([agentskills.io](https://agentskills.io) shape). Drop a `SKILL.md` in
  `~/.chantier/skills/` or `.chantier/skills/` and it appears as `/name` — the system
  prompt carries only name + description until you invoke it. Project skills require
  a one-time trust approval.
- **MCP** client. `.mcp.json` servers join the toolkit as `mcp__<server>__<tool>`
  behind the same ladder, stdio and streamable-HTTP transports, dead servers fail
  soft instead of ending your session (headless needs `--trust-mcp`).
- **Sessions.** JSONL under `~/.chantier/sessions/`, replayable, forkable,
  `jq`-inspecting:

  ```sh
  jq -r 'select(.type=="tool_use") | .name' ~/.chantier/sessions/<id>.jsonl | sort | uniq -c
  ```

- **Slash commands.** `/help` lists the registry; `/compact` condenses context; a
  fuzzy `/` palette completes commands and `@` picks project files.

## Accessibility

`chantier --screen-reader` renders a flat, labeled, border-free transcript optimized
for screen readers (also `--no-color`, `NO_COLOR`, and an ASCII fallback mode). The
headless `-p` mode is a full plain-text alternative.

## Documentation

- [Design rationale](docs/design.md) — why chantier is built this way, with sources.
- [Evals](docs/evals.md) — the CI eval ladder: property tests, scripted behavioral
  scenarios, opt-in live-model recipes.
- [Benchmarks](docs/BENCHMARKS.md) — the reproducible live-model task table
  (solve rate, tokens per task, failure taxonomy).
- [Roadmap](ROADMAP.md) — what shipped through v0.6.0 and what's next.
- [Contributing](CONTRIBUTING.md) — dev setup, gates, DCO.
- [Security](SECURITY.md) — how to report vulnerabilities privately.

## Status

v0.6.0 (2026-09-18). Releases are small and regular; every npm package publishes
version-locked in dependency order from a GitHub Actions OIDC trusted publish. See
[CHANGELOG.md](CHANGELOG.md).

## Development

```sh
npm install
npm run build
npm test            # vitest
npm run typecheck   # tsc, every package
npm run lint        # biome
```

Node >= 22. ESM only. Contributions need a DCO sign-off (`git commit -s`) — see
[CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Apache-2.0](LICENSE) — Copyright 2026 DASHLEA × MLC.