import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { z } from "zod";
import type { McpServerConfig } from "./client.ts";
import { isRecord } from "./guard.ts";

const ServerConfigSchema = z
  .object({
    command: z.string().min(1).optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    url: z.string().min(1).optional(),
    type: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
  })
  .refine((config) => config.command !== undefined || config.url !== undefined, {
    message: "needs a `command` (stdio) or a `url` (http)",
  });

type ServerConfig = z.infer<typeof ServerConfigSchema>;

export interface McpConfigOptions {
  /** Project root holding `.mcp.json`; defaults to the process cwd. */
  readonly cwd?: string;
}

export interface McpConfigResult {
  readonly servers: Readonly<Record<string, McpServerConfig>>;
  /** Servers from the project .mcp.json — trust-gated before connecting. */
  readonly projectServers: Readonly<Record<string, McpServerConfig>>;
  /** Servers from the user's ~/.chantier/config.json — never gated. */
  readonly globalServers: Readonly<Record<string, McpServerConfig>>;
  readonly notices: readonly string[];
}

/**
 * Merges the global `~/.chantier/config.json` server map (accepting the
 * `{"mcpServers": …}`, `{"servers": …}`, and bare name→server spellings)
 * with the project `.mcp.json` (Claude Code shape: top-level `mcpServers`).
 * Project entries win on name collisions. `${VAR}` / `${VAR:-default}`
 * expansion applies to every string field; missing files contribute nothing.
 */
export async function loadMcpConfig(opts: McpConfigOptions = {}): Promise<McpConfigResult> {
  const notices: string[] = [];
  const globalServers = await readGlobalServers(notices);
  const projectServers = await readProjectServers(opts.cwd ?? process.cwd(), notices);
  const servers: Record<string, McpServerConfig> = { ...globalServers, ...projectServers };
  for (const name of Object.keys(projectServers)) {
    if (name in globalServers) {
      notices.push(`server '${name}' defined in global and project config; project wins`);
    }
  }
  return { servers, projectServers, globalServers, notices };
}

async function readGlobalServers(notices: string[]): Promise<Record<string, McpServerConfig>> {
  const file = path.join(homedir(), ".chantier", "config.json");
  const raw = await readJsonObject(file, notices);
  if (raw === undefined) return {};
  if (isRecord(raw.mcpServers)) return parseServerMap(file, raw.mcpServers, notices);
  if (isRecord(raw.servers)) return parseServerMap(file, raw.servers, notices);
  // Bare spelling: a plain name→server record. Only taken when EVERY value
  // is a server config, so the shared config.json (provider/model keys)
  // without MCP servers contributes nothing.
  const entries = Object.entries(raw);
  if (
    entries.length > 0 &&
    entries.every(([, value]) => ServerConfigSchema.safeParse(value).success)
  ) {
    return parseServerMap(file, raw, notices);
  }
  return {};
}

async function readProjectServers(
  cwd: string,
  notices: string[],
): Promise<Record<string, McpServerConfig>> {
  const file = path.join(cwd, ".mcp.json");
  const raw = await readJsonObject(file, notices);
  if (raw === undefined) return {};
  if (!isRecord(raw.mcpServers)) {
    notices.push(`${file}: no mcpServers key, skipped`);
    return {};
  }
  return parseServerMap(file, raw.mcpServers, notices);
}

function parseServerMap(
  file: string,
  raw: unknown,
  notices: string[],
): Record<string, McpServerConfig> {
  if (!isRecord(raw)) {
    notices.push(`${file}: mcpServers must be an object, skipped`);
    return {};
  }
  const out: Record<string, McpServerConfig> = {};
  for (const [name, value] of Object.entries(raw)) {
    const checked = ServerConfigSchema.safeParse(value);
    if (!checked.success) {
      const issue = checked.error.issues[0];
      notices.push(
        `${file}: server '${name}' skipped: ${issue === undefined ? "not a server config" : `${issue.path.join(".") || "config"} ${issue.message}`}`,
      );
      continue;
    }
    out[name] = expandServer(checked.data);
  }
  return out;
}

async function readJsonObject(
  file: string,
  notices: string[],
): Promise<Record<string, unknown> | undefined> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return undefined; // missing or unreadable file contributes nothing
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    notices.push(`${file}: invalid JSON, skipped (${(error as Error).message})`);
    return undefined;
  }
  if (!isRecord(parsed)) {
    notices.push(`${file}: expected a JSON object, skipped`);
    return undefined;
  }
  return parsed;
}

/** POSIX-ish `${VAR}` → env (unset becomes "") and `${VAR:-default}` → env or default. */
const VAR_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)(:-([^}]*))?\}/g;

function expandString(raw: string): string {
  return raw.replace(
    VAR_PATTERN,
    (_match: string, name: string, _group: string | undefined, fallback: string | undefined) => {
      const value = process.env[name];
      return value === undefined || value.length === 0 ? (fallback ?? "") : value;
    },
  );
}

function expandServer(config: ServerConfig): ServerConfig {
  const out: ServerConfig = {};
  if (config.command !== undefined) out.command = expandString(config.command);
  if (config.args !== undefined) out.args = config.args.map((entry) => expandString(entry));
  if (config.env !== undefined) {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(config.env)) env[key] = expandString(value);
    out.env = env;
  }
  if (config.url !== undefined) out.url = expandString(config.url);
  if (config.type !== undefined) out.type = expandString(config.type);
  if (config.headers !== undefined) {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(config.headers)) headers[key] = expandString(value);
    out.headers = headers;
  }
  return out;
}
