import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ToolDefinition } from "@chantier/core";
import { buildTools } from "@chantier/tools";
import { describe, expect, it } from "vitest";
import { buildSystemPrompt, resolveModelProfile } from "../src/context.ts";

describe("buildSystemPrompt", () => {
  it("includes identity, tool catalog, and rules", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "chantier-ctx-"));
    const prompt = await buildSystemPrompt(cwd, buildTools());
    expect(prompt).toContain("You are chantier");
    expect(prompt).toContain("- read (read-only)");
    expect(prompt).toContain("- bash:");
    expect(prompt).toContain("# Tool usage rules");
  });

  it("concatenates AGENTS.md ancestor-first, nearest last", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "chantier-agents-"));
    const middle = path.join(root, "mid");
    const deep = path.join(middle, "deep");
    await mkdir(deep, { recursive: true });
    await writeFile(path.join(root, "AGENTS.md"), "root rule: ESM only", "utf8");
    await writeFile(path.join(middle, "AGENTS.md"), "middle rule: strict TS", "utf8");

    const prompt = await buildSystemPrompt(deep, buildTools());
    const esm = prompt.indexOf("root rule");
    const strict = prompt.indexOf("middle rule");
    expect(esm).toBeGreaterThan(-1);
    expect(strict).toBeGreaterThan(-1);
    expect(strict).toBeGreaterThan(esm); // nearer = later in context
    expect(prompt).toContain("AGENTS.md");
  });
});

describe("resolveModelProfile", () => {
  it("maps family prefixes: glm- and claude- resolve their profiles, others default", () => {
    expect(resolveModelProfile("glm-5.3-flash:cloud").name).toBe("glm");
    expect(resolveModelProfile("claude-sonnet-4-5").name).toBe("claude");
    expect(resolveModelProfile("qwen3-coder:30b").name).toBe("default");
    // prefix is "glm-", not "glm"
    expect(resolveModelProfile("glm").name).toBe("default");
    expect(resolveModelProfile("").name).toBe("default");
  });
});

describe("sectioned prompt", () => {
  it("omitted profile is byte-identical to the default profile", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "chantier-ctx-"));
    const omitted = await buildSystemPrompt(cwd, buildTools());
    const explicit = await buildSystemPrompt(cwd, buildTools(), resolveModelProfile("mistral-large"));
    expect(explicit).toBe(omitted);
  });

  it("applies the matching profile's identity to the prompt", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "chantier-ctx-"));
    const glm = await buildSystemPrompt(cwd, buildTools(), resolveModelProfile("glm-5.3-flash"));
    expect(glm).toContain("terse");
    expect(glm).toContain("strict JSON");
    expect(glm).toContain("never loop identical retries");
    expect(glm).not.toContain("You are chantier, a terminal coding agent. You work inside");

    const claude = await buildSystemPrompt(cwd, buildTools(), resolveModelProfile("claude-sonnet-4-5"));
    expect(claude).toContain("no scope creep");
    expect(claude).not.toContain("You are chantier, a terminal coding agent. You work inside");
  });

  it("renders the environment block: cwd, UTC date, branch from .git/HEAD", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "chantier-ctx-"));
    await mkdir(path.join(root, ".git"), { recursive: true });
    await writeFile(path.join(root, ".git", "HEAD"), "ref: refs/heads/feat/composer\n", "utf8");
    const prompt = await buildSystemPrompt(root, buildTools());
    expect(prompt).toContain(`- cwd: ${root}`);
    expect(prompt).toContain(`- date: ${new Date().toISOString().slice(0, 10)} (UTC)`);
    expect(prompt).toContain("- branch: feat/composer");
  });

  it("a raw-sha HEAD renders (detached); no .git anywhere omits the branch line", async () => {
    const detached = await mkdtemp(path.join(tmpdir(), "chantier-ctx-"));
    await mkdir(path.join(detached, ".git"), { recursive: true });
    await writeFile(path.join(detached, ".git", "HEAD"), `${"a".repeat(40)}\n`, "utf8");
    const detachedPrompt = await buildSystemPrompt(detached, buildTools());
    expect(detachedPrompt).toContain("- branch: (detached)");

    const plain = await mkdtemp(path.join(tmpdir(), "chantier-ctx-"));
    const prompt = await buildSystemPrompt(plain, buildTools());
    expect(prompt).not.toContain("- branch:");
    expect(prompt).toContain(`- cwd: ${plain}`);
  });

  it("keeps the fixed section order with AGENTS.md last", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "chantier-ctx-"));
    await mkdir(path.join(root, ".git"), { recursive: true });
    await writeFile(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");
    await writeFile(path.join(root, "AGENTS.md"), "root rule", "utf8");
    const prompt = await buildSystemPrompt(root, buildTools());
    const at = (marker: string) => prompt.indexOf(marker);
    expect(at("# Environment")).toBeGreaterThanOrEqual(0);
    expect(at("You are chantier")).toBeGreaterThan(at("# Environment"));
    expect(at("# Doing tasks")).toBeGreaterThan(at("You are chantier"));
    expect(at("# Permission denials")).toBeGreaterThan(at("# Doing tasks"));
    expect(at("# Available tools")).toBeGreaterThan(at("# Permission denials"));
    expect(at("# Tool usage rules")).toBeGreaterThan(at("# Available tools"));
    expect(at("# Project instructions (AGENTS.md)")).toBeGreaterThan(at("# Tool usage rules"));
  });

  it("includes the delegation section only when a tool named task is offered", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "chantier-ctx-"));
    const taskTool: ToolDefinition = {
      name: "task",
      description: "delegates a subtask.",
      inputSchema: { type: "object", properties: {} },
      readOnly: true,
      handler: async () => "ok",
    };
    const without = await buildSystemPrompt(cwd, buildTools());
    const withTask = await buildSystemPrompt(cwd, [...buildTools(), taskTool]);
    expect(without).not.toContain("# Delegating subtasks");
    expect(withTask).toContain("# Delegating subtasks");
  });
});
