import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ToolDefinition } from "@chantier/core";
import { glob as tinyGlob } from "tinyglobby";
import { isDenyReadPath, truncateOutput } from "./common.ts";

export type GrepMode = "content" | "files_with_matches";

const MAX_LINES = 100;
const MAX_MATCHES_PER_FILE = 50;

export const grepTool: ToolDefinition = {
  name: "grep",
  description:
    "Search file contents with a regular expression (case-sensitive, matches anywhere in a line). " +
    "Mode `content` (default) returns `file:line:text` lines; mode `files_with_matches` returns only matching " +
    "file paths. Results are capped at 100 entries unless `head_limit` is given (max per file: 50). " +
    "Use `offset` + `head_limit` to page through large result sets. Pass `path` to search a subtree and `glob` " +
    "to filter files (e.g. `*.ts`). Protected paths are skipped. When nothing matches, the tool suggests how " +
    "to widen the search.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regular expression to search for" },
      path: { type: "string", description: "Directory or file to search (default: project cwd)" },
      glob: { type: "string", description: "File glob filter, e.g. `*.ts`" },
      mode: {
        type: "string",
        enum: ["content", "files_with_matches"],
        description:
          "content: file:line:text lines (default). files_with_matches: matching file paths only",
      },
      head_limit: {
        type: "number",
        description: "Maximum number of entries (lines or files) to return (default 100)",
      },
      offset: {
        type: "number",
        description: "Skip the first N entries before applying head_limit",
      },
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
    const modeInput = typeof input.mode === "string" ? input.mode : undefined;
    if (modeInput !== undefined && modeInput !== "content" && modeInput !== "files_with_matches") {
      return 'Error: mode must be "content" or "files_with_matches".';
    }
    const mode: GrepMode = modeInput === "files_with_matches" ? "files_with_matches" : "content";
    const headLimit =
      typeof input.head_limit === "number" ? Math.floor(input.head_limit) : MAX_LINES;
    if (headLimit <= 0) return "Error: head_limit must be a positive integer.";
    const offset = typeof input.offset === "number" ? Math.floor(input.offset) : 0;
    if (offset < 0) return "Error: offset must be a non-negative integer.";
    const searchPath = typeof input.path === "string" ? input.path : ".";
    const globFilter = typeof input.glob === "string" ? input.glob : undefined;

    const rgEntries = await tryRg(pattern, ctx.cwd, searchPath, globFilter, mode);
    const entries = rgEntries ?? (await jsFallback(regex, ctx.cwd, searchPath, globFilter, mode));
    if (entries.length === 0) return noMatchesMessage(pattern);
    return pageResults(entries, offset, headLimit);
  },
};

/** Corrective prose for an empty result set; shared by the rg fast path and the JS fallback. */
export function noMatchesMessage(pattern: string): string {
  return (
    `No matches for ${JSON.stringify(pattern)}. The regex is case-sensitive and matches anywhere in a line. ` +
    "Try a simpler pattern, check spelling and escaping (regex metacharacters like `.` and `(` need backslashes), " +
    "broaden the `glob` filter or drop it, or widen `path` to the whole project."
  );
}

/**
 * Applies offset/head_limit pagination to an ordered result list and renders the page.
 * Appends a continuation notice when entries remain beyond the window.
 */
export function pageResults(entries: string[], offset: number, headLimit: number): string {
  if (offset >= entries.length) {
    const plural = entries.length === 1 ? "entry" : "entries";
    return `Error: offset ${offset} is past the end (${entries.length} ${plural} total). Re-run with a smaller offset.`;
  }
  const page = entries.slice(offset, offset + headLimit);
  const end = offset + page.length;
  const body = page.join("\n");
  if (end < entries.length) {
    return truncateOutput(
      `${body}\n[${entries.length} entries total; showing ${offset + 1}\u2013${end}; re-run with offset=${end} for the next page]`,
    );
  }
  return truncateOutput(body);
}

/**
 * Ripgrep fast path. Returns the raw entry lines (content mode: `file:line:text`,
 * files mode: file paths), or null when rg is unavailable or errored (caller
 * falls back to the JS walker). No-match (exit 1) is an empty list, not null.
 */
async function tryRg(
  pattern: string,
  cwd: string,
  searchPath: string,
  globFilter: string | undefined,
  mode: GrepMode,
): Promise<string[] | null> {
  const { promise, resolve } = Promise.withResolvers<string[] | null>();
  const globArgs = globFilter === undefined ? [] : ["--glob", globFilter];
  const modeArgs =
    mode === "content" ? ["-n", "--max-count", String(MAX_MATCHES_PER_FILE)] : ["-l"];
  const args = [...modeArgs, "--hidden", "--no-messages", ...globArgs, pattern, searchPath];
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
    const lines = stdout.split("\n").filter((line) => line.length > 0);
    // Post-filter: rg is unaware of the deny-read list, so drop protected files here.
    const kept = lines.filter((line) => {
      const file = mode === "content" ? (line.split(":")[0] ?? "") : line;
      return file.length === 0 || !isDenyReadPath(path.resolve(cwd, file));
    });
    resolve(kept);
  });
  return promise;
}

/** Line-walk fallback when rg is unavailable; protected paths are skipped. */
async function jsFallback(
  regex: RegExp,
  cwd: string,
  searchPath: string,
  globFilter: string | undefined,
  mode: GrepMode,
): Promise<string[]> {
  const base = path.resolve(cwd, searchPath);
  const patterns = globFilter === undefined ? ["**/*"] : [`**/${globFilter}`, globFilter];
  const files = await tinyGlob({ patterns, cwd: base, dot: true, deep: 10 });
  const entries: string[] = [];
  for (const file of files.slice().sort((a, b) => a.localeCompare(b))) {
    const absolute = path.join(base, file);
    if (isDenyReadPath(absolute)) continue;
    const content = await readFile(absolute, "utf8").catch(() => null);
    if (content === null) continue;
    const display = searchPath === "." ? file : path.join(searchPath, file);
    const fileLines = content.split("\n");
    if (mode === "files_with_matches") {
      if (fileLines.some((line) => regex.test(line))) entries.push(display);
      continue;
    }
    let shown = 0;
    for (let i = 0; i < fileLines.length && shown < MAX_MATCHES_PER_FILE; i++) {
      if (regex.test(fileLines[i] ?? "")) {
        entries.push(`${display}:${i + 1}:${fileLines[i]}`);
        shown += 1;
      }
    }
  }
  return entries;
}
