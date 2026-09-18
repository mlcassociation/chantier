import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import type { McpServerConfig } from "@chantier/mcp";

/** Where per-project MCP trust decisions are persisted ("a always" key). */
export function mcpTrustFile(): string {
  return path.join(homedir(), ".chantier", "mcp-trusted.json");
}

/** Trust-file key: a hash of the real path (mount aliases share one entry). */
export function mcpTrustKey(cwd: string): string {
  let real = cwd;
  try {
    real = realpathSync(cwd);
  } catch {
    // Unresolvable cwd: hash the literal path.
  }
  return createHash("sha256").update(real).digest("hex").slice(0, 12);
}

export async function isProjectMcpTrusted(cwd: string): Promise<boolean> {
  const raw = await readFile(mcpTrustFile(), "utf8").catch(() => undefined);
  if (raw === undefined) return false;
  try {
    const map: unknown = JSON.parse(raw);
    if (typeof map === "object" && map !== null && mcpTrustKey(cwd) in map) return true;
  } catch {
    // Malformed trust file: fall through to the prompt.
  }
  return false;
}

/**
 * Trust prompt for project .mcp.json servers, printed before the TUI mounts
 * (the sink is not available this early). "a" persists per cwd so the next
 * session in the same project is silent.
 */
export async function promptProjectMcpTrust(
  cwd: string,
  names: readonly string[],
  servers: Readonly<Record<string, McpServerConfig>>,
  input: NodeJS.ReadableStream = process.stdin,
): Promise<"allow" | "deny"> {
  const lines = names.map((name) => {
    const server = servers[name];
    if (server === undefined) return `  ${name}: (unknown)`;
    const spec =
      "command" in server
        ? `${server.command} ${(server.args ?? []).join(" ")}`.trim()
        : server.url;
    return `  ${name}: ${spec}`;
  });
  process.stderr.write(
    `mcp: this project ships ${names.length} MCP server(s):\n${lines.join("\n")}\n` +
      "load them? [y] once  [a] always for this project  [n] no — ",
  );
  const readline = createInterface({ input, output: process.stderr });
  try {
    const answer = (await readline.question("")).trim().toLowerCase();
    if (answer === "y" || answer === "a") {
      if (answer === "a") {
        const file = mcpTrustFile();
        const existing = await readFile(file, "utf8").catch(() => "{}");
        try {
          const map: Record<string, boolean> = JSON.parse(existing) as Record<string, boolean>;
          map[mcpTrustKey(cwd)] = true;
          await mkdir(path.dirname(file), { recursive: true });
          const tmp = `${file}.${process.pid}.tmp`;
          await writeFile(tmp, `${JSON.stringify(map, null, 2)}\n`, "utf8");
          await rename(tmp, file);
        } catch {
          process.stderr.write("mcp: could not persist the trust decision (this session only)\n");
        }
      }
      return "allow";
    }
    return "deny";
  } finally {
    readline.close();
  }
}
