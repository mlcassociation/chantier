import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type AgentEvent,
  type Message,
  type ModelAdapter,
  type ModelEvent,
  runAgent,
  type SubagentDeps,
  type ToolContext,
} from "@chantier/core";
import { createDenyAllSink, createPermissionEngine } from "@chantier/permissions";
import { describe, expect, it } from "vitest";
import { buildTools, createTaskTool } from "../src/index.ts";

/** Scripted child adapter (the fake ModelAdapter shape used by core's tests). */
function scriptedChild(turns: ModelEvent[][]): ModelAdapter & { calls: number } {
  let index = 0;
  return {
    calls: 0,
    async *stream() {
      this.calls += 1;
      const events = turns[index] ?? [];
      index += 1;
      for (const event of events) yield event;
    },
  } as ModelAdapter & { calls: number };
}

function baseDeps(adapter: ModelAdapter): SubagentDeps {
  return {
    adapter,
    rules: {},
    sink: createDenyAllSink(),
    provider: "ollama",
    model: "test-model",
    tools: buildTools(),
  };
}

function ctxFor(cwd: string): ToolContext {
  return {
    cwd,
    session: { id: "parent", dir: cwd, append: async () => {}, load: async () => [] },
    permission: createPermissionEngine({}),
    signal: new AbortController().signal,
  };
}

async function tempCwd(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "chantier-task-"));
}

describe("task tool", () => {
  it("exposes the delegation schema: prompt required, readOnly false, bare tool name", () => {
    const tool = createTaskTool(baseDeps(scriptedChild([])));
    expect(tool.name).toBe("task");
    expect(tool.readOnly).toBe(false);
    expect(tool.specifier).toBeUndefined();
    expect(tool.inputSchema.required).toEqual(["prompt"]);
    expect(Object.keys(tool.inputSchema.properties)).toEqual(["prompt", "context"]);
    expect(tool.description).toMatch(/self-contained/u);
    expect(tool.description).toMatch(/delegat/iu);
  });

  it("runs the child and appends the child session id to the summary", async () => {
    const cwd = await tempCwd();
    const child = scriptedChild([
      [
        { type: "text-delta", text: "Did the thing." },
        { type: "finish", stopReason: "end_turn" },
      ],
    ]);
    const tool = createTaskTool(baseDeps(child));
    const output = await tool.handler({ prompt: "Do the thing." }, ctxFor(cwd));
    expect(output.startsWith("Did the thing.")).toBe(true);
    expect(output).toMatch(/\(subagent session: \S+\)$/u);
    expect(child.calls).toBe(1);
  });

  it("composes the optional context into the child's user message", async () => {
    const cwd = await tempCwd();
    let childUserText: string | undefined;
    const child: ModelAdapter = {
      async *stream(messages: Message[]) {
        for (const message of messages) {
          if (message.role === "user") {
            childUserText = message.content.map((block) => block.text).join("");
          }
        }
        yield { type: "finish", stopReason: "end_turn" };
      },
    };
    const tool = createTaskTool({ ...baseDeps(child), tools: [] });
    await tool.handler({ prompt: "Do X.", context: "The repo lives at /w." }, ctxFor(cwd));
    expect(childUserText).toBe("Do X.\n\n# Context\n\nThe repo lives at /w.");
  });

  it("answers a missing prompt argument without spawning a child", async () => {
    const cwd = await tempCwd();
    const child = scriptedChild([]);
    const tool = createTaskTool(baseDeps(child));
    const output = await tool.handler({}, ctxFor(cwd));
    expect(output).toContain("the `prompt` argument is required");
    expect(child.calls).toBe(0);
  });

  it("stays out of buildTools(): the builtin child set contains no task tool", () => {
    expect(buildTools().some((tool) => tool.name === "task")).toBe(false);
  });

  it("a bare deny rule removes task from the parent's model-facing toolset", async () => {
    const cwd = await tempCwd();
    const child = scriptedChild([]);
    const seenToolsets: string[][] = [];
    const parent: ModelAdapter = {
      async *stream(_messages, tools) {
        seenToolsets.push(tools.map((tool) => tool.name));
        yield { type: "tool-call", id: "t1", name: "task", args: { prompt: "recurse" } };
        yield { type: "finish", stopReason: "end_turn" };
      },
    };
    const events: AgentEvent[] = [];
    for await (const event of runAgent({
      adapter: parent,
      tools: [...buildTools(), createTaskTool(baseDeps(child))],
      permission: createPermissionEngine({ deny: ["task"] }),
      sink: createDenyAllSink(),
      session: { id: "parent", dir: cwd, append: async () => {}, load: async () => [] },
      cwd,
      system: "system",
      messages: [],
      signal: new AbortController().signal,
    })) {
      events.push(event);
    }
    expect(seenToolsets[0]).not.toContain("task"); // isRemoved filtering works
    expect(child.calls).toBe(0); // removed before any child could spawn
    // Even a hallucinated call is denied by rules, never executed.
    const denial = events.find(
      (event) => event.type === "tool-result" && event.toolName === "task",
    );
    expect(denial?.type === "tool-result" && denial.content).toContain(
      "denied by permission rules",
    );
  });
});
