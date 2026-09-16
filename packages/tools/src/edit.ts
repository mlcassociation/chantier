import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ToolContext, ToolDefinition } from "@chantier/core";
import { createTwoFilesPatch } from "diff";
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

/** Dominant line ending of a file; ties and pure-LF files are treated as LF. */
function dominantEol(text: string): "\r\n" | "\n" {
  const crlf = countOccurrences(text, "\r\n");
  const lf = countOccurrences(text, "\n") - crlf;
  return crlf > lf ? "\r\n" : "\n";
}

type EditPlan =
  | { ok: true; updated: string; matchCount: number; crlfFile: boolean; crlfRetry: boolean }
  | { ok: false; kind: "not-found"; error: string }
  | { ok: false; kind: "ambiguous"; count: number; error: string };

/**
 * Applies oldString → newString on `original`. When the file is CRLF-dominant and
 * the exact match misses, oldString's `\n` are retried as `\r\n` (models write LF);
 * the replacement text is normalized to the file's dominant ending either way.
 */
export function planEdit(
  original: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): EditPlan {
  const crlfFile = dominantEol(original) === "\r\n";
  let target = oldString;
  let crlfRetry = false;
  let matches = countOccurrences(original, oldString);
  if (matches === 0 && crlfFile && oldString.includes("\n")) {
    const crlfOld = oldString.replace(/\r?\n/g, "\r\n");
    const crlfMatches = countOccurrences(original, crlfOld);
    if (crlfMatches > 0) {
      target = crlfOld;
      crlfRetry = true;
      matches = crlfMatches;
    }
  }
  if (matches === 0) {
    const snippet = oldString.length > 200 ? `${oldString.slice(0, 200)}\u2026` : oldString;
    return {
      ok: false,
      kind: "not-found",
      error:
        "The match is exact (whitespace and indentation included). Read the file around your target and copy the text verbatim. " +
        `You sent:\n${JSON.stringify(snippet)}`,
    };
  }
  if (matches > 1 && !replaceAll) {
    return {
      ok: false,
      kind: "ambiguous",
      count: matches,
      error:
        "Include more surrounding context to make it unique, or pass `replaceAll: true` if every occurrence should change.",
    };
  }
  const normalizedNew = crlfFile
    ? newString.replace(/\r?\n/g, "\r\n")
    : newString.replace(/\r\n/g, "\n");
  const updated =
    replaceAll === true
      ? original.split(target).join(normalizedNew)
      : original.replace(target, normalizedNew);
  return { ok: true, updated, matchCount: matches, crlfFile, crlfRetry };
}

/** Unified diff (a/<rel> → b/<rel>) of the planned edit, for the approval card. */
async function editAskDetail(
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<{ diff: string } | undefined> {
  const raw = requireString(input, "path");
  const oldString = requireString(input, "oldString");
  const newString = requireString(input, "newString");
  if (
    raw === undefined ||
    oldString === undefined ||
    oldString.length === 0 ||
    newString === undefined
  )
    return undefined;
  const resolved = resolveInCwd(ctx.cwd, raw);
  const original = await readFile(resolved, "utf8").catch(() => undefined);
  if (original === undefined) return undefined;
  const plan = planEdit(original, oldString, newString, input.replaceAll === true);
  if (!plan.ok) return undefined;
  const rel = path.relative(ctx.cwd, resolved);
  const diff = createTwoFilesPatch(
    `a/${rel}`,
    `b/${rel}`,
    original,
    plan.updated,
    undefined,
    undefined,
    {
      context: 3,
    },
  );
  return { diff };
}

export const editTool: ToolDefinition = {
  name: "edit",
  description:
    "Replace an exact unique string in a file with new text. The oldString must match exactly once; " +
    "if it is ambiguous, include more surrounding context or pass replaceAll: true. Read the file first. " +
    "CRLF files keep their line endings: if your oldString uses \\n and misses, the tool retries it as \\r\\n.",
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
  askDetail: editAskDetail,
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
    const plan = planEdit(original, oldString, newString, input.replaceAll === true);
    if (!plan.ok) {
      return plan.kind === "not-found"
        ? `Error: oldString not found in ${resolved}. ${plan.error}`
        : `Error: oldString appears ${plan.count} times in ${resolved}. ${plan.error}`;
    }
    await writeFile(resolved, plan.updated, "utf8");
    const changed = input.replaceAll === true ? `${plan.matchCount} occurrence(s)` : "1 occurrence";
    const eolNote = plan.crlfFile
      ? plan.crlfRetry
        ? " (CRLF line endings preserved; oldString matched after an LF→CRLF retry)"
        : " (CRLF line endings preserved)"
      : "";
    return truncateOutput(
      `Edited ${resolved}: replaced ${changed} (${oldString.length} → ${newString.length} chars)${eolNote}.`,
    );
  },
};
