import type { ToolDefinition } from "./types.ts";
/**
 * Frozen v0.6.0 contract (spec /home/debian/portfolio/chantier/v06-spec.md
 * §Frozen contract): the todo-checklist step shape shared by the core tool,
 * the store, and the TUI. Types only — Worker CoreExt implements the tool;
 * the TUI worker implements the store fields and rendering.
 */

/** One checklist row. Whole-list replace per call; at most one in_progress. */
export interface TodoStep {
  readonly content: string;
  readonly status: "pending" | "in_progress" | "completed";
}

/**
 * The todo tool factory. The tool replaces the whole checklist per call and
 * enforces the exactly-one-in_progress invariant (normalizing extras to
 * pending). `onTodo` receives every accepted list; the CLI loop forwards it
 * to the TUI store.
 */
export type CreateTodoTool = (deps: {
  onTodo: (steps: readonly TodoStep[]) => void;
}) => ToolDefinition;
