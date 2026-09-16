import { describe, expect, it } from "vitest";
import { parseAuthArgs, parseCliArgs } from "../src/args.ts";

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

describe("parseAuthArgs", () => {
  it("accepts the auth subcommands and flags strictly", () => {
    expect(parseAuthArgs(["login", "--provider", "anthropic"])).toEqual({
      command: "login",
      provider: "anthropic",
      apiKeyFile: undefined,
      help: false,
    });
    expect(parseAuthArgs(["logout", "openai-compatible"])).toEqual({
      command: "logout",
      provider: "openai-compatible",
      apiKeyFile: undefined,
      help: false,
    });
    expect(parseAuthArgs(["status", "--api-key-file", "-"])).toEqual({
      command: "status",
      provider: undefined,
      apiKeyFile: "-",
      help: false,
    });
    expect(parseAuthArgs([])).toEqual({ command: undefined, help: false });
    expect(parseAuthArgs(["--help"])).toEqual({ command: undefined, help: true });
  });

  it("throws on unknown subcommands, flags and extra positionals", () => {
    expect(() => parseAuthArgs(["bogus"])).toThrow(/Unknown auth command "bogus"/);
    expect(() => parseAuthArgs(["login", "--nope"])).toThrow();
    expect(() => parseAuthArgs(["login", "anthropic", "extra"])).toThrow(
      /Unexpected extra argument/,
    );
    expect(() => parseAuthArgs(["status", "anthropic"])).toThrow(/takes no provider/);
    expect(() => parseAuthArgs(["login", "anthropic", "--provider", "openai-compatible"])).toThrow(
      /Conflicting provider arguments/,
    );
  });
});
