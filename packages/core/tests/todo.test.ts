import type { SessionStore, TodoStep, ToolContext } from "@chantier/core";
import { createPermissionEngine } from "@chantier/permissions";
import { describe, expect, it } from "vitest";
import { createTodoTool, normalizeTodoSteps, summarizeTodoSteps } from "../src/todo.ts";

/** The todo tool (spec §Theme 4): whole-list replace, lenient normalization, exactly-one-in_progress. */

/** Minimal honest ToolContext: the todo handler never touches it. */
const ctx: ToolContext = {
  cwd: ".",
  session: {
    id: "todo-test",
    dir: "/tmp",
    append: async () => {},
    load: async () => [],
  } satisfies SessionStore,
  permission: createPermissionEngine({}),
  signal: new AbortController().signal,
};

describe("normalizeTodoSteps", () => {
  it("keeps well-formed rows and trims content", () => {
    expect(
      normalizeTodoSteps([
        { content: "  write tests ", status: "pending" },
        { content: "run suite", status: "in_progress" },
      ]),
    ).toEqual([
      { content: "write tests", status: "pending" },
      { content: "run suite", status: "in_progress" },
    ]);
  });

  it("drops non-object and blank-content rows", () => {
    expect(
      normalizeTodoSteps([
        "nope",
        null,
        undefined,
        3,
        { content: "   ", status: "pending" },
        {},
        { content: "real", status: "completed" },
      ]),
    ).toEqual([{ content: "real", status: "completed" }]);
  });

  it("coerces unknown statuses to pending", () => {
    expect(
      normalizeTodoSteps([
        { content: "a", status: "DONE" },
        { content: "b", status: "weird" },
        { content: "c", status: undefined },
      ]),
    ).toEqual([
      { content: "a", status: "pending" },
      { content: "b", status: "pending" },
      { content: "c", status: "pending" },
    ]);
  });

  it("keeps exactly one in_progress: the first keeps the slot, extras become pending", () => {
    expect(
      normalizeTodoSteps([
        { content: "first", status: "in_progress" },
        { content: "second", status: "in_progress" },
        { content: "third", status: "in_progress" },
      ]),
    ).toEqual([
      { content: "first", status: "in_progress" },
      { content: "second", status: "pending" },
      { content: "third", status: "pending" },
    ]);
  });
});

describe("createTodoTool", () => {
  it("is the readOnly todo tool with a whole-list replace handler", async () => {
    const accepted: Array<readonly TodoStep[]> = [];
    const tool = createTodoTool({ onTodo: (steps) => accepted.push(steps) });
    expect(tool.name).toBe("todo");
    expect(tool.readOnly).toBe(true);
    expect(tool.inputSchema.required).toEqual(["items"]);
    const result = await tool.handler(
      {
        items: [
          { content: "plan", status: "in_progress" },
          { content: "ship", status: "pending" },
        ],
      },
      ctx,
    );
    expect(result).toBe("todo: 0 done, 1 in progress, 1 pending");
    expect(accepted).toEqual([
      [
        { content: "plan", status: "in_progress" },
        { content: "ship", status: "pending" },
      ],
    ]);
  });

  it("an empty items array clears the checklist", async () => {
    const accepted: Array<readonly TodoStep[]> = [];
    const tool = createTodoTool({ onTodo: (steps) => accepted.push(steps) });
    const result = await tool.handler({ items: [] }, ctx);
    expect(result).toBe("todo: list cleared");
    expect(accepted).toEqual([[]]);
  });

  it("a non-array items input is an error line, not a throw", async () => {
    const tool = createTodoTool({ onTodo: () => {} });
    const result = await tool.handler({ items: "nope" }, ctx);
    expect(result).toMatch(/^Error: todo requires an `items` array/);
  });
});

describe("summarizeTodoSteps", () => {
  it("reports counts per status in fixed order", () => {
    expect(
      summarizeTodoSteps([
        { content: "a", status: "completed" },
        { content: "b", status: "completed" },
        { content: "c", status: "in_progress" },
        { content: "d", status: "pending" },
      ]),
    ).toBe("todo: 2 done, 1 in progress, 1 pending");
  });
});
