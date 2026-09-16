import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ToolDefinition } from "@chantier/core";
import { requireString, resolveInCwd, truncateOutput } from "./common.ts";

export const writeTool: ToolDefinition = {
  name: "write",
  description:
    "Create or overwrite a file. Parent directories are created automatically. " +
    "Overwriting an existing file with more than 5 lines requires `overwrite: true`.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, relative to the project cwd" },
      content: { type: "string", description: "Full file content to write" },
      overwrite: {
        type: "boolean",
        description: "Set true to overwrite an existing multi-line file",
      },
    },
    required: ["path", "content"],
  },
  readOnly: false,
  specifier: (input) => requireString(input, "path"),
  handler: async (input, ctx) => {
    const raw = requireString(input, "path");
    const content = requireString(input, "content");
    if (raw === undefined) return "Error: the `path` argument is required and must be a string.";
    if (content === undefined)
      return "Error: the `content` argument is required and must be a string.";
    const resolved = resolveInCwd(ctx.cwd, raw);

    const existing = await stat(resolved).catch(() => null);
    if (existing?.isFile()) {
      const current = await readFile(resolved, "utf8");
      const lines = current.split("\n");
      if (lines.at(-1) === "") lines.pop();
      const lineCount = lines.length;
      if (lineCount > 5 && input.overwrite !== true) {
        return (
          `Error: ${resolved} already exists (${lineCount} lines). Overwriting a multi-line file by mistake is hard to undo. ` +
          "If this is intentional, retry with `overwrite: true`. For targeted changes prefer the `edit` tool."
        );
      }
    }

    await mkdir(path.dirname(resolved), { recursive: true });
    await writeFile(resolved, content, "utf8");
    return truncateOutput(`Wrote ${Buffer.byteLength(content, "utf8")} bytes to ${resolved}`);
  },
};
