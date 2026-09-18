/**
 * Frozen v0.6.0 contract (spec /home/debian/portfolio/chantier/v06-spec.md
 * §Theme 3): the slash-command registry. Types only — Worker CoreExt
 * implements the registry and dispatch; the TUI consumes `list()` for the
 * palette. `/compact` semantics are preserved exactly (trimmed exact match
 * dispatches; a slash-word that is not a registered command goes to the
 * agent as a normal task).
 */

/** A registered slash command. `name` excludes the leading slash. */
export interface CommandSpec {
  /** `[a-z0-9-]+` — the palette matches this string after `/`. */
  readonly name: string;
  /** One-line description shown in the palette and /help. */
  readonly description: string;
  /**
   * "action" performs work itself (e.g. /compact); "expand" rewrites the
   * task text (e.g. a skill fills the editor / injects its body).
   */
  readonly kind: "action" | "expand";
}

/** Registry surface the TUI palette relies on (implementation in core). */
export interface CommandRegistry {
  register(spec: CommandSpec): void;
  /** Stable order: registration order, built-ins first. */
  list(): readonly CommandSpec[];
}
