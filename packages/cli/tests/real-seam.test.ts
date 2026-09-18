import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "@chantier/core";
import { createSessionStore, type SessionStore } from "@chantier/core";
import { createPermissionEngine, createRememberingEngine } from "@chantier/permissions";
import { buildTools } from "@chantier/tools";
import { createTuiStore } from "@chantier/tui";
import { afterEach, describe, expect, it } from "vitest";
import { scriptedAdapter } from "../../core/tests/helpers/scripted.ts";
import { driveAgent, type InteractiveDeps } from "../src/interactive.ts";

/**
 * REAL-seam coverage: the loop tests mock @chantier/tui, so the merged
 * driveAgent → real store → real markdown flush seam had no automated test —
 * the PTY demo was the only gate. No vi.mock here: the real store is exercised
 * end to end with a scripted adapter.
 */

const cleanups: Array<() => void> = [];

async function makeDeps(adapter: InteractiveDeps["adapter"]): Promise<InteractiveDeps> {
  const cwd = await mkdtemp(join(tmpdir(), "chantier-seam-"));
  const session: SessionStore = await createSessionStore({
    cwd,
    provider: "test",
    model: "test-model",
  });
  cleanups.push(() => void session);
  return {
    adapter,
    tools: buildTools(),
    permission: createRememberingEngine(createPermissionEngine({ allow: [], ask: [], deny: [] })),
    session,
    cwd,
    system: "test system prompt",
    messages: [],
  };
}

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

describe("driveAgent against the real TUI store (no mocks)", () => {
  it("lands flushed markdown as an item and keeps the remainder live (BUG-2 seam)", async () => {
    const adapter = scriptedAdapter([
      [
        { type: "text-delta", text: "hello\n\nworld" },
        { type: "finish", stopReason: "end_turn" },
      ],
    ]);
    const store = createTuiStore({ onAbort: () => {} });
    const deps = await makeDeps(adapter);
    const outcome = await driveAgent(
      store,
      deps,
      {
        ask: async () => ({ approved: true }),
      },
      "summarize",
      new AbortController().signal,
    );
    expect(outcome).toBe("done");
    // The flushed prefix is a markdown item; the tail (no trailing boundary
    // yet) stays the live region until the run end flushes it.
    const markdown = store.state.items.filter((item) => item.kind === "markdown");
    expect(markdown.length).toBeGreaterThanOrEqual(1);
    expect(store.state.running).toBeNull();
  });

  it("carries the tool output preview on the item (BUG-1 seam)", async () => {
    const adapter = scriptedAdapter([
      [
        { type: "tool-call", id: "t1", name: "read", args: { path: "notes.md" } },
        { type: "finish", stopReason: "end_turn" },
      ],
      [{ type: "finish", stopReason: "end_turn" }],
    ]);
    const store = createTuiStore({ onAbort: () => {} });
    const deps = await makeDeps(adapter);
    await writeFile(join(deps.cwd, "notes.md"), "# line one\nline two\n", "utf8");
    await driveAgent(
      store,
      deps,
      {
        ask: async () => ({ approved: true }),
      },
      "read it",
      new AbortController().signal,
    );
    const toolItems = store.state.items.filter((item) => item.kind === "tool");
    expect(toolItems.length).toBe(1);
    const tool = toolItems[0];
    expect(tool?.toolName).toBe("read");
    expect(tool?.argsSummary).toContain("notes.md");
    expect(tool?.detail).toContain("line one");
  });

  it("populates the subagent lane from the task footer (§4b seam)", async () => {
    const summary = "read the auth module; report attached.";
    const footer = "(subagent session: 2026-09-18T07-41-39-116Z-84df8c38)";
    // A tool NAMED task routes driveAgent's lane extraction; the stub carries
    // the exact content shape spawnSubagent produces.
    const taskStub: ToolDefinition = {
      name: "task",
      description: "stub task for the seam test",
      readOnly: false,
      inputSchema: { type: "object", properties: {} },
      handler: async () => `${summary}\n\n${footer}`,
    };
    const adapter = scriptedAdapter([
      [
        { type: "tool-call", id: "s1", name: "task", args: { prompt: "read auth" } },
        { type: "finish", stopReason: "end_turn" },
      ],
      [{ type: "finish", stopReason: "end_turn" }],
    ]);
    const store = createTuiStore({ onAbort: () => {} });
    const deps = await makeDeps(adapter);
    deps.tools = [taskStub];
    await driveAgent(
      store,
      deps,
      {
        ask: async () => ({ approved: true }),
      },
      "delegate",
      new AbortController().signal,
    );
    const taskItems = store.state.items.filter((item) => item.kind === "tool");
    expect(taskItems.length).toBe(1);
    const task = taskItems[0];
    expect(task?.subagent).toEqual({
      sessionId: "2026-09-18T07-41-39-116Z-84df8c38",
      summary,
    });
  });
});
