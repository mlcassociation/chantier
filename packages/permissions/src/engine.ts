// No runtime dependencies: rule patterns compile to RegExp locally.

export type Decision = "allow" | "ask" | "deny";

export interface ApprovalRequest {
  tool: string;
  input: unknown;
  /** Optional human/model-facing context for the approval prompt. */
  reason?: string;
}

export type ApprovalDecision = {
  approved: boolean;
  /** Model-facing reason included in the denial feedback when not approved. */
  reason?: string;
  /**
   * Sink-to-owner hint: remember this tool for the rest of the session so
   * later `ask` verdicts for it are short-circuited to allow. Purely a
   * convention between sinks and their owners; the engine itself never reads it.
   */
  remember?: boolean;
};

/**
 * The only path a mutation is allowed through. Silence never approves: an
 * implementation may resolve `{ approved: false }`, never implicitly `true`.
 */
export interface ApprovalSink {
  ask(req: ApprovalRequest): Promise<ApprovalDecision>;
}

export interface PermissionRules {
  allow?: string[];
  ask?: string[];
  deny?: string[];
}

export interface PermissionEngine {
  /**
   * Deny → ask → allow, first match wins; allow can never override deny.
   * No rule matched: `readOnly` tools are allowed, mutating tools ask.
   */
  evaluate(toolName: string, specifier?: string, readOnly?: boolean): Decision;
  /** True when a bare-name deny removes the tool from the model's toolset. */
  isRemoved(toolName: string): boolean;
}

interface ParsedRule {
  list: Exclude<keyof PermissionRules, undefined>;
  tool: string;
  /** undefined = bare rule, matches every call to the tool. */
  specifier?: string;
}

const RULE_PATTERN = /^([A-Za-z0-9_-]+)(?:\((.*)\))?$/;

function parseRules(rules: PermissionRules): ParsedRule[] {
  const parsed: ParsedRule[] = [];
  for (const list of ["deny", "ask", "allow"] as const) {
    for (const raw of rules[list] ?? []) {
      const match = RULE_PATTERN.exec(raw);
      if (!match) {
        throw new Error(
          `Invalid permission rule "${raw}". Expected "Tool" or "Tool(specifier)" with optional * wildcards.`,
        );
      }
      const tool = match[1] as string;
      const specifier = match[2];
      parsed.push({ list, tool, specifier });
    }
  }
  return parsed;
}

/**
 * Rule/specifier wildcard semantics (uniform for tools and specifiers):
 * - `*` matches within one path segment (never crosses a slash)
 * - `**` matches across segments
 * - `**` immediately before a slash also matches zero segments
 * - `?` matches one non-separator character
 * - bracket `[a-z]` and brace `{ts,tsx}` expressions are matched LITERALLY;
 *   only the tokens above are wildcards
 *
 * A rule that does not match under-matches fail-safe: evaluation falls through
 * to the default decision (allow for readOnly tools, ask for mutations), never
 * to a wider grant than the rule intended.
 */
const patternCache = new Map<string, RegExp>();

function patternToRegExp(pattern: string): RegExp {
  let compiled = patternCache.get(pattern);
  if (compiled === undefined) {
    // Single pass with multi-char tokens first: sequential replaces would
    // rescan their own output ("**" expanded to ".*" has a star that the
    // single-star pass would rewrite again).
    const source = pattern.replace(/\*\*\/|(\*\*)|(\*)|(\?)|[.+^${}()|[\]\\]/g, (token) => {
      switch (token) {
        case "**/":
          return "(?:.*/)?";
        case "**":
          return ".*";
        case "*":
          return "[^/]*";
        case "?":
          return "[^/]";
        default:
          return `\\${token}`;
      }
    });
    compiled = new RegExp(`^${source}$`);
    patternCache.set(pattern, compiled);
  }
  return compiled;
}

function wildcardMatch(pattern: string, value: string): boolean {
  return patternToRegExp(pattern).test(value);
}

export function createPermissionEngine(rules: PermissionRules): PermissionEngine {
  const parsed = parseRules(rules);

  const matches = (rule: ParsedRule, toolName: string, specifier?: string): boolean => {
    if (!wildcardMatch(rule.tool, toolName)) return false;
    if (rule.specifier === undefined) return true; // bare rule: any call to the tool
    if (specifier === undefined) return false;
    return wildcardMatch(rule.specifier, specifier);
  };

  return {
    evaluate(toolName, specifier, readOnly) {
      for (const rule of parsed) {
        if (matches(rule, toolName, specifier)) return rule.list;
      }
      return readOnly ? "allow" : "ask";
    },
    isRemoved(toolName) {
      return parsed.some(
        (rule) =>
          rule.list === "deny" &&
          rule.specifier === undefined &&
          wildcardMatch(rule.tool, toolName),
      );
    },
  };
}
