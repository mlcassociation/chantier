import {
  type AgentEvent,
  type Message,
  type ModelAdapter,
  runAgent,
  type SessionStore,
  type ToolDefinition,
} from "@chantier/core";
import type { ApprovalRequest, ApprovalSink, RememberingEngine } from "@chantier/permissions";
import type { AbortKind } from "@chantier/tui";
import {
  createTuiStore,
  isAsciiEnv,
  resolveScreenReader,
  resolveSymbols,
  startTui,
  type TuiPromptDetail,
  type TuiStore,
} from "@chantier/tui";

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
  /** Opt-in screen-reader rendering (--screen-reader); CHANTIER_SCREEN_READER=1 also enables it. */
  screenReader?: boolean;
}

function summarizeResult(
  event: Extract<AgentEvent, { type: "result" }>,
  usageSeparator: string,
): string {
  const usage =
    event.usage === undefined
      ? ""
      : ` ${usageSeparator} ${event.usage.inputTokens} in / ${event.usage.outputTokens} out`;
  return `(${event.turns} turn${event.turns === 1 ? "" : "s"}${usage})`;
}

function argsSummary(args: Record<string, unknown>): string {
  const json = JSON.stringify(args);
  return json.length > 120 ? `${json.slice(0, 120)}...` : json;
}

/** Feeds agent events into the store; returns after the run settles. */
export async function driveAgent(
  store: TuiStore,
  deps: InteractiveDeps,
  sink: ApprovalSink,
  task: string,
  signal: AbortSignal,
): Promise<"done" | "aborted" | "error"> {
  const userMessage: Message = { role: "user", content: [{ type: "text", text: task }] };
  await deps.session.append({ type: "message", message: userMessage });
  deps.messages.push(userMessage);
  // ASCII fallback: the `·` usage separator becomes `|` in SR/ASCII mode so no
  // decorative unicode reaches the transcript buffer.
  const ascii =
    resolveScreenReader(deps.screenReader, process.env.CHANTIER_SCREEN_READER) ||
    isAsciiEnv(process.env.CHANTIER_ASCII);
  let streamTail = "";
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
        // Finalize at paragraph boundaries so screen readers get coherent
        // chunks instead of one growing live region (gemini-cli's
        // findLastSafeSplitPoint idea, text-only version). The 2-char tail
        // sees the boundary even when it straddles two chunks.
        streamTail = `${streamTail}${event.text}`.slice(-2);
        if (streamTail === "\n\n") store.flushStream();
      } else if (event.type === "tool-result") {
        store.flushStream();
        store.pushLine(`tool: ${event.toolName}(${argsSummary(event.args)})`);
      } else {
        store.flushStream();
        // The usage separator routes through the centralized symbols helper
        // like every other decorative glyph, so ASCII/SR mode can never leak
        // a bare `·` into the transcript buffer.
        store.pushLine(summarizeResult(event, resolveSymbols(ascii).hintSeparator));
      }
    }
    return "done";
  } catch (error) {
    if (signal.aborted) return "aborted";
    store.pushLine(`Error: ${(error as Error).message}`);
    return "error";
  }
}

export interface TuiSinkOptions {
  permission: RememberingEngine;
  /** Attention cue fired when an approval card appears (e.g. the terminal bell). */
  bell?: () => void;
}

/** Approval sink wired to the TUI store: bell on ask, remember grants, labeled lines. */
export function createTuiSink(store: TuiStore, options: TuiSinkOptions): ApprovalSink {
  return {
    ask: async (req) => {
      options.bell?.();
      const decision = await store.ask(req, readDiffDetail(req));
      if (decision.remember === true) options.permission.remember(req.tool);
      store.pushLine(
        decision.approved
          ? decision.remember === true
            ? `tool: approved (always): ${req.tool}`
            : `tool: approved: ${req.tool}`
          : `tool: denied (${decision.reason ?? "user"})`,
      );
      return decision;
    },
  };
}

/**
 * Reads the optional `detail: { diff?: string }` attachment that a permission
 * engine may put on an ApprovalRequest (typed shape owned by
 * @chantier/permissions). Runtime-guarded so an engine without the field, or
 * a malformed one, is simply ignored instead of breaking the prompt.
 */
function readDiffDetail(req: ApprovalRequest): TuiPromptDetail | undefined {
  if (!("detail" in req)) return undefined;
  const detail: unknown = req.detail;
  if (typeof detail !== "object" || detail === null) return undefined;
  if (!("diff" in detail) || typeof detail.diff !== "string") return undefined;
  return { diff: detail.diff };
}

/**
 * The interactive loop: task prompt → agent run (events stream into the TUI) →
 * task prompt… `esc` cancels the current run and returns to the prompt; Ctrl-C
 * quits the app with exit 130.
 */
export async function runInteractive(deps: InteractiveDeps): Promise<number> {
  const screenReader = resolveScreenReader(deps.screenReader, process.env.CHANTIER_SCREEN_READER);
  // Terminal bell when a run finishes and hands attention back (SR mode only).
  const bell = (): void => {
    if (screenReader) process.stdout.write("\x07");
  };
  let abortKind: AbortKind = "escape";
  let currentController: AbortController | null = null;
  const store = createTuiStore({
    onAbort: (kind) => {
      abortKind = kind;
      currentController?.abort();
    },
  });
  // Terminal bell when an approval card demands attention (SR mode only);
  // the sink forwards any diff attachment on the request into the TUI.
  const sink = createTuiSink(store, { permission: deps.permission, bell });
  const tui = startTui(store, { screenReader });

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
    // A finished (non-aborted) run hands attention back: ring the bell.
    if (outcome !== "aborted") bell();
  }
  store.finish();
  await tui.waitUntilExit();
  return exitCode;
}
