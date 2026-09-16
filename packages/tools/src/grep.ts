import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ToolDefinition } from "@chantier/core";
import { glob as tinyGlob } from "tinyglobby";
import { isDenyReadPath, truncateOutput } from "./common.ts";

const MAX_LINES = 100;
const MAX_MATCHES_PER_FILE = 50;

export const grepTool: ToolDefinition = {
  name: "grep",
  description:
    "Search file contents with a regular expression. Returns `file:line:text` lines (max 100). " +
    "Pass `path` to search a subtree and `glob` to filter files (e.g. `*.ts`). Protected paths are skipped.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regular expression to search for" },
      path: { type: "string", description: "Directory or file to search (default: project cwd)" },
      glob: { type: "string", description: "File glob filter, e.g. `*.ts`" },
    },
    required: ["pattern"],
  },
  readOnly: true,
  specifier: (input) => (typeof input.pattern === "string" ? input.pattern : undefined),
  handler: async (input, ctx) => {
    const pattern = typeof input.pattern === "string" ? input.pattern : undefined;
    if (pattern === undefined || pattern.length === 0) {
      return "Error: the `pattern` argument is required and must be a non-empty regular expression.";
    }
    let regex: RegExp;
    try {
      regex = new RegExp(pattern);
    } catch (error) {
      return `Error: invalid regular expression: ${(error as Error).message}`;
    }
    const searchPath = typeof input.path === "string" ? input.path : ".";
    const globFilter = typeof input.glob === "string" ? input.glob : undefined;

    const rgResult = await tryRg(pattern, ctx.cwd, searchPath, globFilter);
    return rgResult ?? (await jsFallback(regex, ctx.cwd, searchPath, globFilter));
  },
};

/** `rg -n --max-count 50` when ripgrep is installed; null = unavailable. */
async function tryRg(
  pattern: string,
  cwd: string,
  searchPath: string,
  globFilter: string | undefined,
): Promise<string | null> {
  const { promise, resolve } = Promise.withResolvers<string | null>();
  const globArgs = globFilter === undefined ? [] : ["--glob", globFilter];
  const args = [
    "-n",
    "--max-count",
    String(MAX_MATCHES_PER_FILE),
    "--hidden",
    "--no-messages",
    ...globArgs,
    pattern,
    searchPath,
  ];
  const child = spawn("rg", args, { cwd });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.on("error", () => resolve(null)); // ENOENT → rg not installed
  child.on("close", (code) => {
    if (code === null || (code !== 0 && code !== 1)) {
      resolve(null);
      return;
    }
    // Post-filter: rg is unaware of the deny-read list, so drop protected files here.
    const kept = stdout
      .split("\n")
      .filter((line) => {
        const file = line.split(":")[0];
        return file === undefined || file.length === 0 || !isDenyReadPath(path.resolve(cwd, file));
      })
      .join("\n");
    resolve(kept.trimEnd());
  });
  return promise;
}

/** Line-walk fallback when rg is unavailable; protected paths are skipped. */
async function jsFallback(
  regex: RegExp,
  cwd: string,
  searchPath: string,
  globFilter: string | undefined,
): Promise<string> {
  const base = path.resolve(cwd, searchPath);
  const patterns = globFilter === undefined ? ["**/*"] : [`**/${globFilter}`, globFilter];
  const files = await tinyGlob({ patterns, cwd: base, dot: true, deep: 10 });
  const lines: string[] = [];
  for (const file of files.slice().sort((a, b) => a.localeCompare(b))) {
    if (lines.length >= MAX_LINES) break;
    const absolute = path.join(base, file);
    if (isDenyReadPath(absolute)) continue;
    const content = await readFile(absolute, "utf8").catch(() => null);
    if (content === null) continue;
    const fileLines = content.split("\n");
    let shown = 0;
    for (let i = 0; i < fileLines.length && shown < MAX_MATCHES_PER_FILE; i++) {
      if (regex.test(fileLines[i] as string)) {
        lines.push(
          `${searchPath === "." ? file : path.join(searchPath, file)}:${i + 1}:${fileLines[i]}`,
        );
        shown += 1;
        if (lines.length >= MAX_LINES) break;
      }
    }
  }
  if (lines.length === 0) return "No matches.";
  return truncateOutput(lines.join("\n"));
}
