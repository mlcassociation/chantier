import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import type { ToolDefinition } from "@chantier/core";
import { afterEach, describe, expect, it } from "vitest";
import { closeAll, connectServers, listTools, type McpConnection } from "../src/client.ts";

const SERVER_SCRIPT = path.join(import.meta.dirname, "helpers", "fake-server.mjs");

/** Connections to close after each test (spawned stdio servers). */
const connections: McpConnection[] = [];

afterEach(async () => {
  await closeAll(connections);
  connections.length = 0;
});

function stubContext(): Parameters<ToolDefinition["handler"]>[1] {
  return {
    cwd: "/tmp",
    permission: {} as never,
    session: {} as never,
    signal: new AbortController().signal,
  };
}

describe("connectServers against a real stdio MCP server", () => {
  it("lists tools, adapts names, and forwards env", async () => {
    const { connections: found, notices } = await connectServers(
      {
        fake: {
          command: process.execPath,
          args: [SERVER_SCRIPT],
          env: { CUSTOM_PROBE: "hello-env" },
        },
      },
      { cwd: await mkdtemp(path.join(tmpdir(), "chantier-mcp-")) },
    );
    expect(notices).toEqual([]);
    expect(found).toHaveLength(1);
    const conn = found[0];
    if (conn === undefined) throw new Error("connection missing");
    connections.push(conn);

    expect(conn.tools.map((tool) => tool.name)).toEqual([
      "mcp__fake__echo",
      "mcp__fake__probe",
      "mcp__fake__boom",
    ]);
    const echo = conn.tools[0] as ToolDefinition;
    expect(echo.readOnly).toBe(true);
    const probe = conn.tools[1] as ToolDefinition;
    // env REPLACES the SDK default: the parent env plus config extras reach the child.
    expect(probe.description).toBe("probe=hello-env");
  });

  it("calls tools through the adapter and passes isError results through in-band", async () => {
    const { connections: found } = await connectServers({
      fake: { command: process.execPath, args: [SERVER_SCRIPT] },
    });
    const conn = found[0];
    if (conn === undefined) throw new Error("connection missing");
    connections.push(conn);
    const echo = conn.tools[0] as ToolDefinition;
    const boom = conn.tools[2] as ToolDefinition;
    await expect(echo.handler({ text: "hi" }, stubContext())).resolves.toBe("echo: hi");
    // In-band error: still a normal string result, session keeps running.
    await expect(boom.handler({}, stubContext())).resolves.toBe("boom failed");
  });

  it("re-lists raw tools through the public listTools seam", async () => {
    const { connections: found } = await connectServers({
      fake: { command: process.execPath, args: [SERVER_SCRIPT] },
    });
    const conn = found[0];
    if (conn === undefined) throw new Error("connection missing");
    connections.push(conn);
    const raw = await listTools(conn);
    expect(raw).toHaveLength(3);
    expect(raw.map((tool) => tool.name)).toEqual(["echo", "probe", "boom"]);
  });
});

describe("connectServers failure isolation", () => {
  it("never throws: a dead command is a skip plus a notice", async () => {
    const { connections: found, notices } = await connectServers({
      dead: { command: "definitely-not-a-real-binary-xyz" },
      fake: { command: process.execPath, args: [SERVER_SCRIPT] },
    });
    expect(found).toHaveLength(1);
    expect(found[0]?.name).toBe("fake");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("dead");
  });

  it("skips sse/ws transports and config without command/url", async () => {
    const { connections: found, notices } = await connectServers({
      legacy: { type: "sse", url: "https://example.com/sse" },
      oldws: { type: "ws", url: "wss://example.com/ws" },
      empty: {},
      fake: { command: process.execPath, args: [SERVER_SCRIPT] },
    });
    expect(found).toHaveLength(1);
    const joined = notices.join("\n");
    expect(joined).toContain("sse transport not supported");
    expect(joined).toContain("ws transport not supported");
    expect(joined).toContain("'empty'");
  });
});
