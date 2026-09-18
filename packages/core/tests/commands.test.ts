import { describe, expect, it } from "vitest";
import { type CommandIo, createCommandRegistry, type RegistrableCommand } from "../src/commands.ts";

/**
 * The slash-command registry (spec §Theme 3): registration rules, stable
 * list order, and the dispatch seam — actions dispatch on the exact bare
 * form only, expand commands rewrite the task, unknown slash words are
 * not-command (they reach the agent verbatim).
 */

function makeIo(): CommandIo & { pushed: Array<{ kind: string; text: string }> } {
  const pushed: Array<{ kind: string; text: string }> = [];
  const signal = new AbortController().signal;
  return {
    signal,
    pushItem: (item) => pushed.push(item),
    pushed,
  };
}

describe("createCommandRegistry — registration", () => {
  it("list() returns specs in registration order", () => {
    const registry = createCommandRegistry();
    registry.register({ name: "compact", description: "compact", kind: "action" });
    registry.register({
      name: "alpha",
      description: "a skill",
      kind: "expand",
      expand: (args) => args,
    });
    expect(registry.list().map((spec) => spec.name)).toEqual(["compact", "alpha"]);
  });

  it("rejects invalid names, duplicates, and expand specs without a function", () => {
    const registry = createCommandRegistry();
    expect(() => registry.register({ name: "", description: "d", kind: "action" })).toThrow(
      /Invalid command name/,
    );
    expect(() =>
      registry.register({ name: "No-Dashes", description: "d", kind: "action" }),
    ).toThrow(/Invalid command name/);
    expect(() => registry.register({ name: "a--b", description: "d", kind: "action" })).toThrow(
      /Invalid command name/,
    );
    registry.register({ name: "demo", description: "d", kind: "expand", expand: (args) => args });
    expect(() =>
      registry.register({
        name: "demo",
        description: "d2",
        kind: "expand",
        expand: (args) => args,
      }),
    ).toThrow(/already registered/);
    // The runtime guard exists for callers bypassing the TS types (plain JS),
    // so the malformed spec is deliberately fed through a type hole.
    const malformed: { name: string; description: string; kind: string } = {
      name: "other",
      description: "d",
      kind: "expand",
    };
    expect(() => registry.register(malformed as unknown as RegistrableCommand)).toThrow(
      /requires an expand function/,
    );
  });
});

describe("createCommandRegistry — dispatch", () => {
  it("a task not starting with slash is not-command", async () => {
    const io = makeIo();
    const result = await createCommandRegistry().dispatch("fix the bug", io);
    expect(result).toEqual({ kind: "not-command" });
    expect(io.pushed).toEqual([]);
  });
  it("an unknown slash word is not-command (reaches the agent verbatim)", async () => {
    const io = makeIo();
    const result = await createCommandRegistry().dispatch("/nope with args", io);
    expect(result).toEqual({ kind: "not-command" });
  });

  it("an action dispatches on the exact bare form and runs with the io", async () => {
    const registry = createCommandRegistry();
    const ran: Array<string> = [];
    registry.register({
      name: "compact",
      description: "compact",
      kind: "action",
      run: (io) => {
        ran.push(io.signal ? "ran" : "ran");
        io.pushItem({ kind: "info", text: "compacted" });
      },
    });
    const io = makeIo();
    const result = await registry.dispatch("  /compact  ", io);
    expect(result).toEqual({ kind: "handled" });
    expect(ran).toEqual(["ran"]);
    expect(io.pushed).toEqual([{ kind: "info", text: "compacted" }]);
  });

  it("an action with args is not-command (the /compact with-args rule)", async () => {
    const registry = createCommandRegistry();
    let ran = false;
    registry.register({
      name: "compact",
      description: "compact",
      kind: "action",
      run: () => {
        ran = true;
      },
    });
    const result = await registry.dispatch("/compact extra words", makeIo());
    expect(result).toEqual({ kind: "not-command" });
    expect(ran).toBe(false);
  });

  it("an expand command receives the remaining text as args and rewrites the task", async () => {
    const registry = createCommandRegistry();
    registry.register({
      name: "demo",
      description: "demo skill",
      kind: "expand",
      expand: (args) => `body\n\nARGUMENTS: ${args}`,
    });
    const result = await registry.dispatch("/demo write tests first", makeIo());
    expect(result).toEqual({ kind: "expanded", task: "body\n\nARGUMENTS: write tests first" });
  });

  it("an expand command with no args receives the empty string", async () => {
    const registry = createCommandRegistry();
    registry.register({
      name: "demo",
      description: "d",
      kind: "expand",
      expand: (args) => `args<${args}>`,
    });
    const result = await registry.dispatch("/demo", makeIo());
    expect(result).toEqual({ kind: "expanded", task: "args<>" });
  });

  it("awaits async expand bodies (skill file loads)", async () => {
    const registry = createCommandRegistry();
    registry.register({
      name: "slow",
      description: "d",
      kind: "expand",
      expand: async (args) => {
        const { promise, resolve } = Promise.withResolvers<string>();
        queueMicrotask(() => resolve(`loaded ${args}`));
        return promise;
      },
    });
    const result = await registry.dispatch("/slow now", makeIo());
    expect(result).toEqual({ kind: "expanded", task: "loaded now" });
  });
});
