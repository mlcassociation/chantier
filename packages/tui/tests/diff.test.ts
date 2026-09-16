import { describe, expect, it } from "vitest";
import { classifyUnifiedDiffLine, summarizeUnifiedDiff } from "../src/diff.ts";

const FIXTURE_DIFF = [
  "diff --git a/src/hello.ts b/src/hello.ts",
  "--- a/src/hello.ts",
  "+++ b/src/hello.ts",
  "@@ -1,3 +1,4 @@",
  " function greet() {",
  '-  console.log("hi")',
  '+  console.log("hello")',
  '+  console.log("world")',
  " }",
].join("\n");

describe("classifyUnifiedDiffLine", () => {
  it("classifies header and hunk lines as meta", () => {
    for (const line of FIXTURE_DIFF.split("\n").slice(0, 4)) {
      expect(classifyUnifiedDiffLine(line)).toBe("meta");
    }
  });

  it("classifies content lines by their prefix", () => {
    expect(classifyUnifiedDiffLine('-  console.log("hi")')).toBe("del");
    expect(classifyUnifiedDiffLine('+  console.log("hello")')).toBe("add");
    expect(classifyUnifiedDiffLine(" function greet() {")).toBe("context");
    expect(classifyUnifiedDiffLine("plain text")).toBe("context");
  });
});

describe("summarizeUnifiedDiff", () => {
  it("counts additions and deletions and keeps every line under the cap", () => {
    expect(summarizeUnifiedDiff(FIXTURE_DIFF)).toEqual({
      lines: FIXTURE_DIFF.split("\n"),
      additions: 2,
      deletions: 1,
      hiddenLines: 0,
    });
  });

  it("ignores a trailing newline and handles an empty diff", () => {
    expect(summarizeUnifiedDiff("")).toEqual({
      lines: [],
      additions: 0,
      deletions: 0,
      hiddenLines: 0,
    });
    expect(summarizeUnifiedDiff("+a\n-b\n")).toEqual({
      lines: ["+a", "-b"],
      additions: 1,
      deletions: 1,
      hiddenLines: 0,
    });
  });

  it("caps displayed lines and reports the hidden tail", () => {
    const long = Array.from({ length: 14 }, (_, i) => `+line ${i + 1}`).join("\n");
    const preview = summarizeUnifiedDiff(long);
    expect(preview.lines).toHaveLength(10);
    expect(preview.lines[0]).toBe("+line 1");
    expect(preview.additions).toBe(14);
    expect(preview.hiddenLines).toBe(4);
  });

  it("respects a smaller explicit cap", () => {
    const preview = summarizeUnifiedDiff("+a\n-b\n c\n+d\n", 2);
    expect(preview.lines).toEqual(["+a", "-b"]);
    expect(preview.hiddenLines).toBe(2);
  });
});
