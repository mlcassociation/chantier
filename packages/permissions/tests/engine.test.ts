import { describe, expect, it } from "vitest";
import { createPermissionEngine } from "../src/engine.ts";
import { createAllowAllSink, createDenyAllSink } from "../src/sinks.ts";

describe("permission engine", () => {
  it("defaults to allow for readOnly tools and ask for mutating tools", () => {
    const engine = createPermissionEngine({});
    expect(engine.evaluate("read", undefined, true)).toBe("allow");
    expect(engine.evaluate("write", "x.txt", false)).toBe("ask");
    expect(engine.evaluate("write", "x.txt")).toBe("ask");
  });

  it("evaluate order is deny → ask → allow, first match wins", () => {
    const engine = createPermissionEngine({
      allow: ["write(*)"],
      ask: ["write(*)"],
      deny: ["write(secrets/*)"],
    });
    expect(engine.evaluate("write", "secrets/a.txt")).toBe("deny");
    expect(engine.evaluate("write", "src/a.txt")).toBe("ask");
  });

  it("a bare allow matches any specifier; a ** scoped deny wins", () => {
    const engine = createPermissionEngine({
      allow: ["bash"],
      deny: ["bash(curl **)"],
    });
    expect(engine.evaluate("bash", "ls -la")).toBe("allow");
    expect(engine.evaluate("bash", "curl http://x")).toBe("deny");
  });

  it("a single * under-matches across slashes and falls to the default (fail-safe)", () => {
    const engine = createPermissionEngine({
      allow: ["bash"],
      deny: ["bash(curl *)"],
    });
    expect(engine.evaluate("bash", "curl x")).toBe("deny"); // no slash: single star matches
    expect(engine.evaluate("bash", "curl http://x")).toBe("allow"); // under-match → bare allow (not deny)
    const mutating = createPermissionEngine({ deny: ["edit(src/*)"] });
    expect(mutating.evaluate("edit", "src/deep/nested.ts")).toBe("ask"); // under-match → default ask
  });

  it("allow can never override deny", () => {
    const engine = createPermissionEngine({
      deny: ["rm"],
      allow: ["rm"],
    });
    expect(engine.evaluate("rm")).toBe("deny");
  });

  it("wildcards match picomatch patterns in specifiers", () => {
    const engine = createPermissionEngine({
      allow: ["read(src/**)", "read(**/*.md)"],
    });
    expect(engine.evaluate("read", "src/deep/file.ts", true)).toBe("allow");
    expect(engine.evaluate("read", "docs/README.md", true)).toBe("allow");
    expect(engine.evaluate("read", "docs/index.html", true)).toBe("allow"); // default allow (readOnly)
    const mutating = createPermissionEngine({ allow: ["edit(src/*)"] });
    expect(mutating.evaluate("edit", "src/a.ts")).toBe("allow");
    expect(mutating.evaluate("edit", "lib/a.ts")).toBe("ask");
  });

  it("bare deny removes the tool from the model's toolset; scoped deny does not", () => {
    const engine = createPermissionEngine({
      deny: ["bash", "write(.env*)"],
    });
    expect(engine.isRemoved("bash")).toBe(true);
    expect(engine.isRemoved("write")).toBe(false);
    expect(engine.isRemoved("read")).toBe(false);
  });

  it("a scoped deny blocks a matching call with the decision", () => {
    const engine = createPermissionEngine({ deny: ["write(dist/**)"] });
    expect(engine.evaluate("write", "dist/index.js")).toBe("deny");
    expect(engine.evaluate("write", "src/index.ts")).toBe("ask");
  });

  it("rejects malformed rules with an actionable message", () => {
    expect(() => createPermissionEngine({ allow: ["bad rule!!"] })).toThrow(
      'Invalid permission rule "bad rule!!". Expected "Tool" or "Tool(specifier)" with optional * wildcards.',
    );
  });
});

describe("approval sinks", () => {
  it("DenyAllSink refuses every request (headless default)", async () => {
    const sink = createDenyAllSink();
    await expect(sink.ask({ tool: "write", input: { path: "x" } })).resolves.toEqual({
      approved: false,
      reason:
        "mutation blocked in headless mode; rerun with --yolo or add an allow rule to .chantier/settings.json",
    });
  });

  it("AllowAllSink grants every request (--yolo)", async () => {
    const sink = createAllowAllSink();
    await expect(sink.ask({ tool: "write", input: { path: "x" } })).resolves.toMatchObject({
      approved: true,
    });
  });
});
