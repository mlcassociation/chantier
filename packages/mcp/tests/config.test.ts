import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadMcpConfig } from "../src/config.ts";

// The global config path resolves through os.homedir() ($HOME); redirect it
// for the whole file so tests never read the operator's real config.
const home = await mkdtemp(path.join(tmpdir(), "chantier-mcp-home-"));
const savedHome = process.env.HOME;

beforeEach(async () => {
  process.env.HOME = home;
  // Each test starts from a clean global config.
  await rm(path.join(home, ".chantier"), { recursive: true, force: true });
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  delete process.env.CHANTIER_MCP_PROBE;
});

async function writeGlobal(json: string): Promise<string> {
  await mkdir(path.join(home, ".chantier"), { recursive: true });
  const file = path.join(home, ".chantier", "config.json");
  await writeFile(file, json, "utf8");
  return file;
}

function projectDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "chantier-mcp-proj-"));
}

describe("loadMcpConfig", () => {
  it("returns no servers and no notices when nothing exists", async () => {
    const cwd = await projectDir();
    const result = await loadMcpConfig({ cwd });
    expect(result.servers).toEqual({});
    expect(result.notices).toEqual([]);
  });

  // biome-ignore lint/suspicious/noTemplateCurlyInString: testing ${VAR} expansion, not interpolation
  it("reads the project .mcp.json (Claude Code shape) and expands ${VAR:-default}", async () => {
    const cwd = await projectDir();
    await writeFile(
      path.join(cwd, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          local: {
            command: "npx",
            // biome-ignore lint/suspicious/noTemplateCurlyInString: testing ${VAR} expansion, not interpolation
            args: ["-y", "srv", "${CHMCP_TOKEN:-fallback}", "${CHMCP_EMPTY:-def}"],
          },
          remote: {
            type: "http",
            url: "https://example.com/mcp",
            // biome-ignore lint/suspicious/noTemplateCurlyInString: testing ${VAR} expansion, not interpolation
            headers: { Authorization: "Bearer ${CHMCP_TOKEN}" },
          },
        },
      }),
      "utf8",
    );
    process.env.CHMCP_EMPTY = "";
    const result = await loadMcpConfig({ cwd });
    expect(result.notices).toEqual([]);
    const local = result.servers.local;
    expect(local?.command).toBe("npx");
    expect(local?.args).toEqual(["-y", "srv", "fallback", "def"]);
    // POSIX ${VAR:-default}: default wins when the var is set but empty.
    expect(result.servers.remote?.headers?.Authorization).toBe("Bearer ");
  });

  it("expands a set variable over the default", async () => {
    process.env.CHMCP_TOKEN = "secret";
    const cwd = await projectDir();
    await writeFile(
      path.join(cwd, ".mcp.json"),
      JSON.stringify({
        // biome-ignore lint/suspicious/noTemplateCurlyInString: testing ${VAR} expansion, not interpolation
        mcpServers: { remote: { type: "http", url: "https://example.com/${CHMCP_TOKEN}/mcp" } },
      }),
      "utf8",
    );
    const result = await loadMcpConfig({ cwd });
    expect(result.servers.remote?.url).toBe("https://example.com/secret/mcp");
  });

  it("accepts the global {servers} and {mcpServers} spellings and a bare record", async () => {
    await writeGlobal(
      JSON.stringify({
        provider: "ollama",
        mcpServers: { fromMcpServers: { command: "a" } },
      }),
    );
    const first = await loadMcpConfig({ cwd: await projectDir() });
    expect(first.servers.fromMcpServers?.command).toBe("a");

    await writeGlobal(JSON.stringify({ servers: { fromServers: { url: "https://x" } } }));
    const second = await loadMcpConfig({ cwd: await projectDir() });
    expect(second.servers.fromServers?.url).toBe("https://x");

    await writeGlobal(JSON.stringify({ bare: { command: "b" } }));
    const third = await loadMcpConfig({ cwd: await projectDir() });
    expect(third.servers.bare?.command).toBe("b");

    // A config.json without server-shaped values contributes nothing.
    await writeGlobal(JSON.stringify({ provider: "ollama", model: "glm-5.3-flash:cloud" }));
    const fourth = await loadMcpConfig({ cwd: await projectDir() });
    expect(fourth.servers).toEqual({});
    expect(fourth.notices).toEqual([]);
  });

  it("project entries win on name collisions with a notice", async () => {
    await writeGlobal(JSON.stringify({ mcpServers: { clash: { command: "global" } } }));
    const cwd = await projectDir();
    await writeFile(
      path.join(cwd, ".mcp.json"),
      JSON.stringify({ mcpServers: { clash: { command: "project" } } }),
      "utf8",
    );
    const result = await loadMcpConfig({ cwd });
    expect(result.servers.clash?.command).toBe("project");
    expect(result.notices.join("\n")).toContain("clash");
  });

  it("skips invalid server entries and invalid JSON with notices", async () => {
    const cwd = await projectDir();
    await writeFile(
      path.join(cwd, ".mcp.json"),
      JSON.stringify({ mcpServers: { good: { command: "ok" }, bad: { nonsense: true } } }),
      "utf8",
    );
    const result = await loadMcpConfig({ cwd });
    expect(Object.keys(result.servers)).toEqual(["good"]);
    expect(result.notices.join("\n")).toContain("'bad'");

    const broken = await projectDir();
    await writeFile(path.join(broken, ".mcp.json"), "{not json", "utf8");
    const bad = await loadMcpConfig({ cwd: broken });
    expect(bad.servers).toEqual({});
    expect(bad.notices.join("\n")).toContain("invalid JSON");
  });

  it("notices a project .mcp.json without mcpServers", async () => {
    const cwd = await projectDir();
    await writeFile(path.join(cwd, ".mcp.json"), JSON.stringify({ other: true }), "utf8");
    const result = await loadMcpConfig({ cwd });
    expect(result.servers).toEqual({});
    expect(result.notices.join("\n")).toContain("no mcpServers key");
  });
});
