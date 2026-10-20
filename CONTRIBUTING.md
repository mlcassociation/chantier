# Contributing to chantier

Thanks for looking under the hood. chantier is built to be read — contributions
that keep it that way are the ones we want.

## Development setup

```sh
git clone git@github.com:mlcassociation/chantier.git
cd chantier
npm install
npm run build
npm test
```

Node >= 22. ESM only ("type": "module" everywhere); strict TypeScript, `noUncheckedIndexedAccess`
where it bites, no `any` unless a third-party boundary forces it (comment why).

## Layout

| Package | Owns |
|---|---|
| `packages/permissions` | allow/ask/deny engine, wildcards, remembered grants |
| `packages/core` | agent loop, session JSONL store, compaction, skills, commands, todo |
| `packages/providers` | ModelAdapter implementations (Anthropic, OpenAI-compatible) |
| `packages/tools` | the eight built-in tools |
| `packages/mcp` | MCP client + tool adapter |
| `packages/tui` | ink terminal UI |
| `packages/cli` | entry point, argv parsing, headless runner, config loading |

Cross-package imports go through `packages/core/src/types.ts` and
`packages/permissions/src/engine.ts` only.

## Gates (all must pass)

```sh
npm run typecheck   # tsc across all seven packages
npm run lint        # biome
npm test            # vitest, colocated *.test.ts
```

CI runs the same three on Node 22 and 24. Tests observe behavior, not plumbing:
assert what a user or a consuming package sees, not how the internals call each other.

## House rules

- **Permissions are enforced by the harness, never negotiated by the model.** A
  mutating tool must never execute without an allow decision or a granted ask.
- **Tool output is model-facing text**: prose, not stack traces. Errors a model can
  correct are corrective prose; errors a human must fix are one-line and thrown.
- **Read before writing code.** Conventions live in [AGENTS.md](AGENTS.md).
- No drive-by refactors; keep the diff the size of the problem.
- Never hardcode provider keys, internal hostnames, or absolute box paths.

## Submitting

1. Open or find an issue first — bug reports welcome, feature requests discussed.
2. Small PRs beat large ones; one concern per PR.
3. **DCO sign-off required** (`git commit -s`). Every commit must be certifiable
   that you have the right to submit it:

   ```
   Signed-off-by: Jane Doe <jane@example.com>
   ```

4. New behavior comes with a test that fails without it.

## Releases

Maintainer-side: version bumps move all seven packages in lockstep; a `v*` tag
push triggers GitHub Actions OIDC trusted publishing (no npm tokens) in dependency
order. Do not publish from a local machine.

## Conduct

See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Security

Please do not open public issues for security reports — see [SECURITY.md](SECURITY.md).