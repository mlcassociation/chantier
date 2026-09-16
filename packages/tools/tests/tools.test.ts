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
    expect(window).toContain("2: two");
    expect(window).toContain(
      "[truncated \u2014 showing lines 2\u20132 of 5; re-read with offset=3",
    );
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
describe("grep modes and pagination", () => {
  it("gives no-match guidance on the rg fast path instead of an empty string", async () => {
    const out = await runTool("grep", { pattern: "definitely_absent_pattern_xyz" });
    expect(out).toContain("No matches for");
    expect(out).toContain("Try");
  });

  it("files_with_matches mode returns only file paths", async () => {
    await writeFile(path.join(cwd, "hit.txt"), "waldo here\n", "utf8");
    await writeFile(path.join(cwd, "other.md"), "waldo there\n", "utf8");
    const out = await runTool("grep", {
      pattern: "waldo",
      mode: "files_with_matches",
      glob: "*.txt",
    });
    expect(out).toContain("hit.txt");
    expect(out).not.toContain("other.md");
    expect(out).not.toContain(":1:");
  });

  it("rejects an unknown mode with corrective prose", async () => {
    const out = await runTool("grep", { pattern: "x", mode: "counts" });
    expect(out).toMatch(/^Error: mode must be/);
  });

  it("paginates content results with head_limit and offset", async () => {
    const lines = Array.from({ length: 5 }, (_, i) => `match${i + 1}`);
    await writeFile(path.join(cwd, "pag.txt"), `${lines.join("\n")}\n`, "utf8");
    const first = await runTool("grep", { pattern: "match", glob: "pag.txt", head_limit: 2 });
    expect(first).toContain("pag.txt:1:match1");
    expect(first).toContain("pag.txt:2:match2");
    expect(first).toContain("[5 entries total; showing 1\u20132; re-run with offset=2");
    const next = await runTool("grep", {
      pattern: "match",
      glob: "pag.txt",
      head_limit: 2,
      offset: 2,
    });
    expect(next).toContain("pag.txt:3:match3");
    expect(next).toContain("showing 3\u20134");
    const last = await runTool("grep", {
      pattern: "match",
      glob: "pag.txt",
      head_limit: 2,
      offset: 4,
    });
    expect(last).toContain("pag.txt:5:match5");
    expect(last).not.toContain("re-run with offset");
    const past = await runTool("grep", {
      pattern: "match",
      glob: "pag.txt",
      offset: 10,
    });
    expect(past).toMatch(/offset 10 is past the end/);
  });

  it("paginates files_with_matches entries", async () => {
    await writeFile(path.join(cwd, "f1.txt"), "paged\n", "utf8");
    await writeFile(path.join(cwd, "f2.txt"), "paged\n", "utf8");
    await writeFile(path.join(cwd, "f3.txt"), "paged\n", "utf8");
    const out = await runTool("grep", {
      pattern: "paged",
      glob: "f*.txt",
      mode: "files_with_matches",
      head_limit: 2,
    });
    expect(out).toContain("entries total; showing 1\u20132");
    expect(out).toContain("re-run with offset=2");
  });
});

describe("read continuation notices", () => {
  it("appends a notice with the resume offset when the line limit cuts", async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`);
    await writeFile(path.join(cwd, "notice.txt"), lines.join("\n"), "utf8");
    const out = await runTool("read", { path: "notice.txt", limit: 5 });
    expect(out).toContain("[truncated \u2014 showing lines 1\u20135 of 10; re-read with offset=6");
    const windowed = await runTool("read", { path: "notice.txt", offset: 3, limit: 2 });
    expect(windowed).toContain("showing lines 3\u20134 of 10");
    expect(windowed).toContain("offset=5");
  });

  it("appends a notice when the char cap cuts before EOF", async () => {
    const longLine = "x".repeat(100);
    const lines = Array.from({ length: 1000 }, (_, i) => `${longLine} ${i + 1}`);
    await writeFile(path.join(cwd, "huge.txt"), lines.join("\n"), "utf8");
    const out = await runTool("read", { path: "huge.txt" });
    expect(out).toContain("[truncated \u2014 showing lines 1\u2013");
    expect(out).toContain("of 1000; re-read with offset=");
  });

  it("offset past EOF gives corrective prose", async () => {
    const out = await runTool("read", { path: "notice.txt", offset: 500 });
    expect(out).toMatch(/^Error: offset 500 is past the end/);
  });
});

describe("bash spill, workdir, and exit phrasing", () => {
  it("spills large output to a file and returns the tail", async () => {
    const out = await runTool("bash", { command: "seq 1 30000" });
    expect(out).toMatch(/full output \(\d+ chars\) saved to (.+)\.chantier\/spill\//);
    const spillPath = /saved to (\S+)\]/.exec(out)?.[1] ?? "";
    expect(spillPath.length).toBeGreaterThan(10);
    const spilled = await readFile(spillPath, "utf8");
    expect(spilled.length).toBeGreaterThan(140_000);
    expect(spilled.trimEnd().endsWith("30000")).toBe(true);
    expect(out).toContain("30000");
    expect(out.length).toBeLessThan(15_000);
    expect(out).toContain("Exit code: 0");
  });

  it("runs the command in workdir when it exists and refuses otherwise", async () => {
    await mkdir(path.join(cwd, "wd"), { recursive: true });
    await writeFile(path.join(cwd, "wd", "marker.txt"), "inside", "utf8");
    const ok = await runTool("bash", { command: "cat marker.txt", workdir: "wd" });
    expect(ok).toContain("inside");
    expect(ok).toContain("Exit code: 0");
    const missing = await runTool("bash", { command: "true", workdir: "no-such-dir" });
    expect(missing).toMatch(/^Error: workdir .* does not exist/);
    const notDir = await runTool("bash", { command: "true", workdir: "lines.txt" });
    expect(notDir).toContain("is not a directory");
  });

  it("phrases exit 1 as possibly benign", async () => {
    const out = await runTool("bash", { command: "false" });
    expect(out).toContain('Exit code: 1 (exit 1 \u2014 commonly means "no results"');
    expect(out).toContain("not necessarily an error");
  });
});

describe("edit CRLF handling", () => {
  it("round-trips CRLF files with an LF oldString via the retry", async () => {
    await writeFile(path.join(cwd, "crlf.txt"), "first\r\nsecond\r\n", "utf8");
    const out = await runTool("edit", {
      path: "crlf.txt",
      oldString: "first\nsecond",
      newString: "first\nCHANGED",
    });
    expect(out).toContain("CRLF line endings preserved");
    expect(out).toContain("LF\u2192CRLF retry");
    await expect(readFile(path.join(cwd, "crlf.txt"), "utf8")).resolves.toBe(
      "first\r\nCHANGED\r\n",
    );
  });

  it("preserves CRLF endings on a direct match too", async () => {
    await writeFile(path.join(cwd, "crlf2.txt"), "alpha\r\nbeta\r\n", "utf8");
    const out = await runTool("edit", {
      path: "crlf2.txt",
      oldString: "beta",
      newString: "beta2",
    });
    expect(out).toContain("CRLF line endings preserved");
    await expect(readFile(path.join(cwd, "crlf2.txt"), "utf8")).resolves.toBe("alpha\r\nbeta2\r\n");
  });

  it("askDetail returns a unified diff with a/ and b/ paths", async () => {
    await writeFile(path.join(cwd, "diffed.txt"), "a\nb\nc\n", "utf8");
    const edit = tools.get("edit");
    if (edit?.askDetail === undefined) throw new Error("edit tool lost askDetail");
    const detail = await edit.askDetail(
      { path: "diffed.txt", oldString: "b", newString: "B" },
      ctx,
    );
    expect(detail?.diff).toContain("--- a/diffed.txt");
    expect(detail?.diff).toContain("+++ b/diffed.txt");
    expect(detail?.diff).toContain("-b");
    expect(detail?.diff).toContain("+B");
  });

  it("askDetail diff for replaceAll shows every changed line", async () => {
    await writeFile(path.join(cwd, "twice.txt"), "x=1\ny=1\n", "utf8");
    const edit = tools.get("edit");
    if (edit?.askDetail === undefined) throw new Error("edit tool lost askDetail");
    const detail = await edit.askDetail(
      { path: "twice.txt", oldString: "1", newString: "2", replaceAll: true },
      ctx,
    );
    expect(detail?.diff).toContain("-x=1");
    expect(detail?.diff).toContain("-y=1");
    expect(detail?.diff).toContain("+x=2");
    expect(detail?.diff).toContain("+y=2");
  });

  it("askDetail returns undefined for a plan that cannot apply", async () => {
    const edit = tools.get("edit");
    if (edit?.askDetail === undefined) throw new Error("edit tool lost askDetail");
    const detail = await edit.askDetail(
      { path: "diffed.txt", oldString: "nope-not-there", newString: "z" },
      ctx,
    );
    expect(detail).toBeUndefined();
  });
});
