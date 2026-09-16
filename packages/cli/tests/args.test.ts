import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../src/args.ts";

describe("parseCliArgs", () => {
  it("parses the a11y flags", () => {
    expect(parseCliArgs(["--screen-reader", "--no-color", "-p", "fix the bug"])).toEqual({
      "screen-reader": true,
      "no-color": true,
      prompt: "fix the bug",
    });
  });

  it("parses the established flags unchanged", () => {
    expect(
      parseCliArgs(["--continue", "--yolo", "--model", "anthropic/claude-sonnet-4-5"]),
    ).toEqual({
      continue: true,
      yolo: true,
      model: "anthropic/claude-sonnet-4-5",
    });
  });

  it("throws on unknown flags (strict argv)", () => {
    expect(() => parseCliArgs(["--nonsense"])).toThrow();
  });
});
