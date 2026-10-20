#!/usr/bin/env bash
# bench/run.sh — reproducible live-model task benchmark ($0 on local models).
# Each run: fresh fixture copy -> chantier -p <task> --yolo -> whole suite must pass.
# Usage: SEEDS=3 MODEL_TAIL=... demos/bench/run.sh   (from repo root or anywhere)
set -u
SEEDS=${SEEDS:-3}
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CLI="$REPO_ROOT/packages/cli/dist/index.mjs"
BENCH_HOME=${BENCH_HOME:-/tmp/chantier-bench-home}
WORK=${WORK:-/tmp/chantier-bench-run}
OUT=${OUT:-/tmp/chantier-bench-results.tsv}
MAXTURNS=${MAXTURNS:-8}

mkdir -p "$BENCH_HOME/.chantier"
cat > "$BENCH_HOME/.chantier/config.json" <<EOF
{
  "provider": "ollama",
  "ollama": { "baseUrl": "http://127.0.0.1:11434/v1", "model": "glm-5.3-flash:cloud" }
}
EOF

declare -A PROMPTS
PROMPTS[fix-off-by-one]="The median() implementation is wrong for even-length lists and the test suite has a failing test. Fix src/median.js so the whole suite passes. Verify by running the test suite."
PROMPTS[implement-parseiso]="Implement parseIso in src/parse-iso.js exactly as the spec in the file comments describes, until the whole test suite passes. Verify by running the test suite."
PROMPTS[rename-refactor]="Rename fetchData to loadData in src/lib.js and update every importer, so the currently failing import test passes. Verify by running the test suite."
PROMPTS[fix-slugify]="slugify() does not match its docstring and its tests fail. Fix src/slugify.js so the whole suite passes. Verify by running the test suite."

TASKS="fix-off-by-one implement-parseiso rename-refactor fix-slugify"
echo -e "task\tseed\tverdict\tturns\ttok_in\ttok_out\twall_s" > "$OUT"

for task in $TASKS; do
  for seed in $(seq 1 "$SEEDS"); do
    run_dir="$WORK/$task-seed$seed"
    mkdir -p "$WORK"
    rm -r "$run_dir" 2>/dev/null || true
    cp -r "$REPO_ROOT/demos/bench/$task" "$run_dir"
    t0=$(date +%s%N)
    summary=$(cd "$run_dir" && HOME="$BENCH_HOME" "$CLI" -p "${PROMPTS[$task]}" --yolo --max-turns "$MAXTURNS" 2>&1 | tail -1)
    t1=$(date +%s%N)
    wall=$(( (t1 - t0) / 1000000 / 100 ))
    if (cd "$run_dir" && node --test >/dev/null 2>&1); then verdict=pass; else verdict=fail; fi
    turns=$(printf '%s' "$summary" | grep -oE '[0-9]+ turns' | grep -oE '[0-9]+')
    tok_in=$(printf '%s' "$summary" | grep -oE '[0-9]+ in' | grep -oE '[0-9]+')
    tok_out=$(printf '%s' "$summary" | grep -oE '[0-9]+ out' | grep -oE '[0-9]+')
    echo -e "$task\t$seed\t$verdict\t${turns:-?}\t${tok_in:-?}\t${tok_out:-?}\t$wall" | tee -a "$OUT"
  done
done
echo "results at $OUT"