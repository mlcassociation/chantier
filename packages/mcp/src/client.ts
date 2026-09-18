import process from "node:process";
import type { ToolDefinition } from "@chantier/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { type McpServerRef, toToolDefinition } from "./adapter.ts";

/** Client identity advertised during MCP initialization. */
const CLIENT_INFO = { name: "chantier", version: "0.5.0" } as const;

/** One server entry from config (stdio, http; sse/ws are recognized but unsupported). */
export interface McpServerConfig {
  /** stdio: executable to spawn. */
  command?: string;
  args?: readonly string[];
  /** stdio: extra env merged over the parent process env. */
  env?: Readonly<Record<string, string>>;
  /** http: endpoint URL. */
  url?: string;
  /** "http" (supported), "stdio" (implied by `command`), "sse"/"ws" (skipped with a notice). */
  type?: string;
  headers?: Readonly<Record<string, string>>;
}

export interface McpConnection extends McpServerRef {
  /** Adapted tools ready to merge into the agent toolset. */
  readonly tools: readonly ToolDefinition[];
}

export interface McpConnectOptions {
  /** Spawn cwd for stdio servers; defaults to the process cwd. */
  readonly cwd?: string;
}

export interface McpConnectResult {
  readonly connections: readonly McpConnection[];
  /** One-line diagnostics: skipped servers, unsupported transports, dead spawns. */
  readonly notices: readonly string[];
}

/**
 * Connects every configured server. NEVER throws: a per-server failure is a
 * skip plus a notice, so one dead server cannot take the session down.
 */
export async function connectServers(
  servers: Readonly<Record<string, McpServerConfig>>,
  opts: McpConnectOptions = {},
): Promise<McpConnectResult> {
  const connections: McpConnection[] = [];
  const notices: string[] = [];
  for (const [name, config] of Object.entries(servers)) {
    if (config.type === "sse" || config.type === "ws") {
      notices.push(
        `server '${name}' skipped: ${config.type} transport not supported in 0.6 (use type "http")`,
      );
      continue;
    }
    let client: Client | undefined;
    try {
      const transport = createTransport(name, config, opts.cwd);
      client = new Client(CLIENT_INFO);
      await client.connect(transport);
      const tools = await collectTools({ name, client }, notices);
      connections.push({ name, client, tools });
      client = undefined; // owned by the connection now
    } catch (error) {
      // A failed connect/list leaves a live child process behind — close it.
      await client?.close().catch(() => undefined);
      notices.push(`server '${name}' skipped: ${(error as Error).message}`);
    }
  }
  return { connections, notices };
}

function createTransport(
  _name: string,
  config: McpServerConfig,
  cwd: string | undefined,
): Transport {
  if (typeof config.command === "string" && config.command.length > 0) {
    // The SDK REPLACES the child env with what it is given — always forward
    // the parent env, then layer the config's extras on top.
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) env[key] = value;
    }
    Object.assign(env, config.env);
    return new StdioClientTransport({
      command: config.command,
      args: [...(config.args ?? [])],
      env,
      // "inherit" would pollute the TUI with server stderr.
      stderr: "pipe",
      ...(cwd === undefined ? {} : { cwd }),
    });
  }
  if (typeof config.url === "string" && config.url.length > 0) {
    return new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: { headers: { ...config.headers } },
    });
  }
  throw new Error("config has neither a `command` (stdio) nor a `url` (http)");
}

async function collectTools(
  server: McpServerRef,
  notices: string[],
): Promise<readonly ToolDefinition[]> {
  const tools: ToolDefinition[] = [];
  for (const info of await listAllTools(server.client)) {
    const adapted = toToolDefinition(server, info);
    if (typeof adapted === "string") {
      notices.push(`server '${server.name}' tool '${info.name}' skipped: ${adapted}`);
      continue;
    }
    tools.push(adapted);
  }
  return tools;
}

/** Lists a connection's tools, following `nextCursor` pagination to the end. */
export async function listTools(server: McpServerRef): Promise<Tool[]> {
  return listAllTools(server.client);
}

async function listAllTools(client: Client): Promise<Tool[]> {
  const all: Tool[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await client.listTools(cursor === undefined ? undefined : { cursor });
    all.push(...page.tools);
    const next = page.nextCursor;
    if (next === undefined) break;
    cursor = next;
  }
  return all;
}

/** Closes every connection; an already-dead server must not block shutdown. */
export async function closeAll(connections: readonly McpServerRef[]): Promise<void> {
  for (const conn of connections) {
    try {
      await conn.client.close();
    } catch {
      // Closing a dead connection is a no-op, not an error path.
    }
  }
}
