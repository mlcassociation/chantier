import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildTools } from "@chantier/tools";
import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../src/context.ts";

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
