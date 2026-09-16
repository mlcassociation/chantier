import { readFile, stat, writeFile } from "node:fs/promises";
import type { ToolDefinition } from "@chantier/core";
import { requireString, resolveInCwd, truncateOutput } from "./common.ts";

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + 1);
  }
  return count;
}

export const editTool: ToolDefinition = {
  name: "edit",
  description:
    "Replace an exact unique string in a file with new text. The oldString must match exactly once; " +
    "if it is ambiguous, include more surrounding context or pass replaceAll: true. Read the file first.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, relative to the project cwd" },
      oldString: {
        type: "string",
        description: "Exact text to replace (must be unique unless replaceAll)",
      },
      newString: { type: "string", description: "Replacement text" },
      replaceAll: {
        type: "boolean",
        description: "Replace every occurrence instead of requiring uniqueness",
      },
    },
    required: ["path", "oldString", "newString"],
  },
  readOnly: false,
  specifier: (input) => requireString(input, "path"),
  handler: async (input, ctx) => {
    const raw = requireString(input, "path");
    const oldString = requireString(input, "oldString");
    const newString = requireString(input, "newString");
    if (raw === undefined) return "Error: the `path` argument is required and must be a string.";
    if (oldString === undefined || oldString.length === 0) {
      return "Error: the `oldString` argument is required, must be a string, and must not be empty.";
    }
    if (newString === undefined)
      return "Error: the `newString` argument is required and must be a string.";
    const resolved = resolveInCwd(ctx.cwd, raw);

    const existing = await stat(resolved).catch(() => null);
    if (existing === null || !existing.isFile()) {
      return `Error: no file at ${resolved}. Use the read tool first to confirm the exact path.`;
    }

    const original = await readFile(resolved, "utf8");
    const matches = countOccurrences(original, oldString);
    if (matches === 0) {
      const snippet = oldString.length > 200 ? `${oldString.slice(0, 200)}…` : oldString;
      return (
        `Error: oldString not found in ${resolved}. The match is exact (whitespace and indentation included). ` +
        `Read the file around your target and copy the text verbatim. You sent:\n${JSON.stringify(snippet)}`
      );
    }
    if (matches > 1 && input.replaceAll !== true) {
      return (
        `Error: oldString appears ${matches} times in ${resolved}. Include more surrounding context to make it unique, ` +
        "or pass `replaceAll: true` if every occurrence should change."
      );
    }
    const updated =
      input.replaceAll === true
        ? original.split(oldString).join(newString)
        : original.replace(oldString, newString);
    await writeFile(resolved, updated, "utf8");
    const changed = input.replaceAll === true ? `${matches} occurrence(s)` : "1 occurrence";
    return truncateOutput(
      `Edited ${resolved}: replaced ${changed} (${oldString.length} → ${newString.length} chars).`,
    );
  },
};
