import type { ToolDefinition } from "@chantier/core";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type {
  CallToolResult,
  CompatibilityCallToolResult,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { isRecord } from "./guard.ts";

/**
 * What `client.callTool` resolves to: a normal result (content blocks) or a
 * task/compatibility result (opaque `toolResult`, rendered as no content).
 */
export type ToolResultPayload = CallToolResult | CompatibilityCallToolResult;

/**
 * A connected MCP server (or any object exposing the same surface — tests
 * use stand-ins). The tool adapter and the connection loop share this ref.
 */
export interface McpServerRef {
  readonly name: string;
  readonly client: Client;
}

/** Model-facing tool output is capped at this many chars, with a visible note. */
export const MAX_MCP_OUTPUT_CHARS = 25_000;

/** Per-call SDK request timeout; a dead server surfaces as a failed tool result. */
export const MCP_CALL_TIMEOUT_MS = 60_000;

/** Non-`[A-Za-z0-9_-]` characters collapse to `_` (Claude Code / RULE_PATTERN charset). */
const UNSAFE_NAME_CHARS = /[^A-Za-z0-9_-]/g;

export function sanitizeMcpName(raw: string): string {
  const cleaned = raw.replace(UNSAFE_NAME_CHARS, "_");
  return cleaned.length === 0 ? "_" : cleaned;
}

/** Adapter tool name: `mcp__<server>__<tool>` with sanitized segments. */
export function mcpToolName(server: string, tool: string): string {
  return `mcp__${sanitizeMcpName(server)}__${sanitizeMcpName(tool)}`;
}

/**
 * Adapts one server tool to a chantier ToolDefinition. A string return is a
 * skip reason (the tool does not fit chantier's object-schema shape); the
 * caller turns it into a notice.
 */
export function toToolDefinition(server: McpServerRef, info: Tool): ToolDefinition | string {
  const schema: unknown = info.inputSchema;
  if (typeof schema !== "object" || schema === null) return "inputSchema is not an object";
  if (!("type" in schema) || schema.type !== "object") {
    return 'inputSchema type is not "object"';
  }
  const properties = "properties" in schema && isRecord(schema.properties) ? schema.properties : {};
  const requiredList =
    "required" in schema &&
    Array.isArray(schema.required) &&
    schema.required.every((entry) => typeof entry === "string")
      ? schema.required
      : undefined;
  const originalName = info.name;
  return {
    name: mcpToolName(server.name, originalName),
    description: info.description ?? "",
    inputSchema: {
      type: "object",
      properties,
      ...(requiredList === undefined ? {} : { required: [...requiredList] }),
    },
    readOnly: info.annotations?.readOnlyHint === true,
    handler: async (input, ctx) => {
      const result = await callTool(server, originalName, input, { signal: ctx.signal });
      return truncateMcpOutput(renderToolContent(result));
    },
  };
}

/** One tool call against the server; `timeout` defaults to MCP_CALL_TIMEOUT_MS. */
export async function callTool(
  server: McpServerRef,
  name: string,
  args: Record<string, unknown>,
  opts: { timeout?: number; signal?: AbortSignal } = {},
): Promise<ToolResultPayload> {
  return server.client.callTool({ name, arguments: args }, undefined, {
    timeout: opts.timeout ?? MCP_CALL_TIMEOUT_MS,
    ...(opts.signal === undefined ? {} : { signal: opts.signal }),
  }) satisfies Promise<ToolResultPayload>;
}

/**
 * Renders a tool result in-band: text blocks joined by newlines. An
 * `isError` result still returns its text (the model reads the failure);
 * transport-level throws are NOT caught here — the engine turns them into
 * failed tool results.
 */
export function renderToolContent(result: ToolResultPayload): string {
  if ("toolResult" in result) {
    // Task/compatibility result: no content blocks to render.
    return "(no content)";
  }
  const parts: string[] = [];
  for (const block of result.content) {
    if (block.type === "text") parts.push(block.text);
  }
  if (parts.length > 0) return parts.join("\n");
  if (result.isError === true) return "mcp tool failed (no error details returned)";
  return "(no content)";
}

export function truncateMcpOutput(text: string, maxChars: number = MAX_MCP_OUTPUT_CHARS): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n[truncated: showing first ${maxChars} of ${text.length} chars]`;
}
