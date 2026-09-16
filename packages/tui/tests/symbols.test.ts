import { describe, expect, it } from "vitest";
import { approvalLabel } from "../src/app.ts";
import { ASCII_SYMBOLS, isAsciiEnv, resolveSymbols, UNICODE_SYMBOLS } from "../src/symbols.ts";

describe("resolveSymbols", () => {
  it("returns unicode symbols in normal mode", () => {
    expect(resolveSymbols(false)).toBe(UNICODE_SYMBOLS);
    expect(UNICODE_SYMBOLS.border).toBe("round");
    expect(UNICODE_SYMBOLS.hintSeparator).toBe("·");
    expect(UNICODE_SYMBOLS.ellipsis).toBe("…");
  });

  it("returns ASCII-safe symbols in ASCII mode", () => {
    expect(resolveSymbols(true)).toBe(ASCII_SYMBOLS);
    expect(ASCII_SYMBOLS.border).toBe("single");
    expect(ASCII_SYMBOLS.hintSeparator).toBe("|");
    expect(ASCII_SYMBOLS.ellipsis).toBe("...");
  });
});

describe("isAsciiEnv", () => {
  it("accepts only CHANTIER_ASCII=1", () => {
    expect(isAsciiEnv("1")).toBe(true);
    expect(isAsciiEnv(undefined)).toBe(false);
    expect(isAsciiEnv("0")).toBe(false);
    expect(isAsciiEnv("true")).toBe(false);
  });
});

describe("approvalLabel", () => {
  it("names the tool and file subject", () => {
    expect(approvalLabel("edit", { file_path: "src/app.ts" })).toBe("approve edit of src/app.ts");
    expect(approvalLabel("write", { path: "notes.md" })).toBe("approve write of notes.md");
  });

  it("falls back to the bare tool when no file-like key exists", () => {
    expect(approvalLabel("bash", { command: "ls" })).toBe("approve bash");
    expect(approvalLabel("edit", "raw string")).toBe("approve edit");
  });
});
