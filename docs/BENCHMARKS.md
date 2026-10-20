# Benchmarks

Small, reproducible, honest. Four toy tasks (each a broken fixture with a
failing `node --test` suite: an off-by-one, an unimplemented spec, a two-file
rename, a docstring-vs-code fix) run three seeds each, headless, fresh
fixture and fresh session per seed. A run **solves** when the fixture's whole
suite passes afterwards. Fixture + runner live in
[`demos/bench/`](../demos/bench) — run it yourself:

```sh
SEEDS=3 bash demos/bench/run.sh
```

This is NOT SWE-bench; it is the cheap end of the aider-style ladder: a model
and prompt-version fingerprint that a release can move or regress, published
with the numbers instead of adjectives. Full-run SWE-bench-style evaluation
cost real money per model and lives outside this repo's CI by design (see
[evals.md](evals.md)).

## Run: 2026-10-20 · chantier 37cfdc3 · glm-5.3-flash:cloud via Ollama

Model id `glm-5.3-flash:cloud` (Ollama serving the OpenAI-compatible API at
`127.0.0.1:11434/v1`); prompt = v0.6 default system composer, glm profile;
`--max-turns 8`; every mutation auto-approved for the benchmark run
(the fixtures are throwaway copies in `/tmp`).

| task | seeds | solved | turns (min–max) | tokens in | tokens out | wall (s) |
|---|---|---|---|---|---|---|
| fix-off-by-one | 3 | 3/3 | 5–6 | 3077–3255 | 59–72 | 30–35 |
| implement-parseiso | 3 | 3/3 | 6–8 | 3517–3851 | 85–122 | 58–132 |
| rename-refactor | 3 | 2/3 | 8–8 | 3292–3789 | 16–240 | 43–78 |
| fix-slugify | 3 | 3/3 | 5–8 | 3212–4305 | 77–141 | 47–103 |
| **overall** | **12** | **11 (91.7%)** | median 6 | median 3423 | median 87 | median 47 |

Failure taxonomy (one failure): `rename-refactor` seed 2 hit `max-turns 8`
mid edit-test loop and returned without a final answer — the loop-churn class,
not a crash. Its passing seeds needed the re-export insight (`usage.js` must
re-export the renamed symbol).

## What this measures (and what it doesn't)

- Measures: end-task solve rate on a cheap cloud model, tokens per solved
  task, turns, the failure category. The harness is the variable under test —
  same prompt, same fixture, same gates.
- Doesn't measure: large-repo navigation (fixtures are ~5 files), model
  quality differences (one model), real-world token spend on 500-file repos.
- Wall time is model latency through a local single-tenant endpoint and
  carries no significance beyond "cloud-flavored model".

## History

Re-runs append here with date + commit + model. The table above is the
baseline; if a release regresses the solve rate or the per-task medians by a
visible margin, that's a release-notes fact, not a secret.