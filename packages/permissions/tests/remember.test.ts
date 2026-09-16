import { describe, expect, it } from "vitest";
import { createPermissionEngine } from "../src/engine.ts";
import { createRememberingEngine } from "../src/remember.ts";

function engine(rules: Parameters<typeof createPermissionEngine>[0]) {
  return createRememberingEngine(createPermissionEngine(rules));
}

describe("remembering engine", () => {
  it("lifts ask verdicts to allow for remembered bare tools", () => {
    const e = engine({ ask: ["write"] });
    expect(e.evaluate("write", "a.txt")).toBe("ask");
    e.remember("write");
    expect(e.evaluate("write", "a.txt")).toBe("allow");
    expect(e.evaluate("write", "b/deep/c.txt")).toBe("allow");
  });

  it("never lifts deny: deny outranks a remembered allow", () => {
    const e = engine({ deny: ["write"], allow: ["read"] });
    e.remember("write");
    expect(e.evaluate("write", "a.txt")).toBe("deny");
    expect(e.evaluate("write")).toBe("deny");
  });
  it("a remembered allow outranks explicit ask rules: user intent is fresher", () => {
    const e = engine({ ask: ["bash(edit*)"], allow: ["read"] });
    e.remember("bash");
    expect(e.evaluate("bash", "editCargo.toml")).toBe("allow");
    expect(e.evaluate("bash", "curl http://x")).toBe("allow");
    expect(e.evaluate("read", "a.ts")).toBe("allow");
  });

  it("only affects remembered tools; other asks stay ask", () => {
    const e = engine({ ask: ["write", "bash"] });
    e.remember("write");
    expect(e.evaluate("bash", "ls")).toBe("ask");
    expect(e.remembered).toEqual(["write"]);
  });

  it("read-only default behavior is untouched", () => {
    const e = engine({});
    expect(e.evaluate("read", "src/a.ts", true)).toBe("allow");
    expect(e.evaluate("write", "a.txt")).toBe("ask");
  });

  it("isRemoved delegates to the inner engine", () => {
    const e = engine({ deny: ["webfetch"] });
    e.remember("read");
    expect(e.isRemoved("webfetch")).toBe(true);
    expect(e.isRemoved("read")).toBe(false);
  });
});
