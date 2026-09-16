# chantier

The readable open-source coding agent. A terminal harness that turns a model into
a coding agent: a loop, seven tools, and a deny-first permission ladder — no
locked-in provider, no magic.

- **Providers pluggable.** Runs against any OpenAI-compatible endpoint (Ollama,
  vLLM, …) and Anthropic out of the box; the `ModelAdapter` seam in
  `packages/core` is the only place a provider SDK is imported.
- **Approval on every mutation by default.** File writes, edits, and shell
  commands ask first. In headless mode they are refused with an actionable
  message unless you pass `--yolo` or add an allow rule to
  `.chantier/settings.json`. Deny rules always win; allow can never punch
  through a deny.
- **Sessions are plain JSONL** under `~/.chantier/sessions/`, replayable and
  inspectable with `jq`.

## Status

v0.1 — headless core; TUI coming.

## Install from source

```sh
npm install
npm run build
```

Requires Node ≥ 22.

## Headless example

```sh
export CHANTIER_ANTHROPIC_API_KEY=sk-ant-…   # or use Ollama (see below)
node packages/cli/dist/index.mjs -p "Create hello.txt containing exactly: hi chantier"
```

Against a local Ollama (the checked-in `examples/config.json` assumes one):

```sh
mkdir -p ~/.chantier && cp examples/config.json ~/.chantier/config.json
node packages/cli/dist/index.mjs -p "Create hello.txt containing exactly: hi chantier" --yolo
```

## Notes for local development

Ollama speaks OpenAI-compatible HTTP; the adapter sends `Authorization: Bearer ollama`
because OpenAI-compatible clients reject an empty key. Ollama ignores the header.
Point `ollama.baseUrl` at any OpenAI-compatible server (vLLM, llama.cpp, LM Studio)
to use it the same way.

## Design rationale

The full research dossier behind these choices lives at
[`docs/research/research-dossier.md`](docs/research/research-dossier.md).

## License

[Apache-2.0](LICENSE) — Copyright 2026 DASHLEA × MLC.