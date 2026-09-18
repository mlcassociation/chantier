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

// --- Implementation -----------------------------------------------------------

/**
 * Core-agnostic IO surface actions render through. The TUI store satisfies
 * it structurally (its pushItem accepts every TuiItem, including these).
 */
export interface CommandIo {
  /** Abort signal for the current prompt interaction (e.g. manual compaction). */
  readonly signal: AbortSignal;
  /** Appends one transcript line. */
  pushItem(item: { readonly kind: "info" | "divider" | "error"; readonly text: string }): void;
}

/** A registered action command: `run` performs the work itself. */
export interface ActionSpec extends CommandSpec {
  readonly kind: "action";
  /** Only exact `/name` dispatches (the /compact rule); args go to the agent verbatim. */
  readonly run?: (io: CommandIo) => void | Promise<void>;
}

/** A registered expand command (e.g. a skill): rewrites the task text. */
export interface ExpandSpec extends CommandSpec {
  readonly kind: "expand";
  /**
   * Receives the text after the command name ("" when none) and returns the
   * replacement task. Async bodies (skill files) are awaited by dispatch.
   */
  readonly expand: (args: string) => string | Promise<string>;
}

export type RegistrableCommand = ActionSpec | ExpandSpec;

export type DispatchResult =
  | { readonly kind: "handled" }
  | { readonly kind: "expanded"; readonly task: string }
  | { readonly kind: "not-command" };

export interface CommandRegistryV6 extends CommandRegistry {
  register(spec: RegistrableCommand): void;
  /**
   * Slash-command seam for the interactive loop. A trimmed task starting
   * with `/` whose first word exactly matches a registered command
   * dispatches; anything else is `not-command` (the task goes to the agent
   * verbatim). Actions dispatch only on the exact `/name` form; expand
   * commands receive the remaining text as args.
   */
  dispatch(task: string, io: CommandIo): Promise<DispatchResult>;
}

const COMMAND_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const COMMAND_NAME_MAX = 64;

export function createCommandRegistry(): CommandRegistryV6 {
  const commands = new Map<string, RegistrableCommand>();
  return {
    register(spec: RegistrableCommand): void {
      if (spec.name.length === 0 || spec.name.length > COMMAND_NAME_MAX || !COMMAND_NAME_PATTERN.test(spec.name)) {
        throw new Error(
          `Invalid command name "${spec.name}" (1-${COMMAND_NAME_MAX} chars, [a-z0-9-], no lead/trail/double -).`,
        );
      }
      if (commands.has(spec.name)) throw new Error(`Command "${spec.name}" is already registered.`);
      if (spec.kind === "expand" && typeof spec.expand !== "function") {
        throw new Error(`Expand command "${spec.name}" requires an expand function.`);
      }
      commands.set(spec.name, spec);
    },
    list: () => [...commands.values()],
    async dispatch(task, io) {
      const trimmed = task.trim();
      if (!trimmed.startsWith("/")) return { kind: "not-command" };
      const word = trimmed.slice(1).split(/\s+/, 1)[0] ?? "";
      const spec = commands.get(word);
      if (spec === undefined) return { kind: "not-command" };
      if (spec.kind === "action") {
        // The /compact rule: with-args goes to the agent verbatim.
        if (trimmed !== `/${spec.name}`) return { kind: "not-command" };
        await spec.run?.(io);
        return { kind: "handled" };
      }
      const args = trimmed.slice(1 + spec.name.length).trim();
      return { kind: "expanded", task: await spec.expand(args) };
    },
  };
}
