import type { PermissionEngine } from "./engine.ts";

/**
 * Wraps an engine with session-scoped "always allow" grants remembered from
 * sink decisions. A remembered bare allow lifts `ask` verdicts for that tool
 * to `allow` — including asks that came from explicit ask rules: an interactive
 * "always allow" is fresher, more explicit user intent than any settings rule.
 * Deny always wins first: the inner engine answers deny before the wrapper
 * consults its set, so a remembered grant can never bypass a deny rule.
 */
export interface RememberingEngine extends PermissionEngine {
  /** Remember a bare-tool allow for the rest of the session. */
  remember(tool: string): void;
  /** Tools remembered so far (bare names). */
  readonly remembered: readonly string[];
}

export function createRememberingEngine(inner: PermissionEngine): RememberingEngine {
  const allowSet = new Set<string>();
  return {
    remember(tool: string): void {
      allowSet.add(tool);
    },
    get remembered(): readonly string[] {
      return [...allowSet];
    },
    evaluate(toolName, specifier, readOnly) {
      const decision = inner.evaluate(toolName, specifier, readOnly);
      return decision === "ask" && allowSet.has(toolName) ? "allow" : decision;
    },
    isRemoved(toolName: string): boolean {
      return inner.isRemoved(toolName);
    },
  };
}
