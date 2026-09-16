import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  authFileMode,
  loadAuth,
  maskApiKey,
  removeProvider,
  resolveApiKey,
  saveProvider,
} from "../src/auth.ts";

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "chantier-auth-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  roots.length = 0;
});

describe("auth store", () => {
  it("round-trips save, load, resolve and remove", async () => {
    const root = await makeRoot();
    await saveProvider(root, "anthropic", "sk-ant-roundtrip-1234");
    expect(await resolveApiKey(root, "anthropic")).toBe("sk-ant-roundtrip-1234");
    const auth = await loadAuth(root);
    expect(auth.version).toBe(1);
    expect(auth.providers.anthropic?.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    await saveProvider(root, "openai-compatible", "sk-ollama-key-123456");
    expect(await removeProvider(root, "anthropic")).toBe(true);
    expect(await resolveApiKey(root, "anthropic")).toBeNull();
    expect(await resolveApiKey(root, "openai-compatible")).toBe("sk-ollama-key-123456");
    expect(await removeProvider(root, "anthropic")).toBe(false);
  });

  it("writes auth.json with mode 0600 on save, rewrite and logout", async () => {
    const root = await makeRoot();
    await saveProvider(root, "anthropic", "sk-ant-mode-check-1234");
    const file = path.join(root, "auth.json");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    await saveProvider(root, "openai-compatible", "sk-ollama-mode-check-1");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    await removeProvider(root, "anthropic");
    await removeProvider(root, "openai-compatible");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    // Logout keeps the file with empty providers.
    const kept = JSON.parse(await readFile(file, "utf8")) as {
      version: number;
      providers: Record<string, unknown>;
    };
    expect(kept).toEqual({ version: 1, providers: {} });
    expect(await authFileMode(root)).toBe(0o600);
  });

  it("tightens a pre-existing loose file on the next rewrite", async () => {
    const root = await makeRoot();
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, "auth.json"), JSON.stringify({ version: 1, providers: {} }), {
      mode: 0o644,
    });
    await saveProvider(root, "anthropic", "sk-ant-tighten-123456");
    expect((await stat(path.join(root, "auth.json"))).mode & 0o777).toBe(0o600);
  });

  it("rejects unknown providers and empty keys with clear errors", async () => {
    const root = await makeRoot();
    await expect(saveProvider(root, "openai", "k")).rejects.toThrow(
      'Unknown provider "openai". Known auth providers: anthropic, openai-compatible.',
    );
    await expect(removeProvider(root, "bedrock")).rejects.toThrow(/Unknown provider "bedrock"/);
    await expect(saveProvider(root, "anthropic", "")).rejects.toThrow(/empty API key/);
  });

  it("treats a missing file as an empty store", async () => {
    const root = await makeRoot();
    expect(await loadAuth(root)).toEqual({ version: 1, providers: {} });
    expect(await resolveApiKey(root, "anthropic")).toBeNull();
    expect(await authFileMode(root)).toBeNull();
  });

  it("rejects corrupt or malformed auth files", async () => {
    const root = await makeRoot();
    await mkdir(root, { recursive: true });
    const file = path.join(root, "auth.json");
    await writeFile(file, "not json at all");
    await expect(loadAuth(root)).rejects.toThrow(/auth\.json is not valid JSON/);
    await writeFile(file, JSON.stringify({ version: 2, providers: {} }));
    await expect(loadAuth(root)).rejects.toThrow(/unsupported version 2/);
    await writeFile(file, JSON.stringify({ version: 1, providers: { anthropic: {} } }));
    await expect(loadAuth(root)).rejects.toThrow(/non-empty "apiKey"/);
  });

  it("masks long keys and reports short ones as configured", () => {
    expect(maskApiKey("sk-ant-api03-abcdefghijklmnopqr")).toBe("sk-ant…opqr");
    expect(maskApiKey("123456789012")).toBe("123456…9012");
    expect(maskApiKey("short-key")).toBe("configured");
  });
});
