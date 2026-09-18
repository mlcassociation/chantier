import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { loadMcpConfig } from "@chantier/mcp";
import { afterEach, describe, expect, it } from "vitest";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const drop of cleanup.splice(0)) await drop();
});

describe("project .mcp.json trust split (launch-RCE gate)", () => {
  it("loads project servers separately from user servers", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "mcp-home-"));
    const project = await mkdtemp(path.join(tmpdir(), "mcp-proj-"));
    await mkdir(path.join(home, ".chantier"), { recursive: true });
    await writeFile(
      path.join(home, ".chantier", "config.json"),
      JSON.stringify({ mcpServers: { userTool: { command: "user-server" } } }),
      "utf8",
    );
    await writeFile(
      path.join(project, ".mcp.json"),
      JSON.stringify({ mcpServers: { proj: { command: "proj-server" } } }),
      "utf8",
    );
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    cleanup.push(async () => {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    });
    const config = await loadMcpConfig({ cwd: project });
    expect(Object.keys(config.projectServers)).toEqual(["proj"]);
    expect(Object.keys(config.globalServers)).toEqual(["userTool"]);
    expect(Object.keys(config.servers)).toEqual(["userTool", "proj"]);
  });
});

describe("project MCP trust gate verdicts", () => {
  it("isProjectMcpTrusted: false without a trust file, true after an 'a' persists", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "mcp-trust-home-"));
    const project = await mkdtemp(path.join(tmpdir(), "mcp-trust-proj-"));
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    cleanup.push(async () => {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    });
    const { isProjectMcpTrusted, promptProjectMcpTrust, mcpTrustFile } = await import(
      "../src/mcp-trust.ts"
    );
    expect(await isProjectMcpTrusted(project)).toBe(false);
    // "a" — the always verdict persists a per-cwd entry.
    const alwaysStream = new PassThrough();
    alwaysStream.write("a\n");
    const verdict = await promptProjectMcpTrust(
      project,
      ["proj"],
      { proj: { command: "s" } },
      alwaysStream,
    );
    expect(verdict).toBe("allow");
    expect(await isProjectMcpTrusted(project)).toBe(true);
    // The persisted key is the realpath hash — the file never stores raw paths.
    const raw = await readFile(mcpTrustFile(), "utf8");
    expect(raw).not.toContain(project);
  });

  it("'y' allows the session without persisting; 'n' denies", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "mcp-trust-home2-"));
    const project = await mkdtemp(path.join(tmpdir(), "mcp-trust-proj2-"));
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    cleanup.push(async () => {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    });
    const { isProjectMcpTrusted, promptProjectMcpTrust, mcpTrustFile } = await import(
      "../src/mcp-trust.ts"
    );
    const onceStream = new PassThrough();
    onceStream.write("y\n");
    expect(
      await promptProjectMcpTrust(project, ["proj"], { proj: { command: "s" } }, onceStream),
    ).toBe("allow");
    expect(await isProjectMcpTrusted(project)).toBe(false);
    const noStream = new PassThrough();
    noStream.write("n\n");
    expect(
      await promptProjectMcpTrust(project, ["proj"], { proj: { command: "s" } }, noStream),
    ).toBe("deny");
    const raw = await readFile(mcpTrustFile(), "utf8").catch(() => "");
    expect(raw).toBe("");
  });
});
