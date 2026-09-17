import type { PermissionRules } from "@chantier/permissions";
import { createPermissionEngine } from "@chantier/permissions";
import { describe, expect, it } from "vitest";

/**
 * Deterministic inline LCG: no dependency, and a failing iteration is
 * reproducible from the seed printed in the assertion message.
 */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const TOOLS = ["read", "write", "edit", "bash", "grep", "task"];
const SPECIFIERS = ["src/a.ts", "src/deep/b.ts", "test/a.test.ts", "README.md", "docs/", "x"];
// Includes wildcard shapes the pattern semantics document explicitly:
// single-segment *, cross-segment **, **/ zero-segment, ?, and literal brackets.
const PATTERNS = ["*", "**", "src/*", "src/**", "src/**/*", "**/*.ts", "*.ts", "ed?t", "[a-z]"];
const ITERATIONS = 500;
const QUERIES_PER_SET = 4;

function pick(rand: () => number, list: readonly string[]): string {
  return list[Math.floor(rand() * list.length)] ?? "*";
}

function randomRules(rand: () => number): PermissionRules {
  const rules: PermissionRules = {};
  for (const list of ["deny", "ask", "allow"] as const) {
    if (rand() < 0.7) {
      rules[list] = Array.from({ length: 1 + Math.floor(rand() * 3) }, () => {
        const tool = pick(rand, TOOLS);
        return rand() < 0.5 ? `${tool}(${pick(rand, PATTERNS)})` : tool;
      });
    }
  }
  return rules;
}

interface Query {
  tool: string;
  specifier?: string;
  readOnly: boolean;
}

function randomQuery(rand: () => number): Query {
  const tool = pick(rand, TOOLS);
  const specifier = rand() < 0.7 ? pick(rand, SPECIFIERS) : undefined;
  return { tool, specifier, readOnly: rand() < 0.5 };
}

// Per-iteration rule sources the single-list probe engines read. Module scope
// only avoids re-threading them through every helper; each test sets them
// before probing.
let DENY_ONLY_SOURCE: string[] = [];
let ASK_ONLY_SOURCE: string[] = [];
let ALLOW_ONLY_SOURCE: string[] = [];

/**
 * Rule matching is readOnly-independent, so probing each single-list engine
 * with the readOnly flag that makes silence loudest disambiguates "matched"
 * from "fell through to the default": deny-only and ask-only engines return
 * their default (allow) when nothing matches under a readOnly probe, so
 * "deny"/"ask" there means a real match; allow-only probed non-readOnly has
 * default "ask", so "allow" is unambiguous.
 */
function probeDecisions(query: Query): { deny: boolean; ask: boolean; allow: boolean } {
  return {
    deny:
      createPermissionEngine({ deny: DENY_ONLY_SOURCE }).evaluate(
        query.tool,
        query.specifier,
        true,
      ) === "deny",
    ask:
      createPermissionEngine({ ask: ASK_ONLY_SOURCE }).evaluate(query.tool, query.specifier, true) ===
      "ask",
    allow:
      createPermissionEngine({ allow: ALLOW_ONLY_SOURCE }).evaluate(
        query.tool,
        query.specifier,
        false,
      ) === "allow",
  };
}

/** The engine's documented ladder: deny → ask → allow, then the default. */
function expectedDecision(query: Query, probe: { deny: boolean; ask: boolean; allow: boolean }) {
  if (probe.deny) return "deny";
  if (probe.ask) return "ask";
  if (probe.allow) return "allow";
  return query.readOnly ? "allow" : "ask";
}

describe("permission engine fuzz (seeded, deterministic)", () => {
  it("deny-first: whenever any deny rule matches the call, the engine denies regardless of ask/allow rules", () => {
    for (let seed = 1; seed <= ITERATIONS; seed += 1) {
      const rand = seededRandom(seed);
      const rules = randomRules(rand);
      DENY_ONLY_SOURCE = rules.deny ?? [];
      const engine = createPermissionEngine(rules);
      const denyOnly = createPermissionEngine({ deny: DENY_ONLY_SOURCE });
      for (let q = 0; q < QUERIES_PER_SET; q += 1) {
        const query = randomQuery(rand);
        if (denyOnly.evaluate(query.tool, query.specifier, true) === "deny") {
          expect(
            engine.evaluate(query.tool, query.specifier, query.readOnly),
            `seed ${seed} rules ${JSON.stringify(rules)} query ${JSON.stringify(query)}`,
          ).toBe("deny");
        }
      }
    }
  });

  it("allow never beats deny on the same rule set", () => {
    for (let seed = 1; seed <= ITERATIONS; seed += 1) {
      const rand = seededRandom(seed + 10_000);
      const rules = randomRules(rand);
      DENY_ONLY_SOURCE = rules.deny ?? [];
      const engine = createPermissionEngine(rules);
      const denyOnly = createPermissionEngine({ deny: DENY_ONLY_SOURCE });
      for (let q = 0; q < QUERIES_PER_SET; q += 1) {
        const query = randomQuery(rand);
        const decision = engine.evaluate(query.tool, query.specifier, query.readOnly);
        if (denyOnly.evaluate(query.tool, query.specifier, true) === "deny") {
          expect(decision, `seed ${seed}`).toBe("deny");
        } else {
          expect(decision).not.toBe("deny");
        }
      }
    }
  });

  it("first-match stability: identical rules in identical order always decide identically", () => {
    for (let seed = 1; seed <= ITERATIONS; seed += 1) {
      const rand = seededRandom(seed + 20_000);
      const rules = randomRules(rand);
      const engineA = createPermissionEngine(rules);
      const engineB = createPermissionEngine(structuredClone(rules));
      for (let q = 0; q < QUERIES_PER_SET; q += 1) {
        const query = randomQuery(rand);
        const first = engineA.evaluate(query.tool, query.specifier, query.readOnly);
        expect(first).toBe(engineA.evaluate(query.tool, query.specifier, query.readOnly));
        expect(first, `seed ${seed} query ${JSON.stringify(query)}`).toBe(
          engineB.evaluate(query.tool, query.specifier, query.readOnly),
        );
      }
    }
  });

  it("silence never approves: no matching rules → readOnly allowed, mutations ask", () => {
    const silent = createPermissionEngine({});
    expect(silent.evaluate("read", "src/a.ts", true)).toBe("allow");
    expect(silent.evaluate("write", "src/a.ts", false)).toBe("ask");

    // Full-ladder oracle: the full engine agrees with the decision built from
    // three single-list probe engines plus the documented default.
    for (let seed = 1; seed <= ITERATIONS; seed += 1) {
      const rand = seededRandom(seed + 30_000);
      const rules = randomRules(rand);
      DENY_ONLY_SOURCE = rules.deny ?? [];
      ASK_ONLY_SOURCE = rules.ask ?? [];
      ALLOW_ONLY_SOURCE = rules.allow ?? [];
      const engine = createPermissionEngine(rules);
      for (let q = 0; q < QUERIES_PER_SET; q += 1) {
        const query = randomQuery(rand);
        expect(
          engine.evaluate(query.tool, query.specifier, query.readOnly),
          `seed ${seed} rules ${JSON.stringify(rules)} query ${JSON.stringify(query)}`,
        ).toBe(expectedDecision(query, probeDecisions(query)));
      }
    }
  });
});