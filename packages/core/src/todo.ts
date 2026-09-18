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

// --- Implementation -----------------------------------------------------------

/** Valid TodoStep status values, in checklist order. */
const STATUSES = ["pending", "in_progress", "completed"] as const;

/**
 * The `todo` tool: whole-list checklist replace with the
 * exactly-one-in_progress invariant (extras normalize to pending, first
 * keeps the slot). readOnly: the checklist mutates nothing on disk.
 */
export function createTodoTool(deps: { onTodo: (steps: readonly TodoStep[]) => void }): ToolDefinition {
  return {
    name: "todo",
    description:
      "Track a multi-step plan: replaces the whole checklist with `items` " +
      "({content, status: pending|in_progress|completed}). Exactly one step stays " +
      "in_progress (extras normalize to pending); lay out the plan first and keep it " +
      "current as you work. An empty list clears the checklist.",
    inputSchema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          description: "The full checklist; replaces the previous list wholesale.",
          items: {
            type: "object",
            properties: {
              content: { type: "string", description: "One imperative checklist row." },
              status: { type: "string", enum: [...STATUSES] },
            },
            required: ["content", "status"],
          },
        },
      },
      required: ["items"],
    },
    readOnly: true,
    handler: async (input) => {
      const raw = input["items"];
      if (!Array.isArray(raw)) {
        return "Error: todo requires an `items` array of {content, status} rows.";
      }
      const steps = normalizeTodoSteps(raw);
      if (steps.length === 0) {
        deps.onTodo([]);
        return "todo: list cleared";
      }
      deps.onTodo(steps);
      return summarizeTodoSteps(steps);
    },
  };
}

/**
 * Lenient row normalization: drops non-object/blank rows, coerces unknown
 * statuses to pending, and enforces exactly one in_progress (the first keeps
 * the slot; extras become pending).
 */
export function normalizeTodoSteps(raw: readonly unknown[]): readonly TodoStep[] {
  const steps: TodoStep[] = [];
  let inProgressSeen = false;
  for (const row of raw) {
    if (typeof row !== "object" || row === null) continue;
    const record = row as { content?: unknown; status?: unknown };
    const content = typeof record.content === "string" ? record.content.trim() : "";
    if (content.length === 0) continue;
    const status = STATUSES.find((candidate) => candidate === record.status) ?? "pending";
    if (status === "in_progress" && inProgressSeen) {
      steps.push({ content, status: "pending" });
      continue;
    }
    if (status === "in_progress") inProgressSeen = true;
    steps.push({ content, status });
  }
  return steps;
}

/** One-line summary the model sees: counts per status in fixed order. */
export function summarizeTodoSteps(steps: readonly TodoStep[]): string {
  const done = steps.filter((step) => step.status === "completed").length;
  const active = steps.filter((step) => step.status === "in_progress").length;
  return `todo: ${done} done, ${active} in progress, ${steps.length - done - active} pending`;
}
