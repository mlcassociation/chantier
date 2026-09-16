import { spawn } from "node:child_process";
import type { ToolDefinition } from "@chantier/core";
import { glob as tinyGlob } from "tinyglobby";
import { truncateOutput } from "./common.ts";

export const globTool: ToolDefinition = {
  name: "glob",
  description:
    "Find files matching a glob pattern (e.g. `src/**/*.ts`). Results are sorted lexicographically.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern, relative to the project cwd" },
    },
    required: ["pattern"],
  },
  readOnly: true,
  specifier: (input) => (typeof input.pattern === "string" ? input.pattern : undefined),
  handler: async (input, ctx) => {
    const pattern = typeof input.pattern === "string" ? input.pattern : undefined;
    if (pattern === undefined || pattern.length === 0) {
      return "Error: the `pattern` argument is required and must be a non-empty glob string.";
    }

    const rgResult = await tryRgFiles(pattern, ctx.cwd);
    if (rgResult !== null) {
      if (rgResult === "") return "No files match this pattern.";
      return truncateOutput(
        rgResult
          .split("\n")
          .sort((a, b) => a.localeCompare(b))
          .join("\n"),
      );
    }

    const files = await tinyGlob({ patterns: [pattern], cwd: ctx.cwd, dot: true });
    if (files.length === 0) return "No files match this pattern.";
    return truncateOutput(files.sort((a, b) => a.localeCompare(b)).join("\n"));
  },
};

/** `rg --files -g` when ripgrep is installed; null = unavailable (fallback needed). */
async function tryRgFiles(pattern: string, cwd: string): Promise<string | null> {
  const { promise, resolve } = Promise.withResolvers<string | null>();
  const child = spawn("rg", ["--files", "--hidden", "--no-messages", "-g", pattern], { cwd });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.on("error", () => resolve(null)); // ENOENT → rg not installed
  child.on("close", (code) => {
    if (code === null || (code !== 0 && code !== 1)) resolve(null);
    else resolve(stdout.trimEnd());
  });
  return promise;
}
