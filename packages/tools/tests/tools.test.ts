import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ToolContext } from "@chantier/core";
import { createPermissionEngine } from "@chantier/permissions";
import { beforeAll, describe, expect, it } from "vitest";
import { formatNumbered, isDenyReadPath, truncateOutput } from "../src/common.ts";
import { buildTools, htmlToText } from "../src/index.ts";

let cwd: string;
let ctx: ToolContext;
const tools = new Map(buildTools().map((tool) => [tool.name, tool]));
async function runTool(name: string, input: Record<string, unknown>): Promise<string> {
  const tool = tools.get(name);
  if (tool === undefined) throw new Error(`unknown tool ${name}`);
  return tool.handler(input, ctx);
}

beforeAll(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "chantier-tools-"));
  ctx = {
    cwd,
    session: {
      id: "test",
      dir: cwd,
      append: async () => {},
      load: async () => [],
    },
    permission: createPermissionEngine({}),
    signal: new AbortController().signal,
  };
});

describe("read", () => {
  it("returns numbered text and honors offset/limit", async () => {
    await writeFile(path.join(cwd, "lines.txt"), "one\ntwo\nthree\nfour\n", "utf8");
    const all = await runTool("read", { path: "lines.txt" });
    expect(all).toContain("1: one");
    expect(all).toContain("4: four");
    const window = await runTool("read", { path: "lines.txt", offset: 2, limit: 1 });
    expect(window).toBe("2: two");
  });

  it("lists a directory instead of erroring", async () => {
    await mkdir(path.join(cwd, "sub"), { recursive: true });
    await writeFile(path.join(cwd, "sub", "a.txt"), "x", "utf8");
    const out = await runTool("read", { path: "sub" });
    expect(out).toContain("a.txt");
  });

  it("refuses protected paths with the deny-read message", async () => {
    const out = await runTool("read", { path: ".env" });
    expect(out).toMatch(/^Error: .*protected/);
    expect(await runTool("read", { path: "id_rsa_backup" })).toMatch(/^Error: .*protected/);
  });

  it("gives corrective prose with nearby files for a missing path", async () => {
    await writeFile(path.join(cwd, "real.txt"), "x", "utf8");
    const out = await runTool("read", { path: "real.txt.bak" });
    expect(out).toMatch(/^Error: no file/);
    expect(out).toContain("real.txt");
  });
});

describe("write", () => {
  it("creates parents and reports bytes", async () => {
    const out = await runTool("write", { path: "nested/dir/new.txt", content: "hello" });
    expect(out).toContain("5 bytes");
    await expect(readFile(path.join(cwd, "nested/dir/new.txt"), "utf8")).resolves.toBe("hello");
  });

  it("refuses overwriting a >5-line file without overwrite flag", async () => {
    await writeFile(path.join(cwd, "big.txt"), "1\n2\n3\n4\n5\n6\n", "utf8");
    const refused = await runTool("write", { path: "big.txt", content: "replaced" });
    expect(refused).toMatch(/Error: .*already exists \(6 lines\)/);
    expect(refused).toContain("overwrite: true");
    const allowed = await runTool("write", {
      path: "big.txt",
      content: "replaced",
      overwrite: true,
    });
    expect(allowed).toContain("Wrote");
    await expect(readFile(path.join(cwd, "big.txt"), "utf8")).resolves.toBe("replaced");
  });
});

describe("edit", () => {
  it("replaces a unique match and reports the change", async () => {
    await writeFile(path.join(cwd, "code.ts"), "const a = 1;\nconst b = 2;\n", "utf8");
    const out = await runTool("edit", {
      path: "code.ts",
      oldString: "const b = 1;",
      newString: "const b = 9;",
    });
    expect(out).toMatch(/Error: oldString not found/);
    const ok = await runTool("edit", {
      path: "code.ts",
      oldString: "const b = 2;",
      newString: "const b = 3;",
    });
    expect(ok).toContain("replaced 1 occurrence");
    await expect(readFile(path.join(cwd, "code.ts"), "utf8")).resolves.toBe(
      "const a = 1;\nconst b = 3;\n",
    );
  });

  it("refuses ambiguous matches and offers replaceAll", async () => {
    await writeFile(path.join(cwd, "dup.txt"), "same\nsame\n", "utf8");
    const ambiguous = await runTool("edit", {
      path: "dup.txt",
      oldString: "same",
      newString: "other",
    });
    expect(ambiguous).toMatch(/appears 2 times/);
    expect(ambiguous).toContain("replaceAll: true");
    const all = await runTool("edit", {
      path: "dup.txt",
      oldString: "same",
      newString: "other",
      replaceAll: true,
    });
    expect(all).toContain("2 occurrence(s)");
  });
});

describe("bash", () => {
  it("captures output and the exit code", async () => {
    const out = await runTool("bash", { command: "echo hello; echo oops >&2; exit 3" });
    expect(out).toContain("hello");
    expect(out).toContain("oops");
    expect(out).toContain("Exit code: 3");
  });

  it("kills timed-out commands", async () => {
    const out = await runTool("bash", { command: "echo started; sleep 30", timeoutMs: 300 });
    expect(out).toContain("started");
    expect(out).toContain("killed");
    expect(out).toContain("300 ms");
  });
});

describe("glob + grep", () => {
  it("finds files and content lines", async () => {
    await writeFile(path.join(cwd, "hay.txt"), "needle here\nnothing\n", "utf8");
    const globOut = await runTool("glob", { pattern: "*.txt" });
    expect(globOut).toContain("hay.txt");
    const grepOut = await runTool("grep", { pattern: "needle", glob: "hay.txt" });
    expect(grepOut).toContain("hay.txt:1:needle here");
  });

  it("grep skips protected paths", async () => {
    await writeFile(path.join(cwd, ".env.local"), "SECRET_TOKEN=hunter2\n", "utf8");
    const out = await runTool("grep", { pattern: "SECRET_TOKEN" });
    expect(out).not.toContain("hunter2");
  });
});

describe("webfetch helpers", () => {
  it("strips HTML to text", () => {
    expect(
      htmlToText(
        "<html><script>evil()</script><body><h1>Title</h1><p>Body &amp; more</p></body></html>",
      ),
    ).toBe("Title Body & more");
  });
});

describe("common helpers", () => {
  it("deny-read covers the documented patterns", () => {
    expect(isDenyReadPath("/app/.env")).toBe(true);
    expect(isDenyReadPath("/app/.env.production")).toBe(true);
    expect(isDenyReadPath("/app/server.pem")).toBe(true);
    expect(isDenyReadPath("/home/u/.ssh/id_ed25519")).toBe(true);
    expect(isDenyReadPath("/app/src/index.ts")).toBe(false);
  });

  it("truncation appends a visible note", () => {
    const out = truncateOutput("a".repeat(10), 5);
    expect(out).toContain("[truncated:");
    expect(out.startsWith("aaaaa")).toBe(true);
  });

  it("formatNumbered windows 1-indexed lines", () => {
    expect(formatNumbered("a\nb\nc", 2, 2)).toBe("2: b\n3: c");
  });
});
