import path from "node:path";
import type { ToolDefinition } from "@chantier/core";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import {
  MAX_MCP_OUTPUT_CHARS,
  mcpToolName,
  renderToolContent,
  sanitizeMcpName,
  type ToolResultPayload,
  toToolDefinition,
  truncateMcpOutput,
} from "../src/adapter.ts";

const _SERVER_SCRIPT = path.join(import.meta.dirname, "helpers", "fake-server.mjs");

describe("sanitizeMcpName / mcpToolName", () => {
  it("collapses unsafe characters to underscores and prefixes mcp__", () => {
    expect(sanitizeMcpName("my server")).toBe("my_server");
    expect(sanitizeMcpName("tool.v2")).toBe("tool_v2");
    expect(sanitizeMcpName("keep-1_2")).toBe("keep-1_2");
    expect(mcpToolName("my server", "tool.v2")).toBe("mcp__my_server__tool_v2");
  });
});

describe("toToolDefinition (mock client)", () => {
  function fakeClient(result: ToolResultPayload | Error): Client {
    const callTool = async (): Promise<ToolResultPayload> => {
      if (result instanceof Error) throw result;
      return result;
    };
    return { callTool } as unknown as Client;
  }

  const base: Tool = {
    name: "echo",
    description: "Echo tool.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  };

  it("adapts name, description, required, and readOnlyHint verbatim", () => {
    const server = { name: "srv", client: fakeClient({ content: [] }) };
    const tool = toToolDefinition(server, {
      ...base,
      annotations: { readOnlyHint: true },
    });
    expect(typeof tool).toBe("object");
    const def = tool as ToolDefinition;
    expect(def.name).toBe("mcp__srv__echo");
    expect(def.description).toBe("Echo tool.");
    expect(def.readOnly).toBe(true);
    expect(def.inputSchema).toEqual({
      type: "object",
      properties: base.inputSchema.properties,
      required: ["text"],
    });
  });

  it("defaults readOnly to false and drops a missing description", () => {
    const server = { name: "srv", client: fakeClient({ content: [] }) };
    const def = toToolDefinition(server, {
      name: "t",
      inputSchema: { type: "object", properties: {} },
    }) as ToolDefinition;
    expect(def.readOnly).toBe(false);
    expect(def.description).toBe("");
    expect(def.inputSchema.required).toBeUndefined();
  });

  it("skips non-object schemas with a reason", () => {
    const server = { name: "srv", client: fakeClient({ content: [] }) };
    const bad = toToolDefinition(server, {
      name: "t",
      description: "d",
      inputSchema: { type: "string" } as unknown as Tool["inputSchema"],
    });
    expect(typeof bad).toBe("string");
    expect(bad).toContain('not "object"');
  });

  it("renders text content and passes isError results through in-band", async () => {
    const server = {
      name: "srv",
      client: fakeClient({ content: [{ type: "text", text: "boom failed" }], isError: true }),
    };
    const def = toToolDefinition(server, base) as ToolDefinition;
    await expect(def.handler({ text: "x" }, stubContext())).resolves.toBe("boom failed");
  });

  it("renders multiple text blocks joined by newlines and truncates", async () => {
    const text = "a".repeat(MAX_MCP_OUTPUT_CHARS + 10);
    const server = {
      name: "srv",
      client: fakeClient({
        content: [
          { type: "text", text: "one" },
          { type: "text", text: text },
        ],
      }),
    };
    const def = toToolDefinition(server, base) as ToolDefinition;
    const out = await def.handler({}, stubContext());
    expect(out).toContain("one\n");
    expect(out).toContain("[truncated:");
    expect(out.length).toBeLessThan(text.length + 100);
  });

  it("renders the compatibility (toolResult) payload as no content", () => {
    expect(renderToolContent({ toolResult: { anything: true } })).toBe("(no content)");
  });
});

// -- helpers -----------------------------------------------------------------

function stubContext(): Parameters<ToolDefinition["handler"]>[1] {
  return {
    cwd: "/tmp",
    permission: {} as never,
    session: {} as never,
    signal: new AbortController().signal,
  };
}

describe("truncateMcpOutput", () => {
  it("passes short text and caps long text with a visible note", () => {
    expect(truncateMcpOutput("short")).toBe("short");
    const long = "x".repeat(MAX_MCP_OUTPUT_CHARS + 5);
    const out = truncateMcpOutput(long);
    expect(out.startsWith("x".repeat(MAX_MCP_OUTPUT_CHARS))).toBe(true);
    expect(out).toContain(
      `[truncated: showing first ${MAX_MCP_OUTPUT_CHARS} of ${long.length} chars]`,
    );
  });
});
