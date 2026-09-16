import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { ToolDefinition } from "@chantier/core";
import { glob } from "tinyglobby";
import {
  denyReadMessage,
  formatNumbered,
  isDenyReadPath,
  requireString,
  resolveInCwd,
  truncateOutput,
} from "./common.ts";

const DEFAULT_LINE_LIMIT = 2000;

export const readTool: ToolDefinition = {
  name: "read",
  description:
    "Read a file as numbered text (1-indexed). With offset/limit you can window large files. " +
    "Passing a directory path lists its entries (depth 1). Protected paths (.env*, *.pem, id_rsa*, ~/.ssh) are refused.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File or directory path, relative to the project cwd" },
      offset: { type: "number", description: "1-indexed first line to show" },
      limit: { type: "number", description: "Maximum number of lines to show" },
    },
    required: ["path"],
  },
  readOnly: true,
  specifier: (input) => requireString(input, "path"),
  handler: async (input, ctx) => {
    const raw = requireString(input, "path");
    if (raw === undefined) return "Error: the `path` argument is required and must be a string.";
    const resolved = resolveInCwd(ctx.cwd, raw);
    if (isDenyReadPath(resolved)) return denyReadMessage(resolved);

    const info = await stat(resolved).catch((error: NodeJS.ErrnoException) => error);
    if (info instanceof Error) {
      if (info.code !== "ENOENT") {
        return `Error: could not access ${resolved}: ${String(info.message)}`;
      }
      return missingFileMessage(resolved);
    }

    if (info.isDirectory()) {
      const entries = await readdir(resolved, { withFileTypes: true });
      const names = entries
        .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
        .sort((a, b) => a.localeCompare(b));
      return truncateOutput(names.map((name) => name).join("\n"));
    }

    const offset = typeof input.offset === "number" ? Math.floor(input.offset) : 1;
    const limit =
      typeof input.limit === "number" && input.limit > 0
        ? Math.floor(input.limit)
        : DEFAULT_LINE_LIMIT;
    const text = await readFile(resolved, "utf8");
    return truncateOutput(formatNumbered(text, offset, limit));
  },
};

/**
 * Corrective prose for a missing path: list nearby files so the model can recover.
 * Only ENOENT reaches this helper; other stat errors are reported inline.
 */
async function missingFileMessage(resolved: string): Promise<string> {
  const dir = path.dirname(resolved);
  let nearby: string[] = [];
  try {
    nearby = await glob({ patterns: ["*"], cwd: dir, dot: true, deep: 1 });
  } catch {
    nearby = [];
  }
  const listing = nearby.slice(0, 20).sort((a, b) => a.localeCompare(b));
  const nearbyText =
    listing.length > 0
      ? `Nearby files in ${path.dirname(resolved)}:\n${listing.map((name) => `- ${name}`).join("\n")}`
      : "The parent directory is empty or could not be listed.";
  return `Error: no file or directory at ${resolved}. ${nearbyText}`;
}
