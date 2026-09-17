import type { ToolDefinition } from "@chantier/core";
import { bashTool } from "./bash.ts";
import { editTool } from "./edit.ts";
import { globTool } from "./glob.ts";
import { grepTool } from "./grep.ts";
import { readTool } from "./read.ts";
import { webfetchTool } from "./webfetch.ts";
import { writeTool } from "./write.ts";

export {
  denyReadMessage,
  formatNumbered,
  isDenyReadPath,
  MAX_TOOL_OUTPUT_CHARS,
  requireString,
  resolveInCwd,
  truncateOutput,
} from "./common.ts";
export { createTaskTool } from "./task.ts";
export { htmlToText } from "./webfetch.ts";

/** The seven v0.1 built-in tools. */
export function buildTools(): ToolDefinition[] {
  return [readTool, writeTool, editTool, bashTool, globTool, grepTool, webfetchTool];
}

export { bashTool, editTool, globTool, grepTool, readTool, webfetchTool, writeTool };
