import {
  type AgentEvent,
  type Message,
  type ModelAdapter,
  runAgent,
  type SessionStore,
  type ToolDefinition,
} from "@chantier/core";
import type { ApprovalSink, RememberingEngine } from "@chantier/permissions";
import type { AbortKind } from "@chantier/tui";
import { createTuiStore, startTui, type TuiStore } from "@chantier/tui";

export interface InteractiveDeps {
  adapter: ModelAdapter;
  tools: ToolDefinition[];
  permission: RememberingEngine;
  session: SessionStore;
  cwd: string;
  system: string;
  /** Conversation so far (without the system message); extended after each run. */
  messages: Message[];
  maxTurns?: number;
}

function summarizeResult(event: Extract<AgentEvent, { type: "result" }>): string {
  const usage =
    event.usage === undefined
      ? ""
      : ` · ${event.usage.inputTokens} in / ${event.usage.outputTokens} out`;
  return `(${event.turns} turn${event.turns === 1 ? "" : "s"}${usage})`;
}

function argsSummary(args: Record<string, unknown>): string {
  const json = JSON.stringify(args);
  return json.length > 120 ? `${json.slice(0, 120)}…` : json;
}

/** Feeds agent events into the store; returns after the run settles. */
async function driveAgent(
  store: TuiStore,
  deps: InteractiveDeps,
  sink: ApprovalSink,
  task: string,
  signal: AbortSignal,
): Promise<"done" | "aborted" | "error"> {
  const userMessage: Message = { role: "user", content: [{ type: "text", text: task }] };
  await deps.session.append({ type: "message", message: userMessage });
  deps.messages.push(userMessage);
  try {
    for await (const event of runAgent({
      adapter: deps.adapter,
      tools: deps.tools,
      permission: deps.permission,
      sink,
      session: deps.session,
      cwd: deps.cwd,
      system: deps.system,
      messages: deps.messages,
      maxTurns: deps.maxTurns,
      signal,
    })) {
      if (event.type === "text-delta") {
        store.appendStream(event.text);
      } else if (event.type === "tool-result") {
        store.flushStream();
        store.pushLine(`→ ${event.toolName}(${argsSummary(event.args)})`);
      } else {
        store.flushStream();
        store.pushLine(summarizeResult(event));
      }
    }
    return "done";
  } catch (error) {
    if (signal.aborted) return "aborted";
    store.pushLine(`Error: ${(error as Error).message}`);
    return "error";
  }
}

/**
 * The interactive loop: task prompt → agent run (events stream into the TUI) →
 * task prompt… `esc` cancels the current run and returns to the prompt; Ctrl-C
 * quits the app with exit 130.
 */
export async function runInteractive(deps: InteractiveDeps): Promise<number> {
  let abortKind: AbortKind = "escape";
  let currentController: AbortController | null = null;
  const store = createTuiStore({
    onAbort: (kind) => {
      abortKind = kind;
      currentController?.abort();
    },
  });
  const sink: ApprovalSink = {
    ask: async (req) => {
      const decision = await store.ask(req);
      if (decision.remember === true) deps.permission.remember(req.tool);
      store.pushLine(
        decision.approved
          ? decision.remember === true
            ? `✓ ${req.tool} (always)`
            : `✓ ${req.tool}`
          : `✗ denied: ${decision.reason ?? "user"}`,
      );
      return decision;
    },
  };
  const tui = startTui(store);

  let exitCode = 0;
  for (;;) {
    const task = await store.awaitTask();
    if (task === null) {
      // finish() from Ctrl-C quits with the interrupted-code semantics.
      if (abortKind === "ctrl-c") exitCode = 130;
      break;
    }
    abortKind = "escape" as AbortKind;
    currentController = new AbortController();
    const outcome = await driveAgent(store, deps, sink, task, currentController.signal);
    store.flushStream();
    // Rebuild the conversation from the session: runAgent appends assistant and
    // tool-result messages to the session but never to deps.messages, and a
    // task-N request missing its tool_use pairing would 400 on strict APIs.
    const entries = await deps.session.load(deps.session.id);
    deps.messages = entries
      .filter((entry) => entry.type === "message")
      .map((entry) => entry.message);
    if (outcome === "aborted") {
      store.pushLine("cancelled.");
      if (abortKind === "ctrl-c") {
        exitCode = 130;
        break;
      }
    }
  }
  store.finish();
  await tui.waitUntilExit();
  return exitCode;
}
