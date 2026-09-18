import {
  type AgentEvent,
  type CompactionOutcome,
  compactSession,
  estimateMessageTokens,
  type Message,
  type ModelAdapter,
  runAgent,
  type SessionStore,
  sessionView,
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
  type TuiStoreV5,
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
  /**
   * Resolved model context window in tokens; undefined (unknown model) leaves
   * compaction disabled — the shipped core contract.
   */
  contextWindow?: number;
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

function argsSummary(args: Record<string, unknown>, ellipsis: string): string {
  const json = JSON.stringify(args);
  return json.length > 120 ? `${json.slice(0, 120)}${ellipsis}` : json;
}

/** BUG-1 output preview: first non-empty line of the result content, 120 chars max. */
function toolDetail(content: string, ellipsis: string): string | undefined {
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length > 0) {
      return trimmed.length > 120 ? `${trimmed.slice(0, 120)}${ellipsis}` : trimmed;
    }
  }
  return undefined;
}

/** Transcript notice for a compaction; ASCII `->` keeps SR/ASCII mode glyph-free. */
export function compactionNotice(tokensBefore: number, tokensAfter: number): string {
  return `context compacted: ~${tokensBefore} -> ~${tokensAfter} tokens`;
}

/** Exact manual compaction command accepted at the task prompt. */
const COMPACT_COMMAND = "/compact";

/**
 * Headless stderr notice, printed only under --verbose. Injectable writer
 * keeps the printing deterministic in tests.
 */
export function writeHeadlessCompactionNotice(
  event: Extract<AgentEvent, { type: "compaction" }>,
  verbose: boolean,
  write: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): void {
  if (verbose) write(compactionNotice(event.tokensBefore, event.tokensAfter));
}

/** Estimate of the current model-facing context, system prompt included. */
function viewTokens(deps: InteractiveDeps): number {
  return estimateMessageTokens([{ role: "system", content: deps.system }, ...deps.messages]);
}

/** Rebuilds deps.messages from the log's model-facing view (compaction-aware). */
async function reloadMessages(deps: InteractiveDeps): Promise<void> {
  const entries = await deps.session.load(deps.session.id);
  deps.messages = sessionView(entries);
}

export interface CompactTaskOptions {
  /** Manual /compact: report a notice even when there is nothing to do. */
  manual?: boolean;
  signal?: AbortSignal;
}

/**
 * Per-task compaction gate: before the next task, estimate the view and let
 * `compactSession` decide (its threshold is the same one runAgent applies
 * between turns). On success the compaction entry + summary message have been
 * appended to the session and deps.messages reloaded from the folded view, so
 * the next request stays pairing-safe and inside the window.
 */
export async function compactTaskContext(
  store: TuiStore,
  deps: InteractiveDeps,
  options: CompactTaskOptions = {},
): Promise<void> {
  if (deps.contextWindow === undefined) {
    if (options.manual === true) {
      store.pushItem({
        kind: "info",
        text: "compaction unavailable: no context window for this model",
      });
    }
    return;
  }
  let outcome: CompactionOutcome | null = null;
  try {
    outcome = await compactSession({
      store: deps.session,
      adapter: deps.adapter,
      system: deps.system,
      contextWindow: deps.contextWindow,
      signal: options.signal,
    });
  } catch (error) {
    store.pushItem({ kind: "error", text: `compaction failed: ${(error as Error).message}` });
    return;
  }
  if (outcome === null) {
    if (options.manual === true) {
      store.pushItem({
        kind: "info",
        text: `context compacted (no-op): ~${viewTokens(deps)} tokens in view`,
      });
    }
    return;
  }
  await reloadMessages(deps);
  store.pushItem({
    kind: "divider",
    text: compactionNotice(outcome.tokensBefore, outcome.tokensAfter),
  });
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
  const symbols = resolveSymbols(ascii);
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
      // Compaction is disabled without a declared window (unknown model).
      contextWindow: deps.contextWindow,
      compaction: deps.contextWindow === undefined ? undefined : { enabled: true },
      signal,
    })) {
      if (event.type === "text-delta") {
        store.appendStream(event.text);
        // Paragraph-boundary flush (BUG-2): the store splits its buffer at the
        // last safe boundary via takeSafeFlush — flushed text lands as one
        // markdown item, the remainder (an open fence, a half paragraph) stays
        // the live region. Newline-gated: a boundary needs a line break.
        if (event.text.includes("\n")) store.flushStream({ safe: true });
      } else if (event.type === "tool-result") {
        store.flushStream();
        store.pushItem({
          kind: "tool",
          toolName: event.toolName,
          argsSummary: argsSummary(event.args, symbols.ellipsis),
          outcome: "done",
          detail: toolDetail(event.content, symbols.ellipsis),
        });
      } else if (event.type === "compaction") {
        store.flushStream();
        store.pushItem({
          kind: "divider",
          text: compactionNotice(event.tokensBefore, event.tokensAfter),
        });
      } else {
        store.flushStream();
        if (event.usage !== undefined) {
          // Cumulative across runs (spec §5 footer): each result's usage adds.
          const prev = store.state.usage;
          store.setUsage({
            inputTokens: (prev?.inputTokens ?? 0) + event.usage.inputTokens,
            outputTokens: (prev?.outputTokens ?? 0) + event.usage.outputTokens,
          });
        }
        store.pushItem({ kind: "info", text: summarizeResult(event, symbols.hintSeparator) });
      }
    }
    return "done";
  } catch (error) {
    if (signal.aborted) return "aborted";
    store.flushStream();
    store.pushItem({ kind: "error", text: `Error: ${(error as Error).message}` });
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
      store.pushItem({
        kind: "info",
        text: decision.approved
          ? decision.remember === true
            ? `tool: approved (always): ${req.tool}`
            : `tool: approved: ${req.tool}`
          : `tool: denied (${decision.reason ?? "user"})`,
      });
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
  // v0.5: the store gains the §1 contract (items/queued/running/usage). In
  // this tree createTuiStore still returns the v0.4 shape, so the loop
  // consumes the frozen intersection; the cast collapses once store.ts
  // lands the contract (same integration rule as the markdown import).
  const store = createTuiStore({
    onAbort: (kind) => {
      abortKind = kind;
      currentController?.abort();
    },
  }) as TuiStore & TuiStoreV5;
  // Terminal bell when an approval card demands attention (SR mode only);
  // the sink forwards any diff attachment on the request into the TUI.
  const sink = createTuiSink(store, { permission: deps.permission, bell });
  const tui = startTui(store, { screenReader });

  /**
   * §6d drain: queued texts join with blank lines into the next composite
   * task, in push order. Called the moment a run settles — including right
   * after an esc-interrupt (CC semantics: interrupt, then the queued
   * message sends).
   */
  const drainQueue = (): string | null => {
    const pending = store.queued.slice();
    if (pending.length === 0) return null;
    while (store.queued.length > 0) store.dropQueued();
    return pending.join("\n\n");
  };

  let exitCode = 0;
  let pendingTask: string | null = null;
  for (;;) {
    const task = pendingTask ?? (await store.awaitTask());
    pendingTask = null;
    if (task === null) {
      // finish() from Ctrl-C quits with the interrupted-code semantics.
      if (abortKind === "ctrl-c") exitCode = 130;
      break;
    }
    abortKind = "escape" as AbortKind;
    currentController = new AbortController();
    if (task.trim() === COMPACT_COMMAND) {
      await compactTaskContext(store, deps, { manual: true, signal: currentController.signal });
      continue;
    }
    store.setRunning({ sinceMs: Date.now() });
    const outcome = await driveAgent(store, deps, sink, task, currentController.signal);
    store.setRunning(null);
    store.flushStream();
    // Rebuild the conversation from the session: runAgent appends assistant and
    // tool-result messages to the session but never to deps.messages, and a
    // task-N request missing its tool_use pairing would 400 on strict APIs.
    // sessionView keeps the fold compaction-aware (summary + kept tail).
    await reloadMessages(deps);
    if (outcome !== "aborted") {
      // Between-task gate: compact BEFORE the next task's first request.
      await compactTaskContext(store, deps, { signal: currentController.signal });
    }
    if (outcome === "aborted") {
      store.pushItem({ kind: "info", text: "cancelled." });
      if (abortKind === "ctrl-c") {
        exitCode = 130;
        break;
      }
    }
    // A finished (non-aborted) run hands attention back: ring the bell.
    if (outcome !== "aborted") bell();
    // §6d: the run has settled — hand queued texts to the next iteration,
    // including right after an esc-interrupt.
    pendingTask = drainQueue();
  }
  store.finish();
  await tui.waitUntilExit();
  return exitCode;
}
