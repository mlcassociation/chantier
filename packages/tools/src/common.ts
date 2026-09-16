import { homedir } from "node:os";
import path from "node:path";

/** Model-facing tool output is capped at this many chars, with a visible note. */
export const MAX_TOOL_OUTPUT_CHARS = 40_000;

export function truncateOutput(text: string, maxChars: number = MAX_TOOL_OUTPUT_CHARS): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n[truncated: showing first ${maxChars} of ${text.length} chars]`;
}

/**
 * Deny-first read protection, enforced inside the file tools (defense in depth,
 * independent of permission rules): .env, .env.*, *.pem, id_rsa*, ~/.ssh/**.
 */
export function isDenyReadPath(resolvedPath: string): boolean {
  const base = path.basename(resolvedPath);
  if (base === ".env" || base.startsWith(".env.")) return true;
  if (base.endsWith(".pem")) return true;
  if (base.startsWith("id_rsa")) return true;
  const home = homedir();
  const expanded = resolvedPath.startsWith("~")
    ? path.join(home, resolvedPath.slice(1))
    : resolvedPath;
  const segments = expanded.split(path.sep);
  if (segments.includes(".ssh")) return true;
  return false;
}

export function denyReadMessage(resolvedPath: string): string {
  return `Error: ${resolvedPath} is protected (deny-read list: .env, .env.*, *.pem, id_rsa*, ~/.ssh/**). This path cannot be read, listed, or searched.`;
}

/**
 * Resolves a tool input path against the project cwd. Absolute paths are allowed
 * as-is (user-specified); relative paths resolve inside cwd.
 */
export function resolveInCwd(cwd: string, inputPath: string): string {
  return path.isAbsolute(inputPath)
    ? path.normalize(inputPath)
    : path.normalize(path.join(cwd, inputPath));
}

/** Formats file text with 1-indexed line numbers, optionally windowed. */
export function formatNumbered(text: string, offset = 1, limit?: number): string {
  const lines = text.split("\n");
  const start = Math.max(1, offset);
  const end = limit === undefined ? lines.length : Math.min(lines.length, start - 1 + limit);
  const window = lines.slice(start - 1, end);
  const width = String(end).length;
  return window.map((line, i) => `${String(start + i).padStart(width)}: ${line}`).join("\n");
}

/** Parses a tool input field as a string, with a model-facing prose error. */
export function requireString(input: Record<string, unknown>, field: string): string | undefined {
  const value = input[field];
  if (typeof value === "string") return value;
  return undefined;
}
