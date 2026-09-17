import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import {
  hasMarkdownSyntax,
  markdownDivider,
  markdownToElements,
  takeSafeFlush,
} from "../src/markdown.ts";
import { UNICODE_SYMBOLS } from "../src/symbols.ts";

const SYMBOLS = UNICODE_SYMBOLS;

interface ElementLike {
  readonly props: unknown;
}

function isElementLike(node: ReactNode): node is ElementLike {
  return typeof node === "object" && node !== null && "props" in node;
}

/**
 * The react props bag of a rendered element. The compiler types `props` as
 * unknown once the `in` guard narrows; the cast is to a plain record and every
 * field is validated on read (textOf / the direct assertion reads).
 */
function propsOf(node: ReactNode): Record<string, unknown> {
  if (!isElementLike(node)) return {};
  const props = node.props as Record<string, unknown>;
  return typeof props === "object" && props !== null ? props : {};
}

function textOf(node: ReactNode): string {
  const children: unknown = propsOf(node).children;
  if (typeof children === "string") return children;
  if (Array.isArray(children)) return children.map((child) => String(child)).join("");
  return "";
}

function texts(nodes: ReactNode[]): string[] {
  return nodes.map(textOf);
}

describe("takeSafeFlush", () => {
  it("splits at the final paragraph boundary, keeping the separator in the flushed prefix", () => {
    expect(takeSafeFlush("para one\n\npara two")).toEqual({
      flushed: "para one\n\n",
      rest: "para two",
    });
  });

  it("splits at the LAST boundary across multiple paragraphs", () => {
    expect(takeSafeFlush("a\n\nb\n\nc")).toEqual({ flushed: "a\n\nb\n\n", rest: "c" });
  });

  it("flushes nothing when the buffer has no paragraph break yet", () => {
    expect(takeSafeFlush("still streaming")).toEqual({ flushed: "", rest: "still streaming" });
  });

  it("flushes a buffer that ends exactly on its trailing boundary", () => {
    expect(takeSafeFlush("para\n\n")).toEqual({ flushed: "para\n\n", rest: "" });
  });

  it("never emits a half-open fence: splits before the fence start", () => {
    expect(takeSafeFlush("para\n```js\ncode(")).toEqual({
      flushed: "para\n",
      rest: "```js\ncode(",
    });
  });

  it("keeps the whole buffer live when it is one open fence from byte 0", () => {
    expect(takeSafeFlush("```js\ncode(")).toEqual({ flushed: "", rest: "```js\ncode(" });
  });

  it("ignores blank lines inside an open fence", () => {
    expect(takeSafeFlush("```js\ncode(\n\nmore code(")).toEqual({
      flushed: "",
      rest: "```js\ncode(\n\nmore code(",
    });
  });

  it("flushes a closing fence plus trailing text once the block balances", () => {
    expect(takeSafeFlush("```js\ncode(\n```\n\nafter")).toEqual({
      flushed: "```js\ncode(\n```\n\n",
      rest: "after",
    });
  });

  it("flushes only up to the outside boundary when the tail reopens a fence", () => {
    expect(takeSafeFlush("para\n\n```js\ncode(")).toEqual({
      flushed: "para\n\n",
      rest: "```js\ncode(",
    });
  });

  it("survives the boundary straddling two streamed chunks", () => {
    // Delta 1 ends mid-boundary: its \n pairs with delta 2's leading \n.
    const first = takeSafeFlush("para one\n");
    expect(first).toEqual({ flushed: "", rest: "para one\n" });
    const second = takeSafeFlush(`${first.rest}\npara two`);
    expect(second).toEqual({ flushed: "para one\n\n", rest: "para two" });
  });

  it("survives a fence marker straddling two streamed chunks", () => {
    const first = takeSafeFlush("para\n\n```");
    expect(first).toEqual({ flushed: "para\n\n", rest: "```" });
    const second = takeSafeFlush(`${first.rest}js\ncode(`);
    expect(second).toEqual({ flushed: "", rest: "```js\ncode(" });
  });

  it("is idempotent: re-splitting the rest yields nothing new", () => {
    const first = takeSafeFlush("para one\n\npara two\n\n```js\ncode(");
    expect(takeSafeFlush(first.rest)).toEqual({ flushed: "", rest: first.rest });
    const drained = takeSafeFlush("tail");
    expect(takeSafeFlush(drained.rest)).toEqual({ flushed: "", rest: "tail" });
  });

  it("handles an empty buffer", () => {
    expect(takeSafeFlush("")).toEqual({ flushed: "", rest: "" });
  });
});

describe("hasMarkdownSyntax fast path", () => {
  it("rejects plain prose", () => {
    expect(hasMarkdownSyntax("just a plain sentence, no blocks here.")).toBe(false);
    expect(hasMarkdownSyntax("line one\nline two\nline three")).toBe(false);
  });

  it("accepts the styled block starts", () => {
    expect(hasMarkdownSyntax("# Title")).toBe(true);
    expect(hasMarkdownSyntax("```js\nx")).toBe(true);
    expect(hasMarkdownSyntax("- item")).toBe(true);
    expect(hasMarkdownSyntax("1. item")).toBe(true);
    expect(hasMarkdownSyntax("---")).toBe(true);
    expect(hasMarkdownSyntax("| a | b |\n| --- |")).toBe(true);
  });

  it("ignores triggers beyond the 500-char window", () => {
    const plain = "word ".repeat(120); // 600 chars of prose
    expect(hasMarkdownSyntax(`${plain}\n# late heading`)).toBe(false);
  });
});

describe("markdownToElements", () => {
  it("renders plain paragraphs without any block styling (fast path)", () => {
    const nodes = markdownToElements("just prose\nsecond line", SYMBOLS, false);
    expect(texts(nodes)).toEqual(["just prose", "second line"]);
    for (const node of nodes) {
      expect(propsOf(node).bold).toBeUndefined();
      expect(propsOf(node).dimColor).toBeUndefined();
    }
  });

  it("renders headings bold", () => {
    const nodes = markdownToElements("## Plan\nbody", SYMBOLS, false);
    expect(texts(nodes)).toEqual(["Plan", "body"]);
    expect(propsOf(nodes[0]).bold).toBe(true);
    expect(propsOf(nodes[1]).bold).toBeUndefined();
  });

  it("indents list items and keeps their markers", () => {
    const nodes = markdownToElements("- alpha\n- beta\n1. first\n2. second", SYMBOLS, false);
    expect(texts(nodes)).toEqual(["  - alpha", "  - beta", "  1. first", "  2. second"]);
  });

  it("renders closed fences dim with a 2-space indent and strips ANSI", () => {
    const nodes = markdownToElements(
      "```js\n\u001B[31mred\u001B[0m line\nplain\n```",
      SYMBOLS,
      false,
    );
    expect(texts(nodes)).toEqual(["  red line", "  plain"]);
    expect(propsOf(nodes[0]).dimColor).toBe(true);
    expect(propsOf(nodes[1]).dimColor).toBe(true);
    // The fence markers themselves are not rendered.
    expect(texts(nodes)).not.toContain("```");
  });

  it("renders an unclosed fence as plain text (tolerant streaming)", () => {
    const nodes = markdownToElements("```js\ncode(", SYMBOLS, false);
    expect(texts(nodes)).toEqual(["code("]);
    expect(propsOf(nodes[0]).dimColor).toBeUndefined();
  });

  it("renders a rule as a dim divider row", () => {
    const nodes = markdownToElements("above\n\n---\n\nbelow", SYMBOLS, false);
    expect(texts(nodes)).toEqual(["above", "\u2500".repeat(40), "below"]);
    expect(propsOf(nodes[1]).dimColor).toBe(true);
  });

  it("renders tables as space-aligned rows and drops the separator", () => {
    const nodes = markdownToElements(
      "| tool | count |\n| --- | --- |\n| read | 12 |\n| edit | 3 |",
      SYMBOLS,
      false,
    );
    expect(texts(nodes)).toEqual(["tool  count", "read  12   ", "edit  3    "]);
  });

  it("drops blank lines instead of emitting empty Static rows", () => {
    const nodes = markdownToElements("para one\n\n\n\npara two", SYMBOLS, false);
    expect(texts(nodes)).toEqual(["para one", "para two"]);
  });

  it("screen-reader mode returns plain labeled text with no styling", () => {
    const nodes = markdownToElements("## Title\n\n```js\nx()\n```\n- item", SYMBOLS, true);
    expect(texts(nodes)).toEqual(["Title", "  x()", "  - item"]);
    for (const node of nodes) {
      expect(propsOf(node).bold).toBeUndefined();
      expect(propsOf(node).dimColor).toBeUndefined();
    }
  });

  it("markdownDivider wraps text in rules visually and stays plain for screen readers", () => {
    const visual = markdownDivider("context compacted", SYMBOLS, false);
    expect(textOf(visual)).toBe(`\u2500`.repeat(40) + " context compacted " + `\u2500`.repeat(40));
    expect(propsOf(visual).dimColor).toBe(true);
    const sr = markdownDivider("context compacted", SYMBOLS, true);
    expect(textOf(sr)).toBe("context compacted");
  });
});
