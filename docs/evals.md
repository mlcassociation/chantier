# Evals — the $0 CI ladder

Chantier's eval strategy is a three-rung ladder. Rung 1 and 2 run in CI at $0:
they are deterministic and need no model. Rung 3 is opt-in and manual: it spends
tokens against a configured provider and is never wired into CI.

## Rung 1 — permission-engine fuzz (always on)

Property tests over `createPermissionEngine` with a seeded, deterministic
generator (inline LCG, no dependency). 500 random rule sets × 4 random
(tool, specifier, readOnly) queries per invariant:

- **Deny-first by construction**: a second engine built from only the deny
  rules of the same set detects a deny match; whenever it matches, the full
  engine must return `deny` regardless of any ask/allow rules.
- **Allow never beats deny** on the same construction.
- **First-match stability**: identical rules in identical order decide
  identically — across engine rebuilds and repeated calls (pure function).
- **Silence never approves**: with no matching rules, a readOnly tool is
  `allow`, a mutating tool is `ask` (the engine's real default ladder, probed
  via single-list engines that make matches unambiguous).

Run:

```sh
npx vitest run packages/permissions/tests/engine.fuzz.test.ts
```

## Rung 2 — scripted behavioral scenarios (always on)

`packages/core/tests/eval-scenarios.test.ts` drives `runAgent` with the
scripted adapter from `packages/core/tests/helpers/scripted.ts` and asserts
tool-call sequences and observable result contracts — never model prose:

1. An engine-denied mutation comes back as a denial result and the model
   finishes with a text-only turn (no further calls).
2. An `ask` decision approved by the sink executes the mutation.
3. An `ask` decision rejected by the sink returns the approval-denied content
   including the headless hint.
4. Read-only batching: two read calls run to completion before a mutating call
   starts (handler-entry log order proves it).
5. `maxTurns: 1` on a tool-calling model stops with `stopReason: "max_turns"`
   and returns the last turn's text.
6. A context-overflow stream error recovers once via reactive compaction: one
   compaction event, the retried turn succeeds, the tool call does not rerun.

Run:

```sh
npx vitest run packages/core/tests/eval-scenarios.test.ts
```

## Rung 3 — live-model scenarios (opt-in, manual)

Rung 3 replays the same scenario shape against a configured provider: the
assertions stay on tool sequences and result contracts, so a model that
hallucinates different prose still passes and a model that calls tools in the
wrong order fails. Not wired into CI — it costs tokens and needs keys.

Manual recipe (no committed file today):

1. Configure a provider in `~/.chantier/config.json` (or export the provider's
   API key) and pick a model id, e.g. `ollama/glm-5.3-flash:cloud`.
2. Write a throwaway script (not committed) that builds a `ModelAdapter` via
   `@chantier/providers`' `resolveAdapter`, then runs the same
   `runAgent` scenarios as Rung 2 with a real `createSessionStore` and the
   real tool set from `buildTools()`.
3. Assert the same observable contracts: tool-name sequences, stop reasons,
   denial/approval content markers. Never assert prose.

If a committed live file is ever added (`packages/core/tests/eval-live.test.ts`),
guard it so it skips without an explicit opt-in:

```ts
const describeLive = describe.skipIf(!process.env.CHANTIER_EVAL_LIVE);
// run: CHANTIER_EVAL_LIVE=1 npx vitest run packages/core/tests/eval-live.test.ts
```

Rung 1+2 always-on coverage keeps CI honest at $0; Rung 3 is the owner's
periodic live check.