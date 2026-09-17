import { type SubagentDeps, spawnSubagent, type ToolDefinition } from "@chantier/core";
import { requireString } from "./common.ts";

/**
 * The `task` tool: delegates one self-contained subtask to a fresh child agent
 * run (Phase A of the subagent roadmap; see core spawnSubagent).
 */
export function createTaskTool(deps: SubagentDeps): ToolDefinition {
  return {
    name: "task",
    description:
      "Delegate one self-contained subtask to a fresh subagent that runs with the builtin tools " +
      "(no task tool, so it cannot delegate further). The prompt must be self-contained — the " +
      "subagent sees only it, optionally plus background via context — and the subagent works " +
      "independently, returning a single summary of what it did and found. Use for read-biased " +
      "work: research, reading, exploration-sized subtasks. One subtask per call; do quick " +
      "lookups yourself.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "Self-contained subtask: the goal plus everything needed to work alone.",
        },
        context: {
          type: "string",
          description: "Optional background (paths, constraints, prior findings).",
        },
      },
      required: ["prompt"],
    },
    // Phase A is deliberately sequential: runAgent groups consecutive readOnly
    // calls concurrently, so a read-only task tool would spawn parallel
    // children — that is Phase B.
    readOnly: false,
    handler: async (input, ctx) => {
      const prompt = requireString(input, "prompt");
      if (prompt === undefined) {
        return "Error: the `prompt` argument is required and must be a string.";
      }
      const context = requireString(input, "context");
      const composed = context === undefined ? prompt : `${prompt}\n\n# Context\n\n${context}`;
      const result = await spawnSubagent({ prompt: composed }, deps, ctx);
      return `${result.text}\n\n(subagent session: ${result.sessionId})`;
    },
  };
}
