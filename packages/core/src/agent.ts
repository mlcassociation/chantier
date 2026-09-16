import type { ApprovalDetail, ApprovalSink, PermissionEngine } from "@chantier/permissions";
import {
  type CompactionResult,
  compactConversation,
  compactedSummaryMessage,
  DEFAULT_COMPACTION_KEEP_RECENT,
  DEFAULT_COMPACTION_RESERVE,
  estimateMessageTokens,
  looksLikeContextOverflow,
  shouldCompact,
} from "./compaction.ts";
import type { ModelAdapter } from "./model-adapter.ts";
import { alignedMessageOrdinals } from "./session.ts";
import type {
  AssistantMessage,
  CompactionEntry,
  Message,
  SessionStore,
  SystemMessage,
  ToolCallBlock,
  ToolContext,
  ToolDefinition,
  ToolResultMessage,
  Usage,
} from "./types.ts";
export type AgentEvent =
  | { type: "text-delta"; text: string }
  | {
      type: "tool-result";
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
      content: string;
    }
  | { type: "compaction"; tokensBefore: number; tokensAfter: number; summaryChars: number }
  | {
      type: "result";
      text: string;
      usage?: Usage;
      turns: number;
      stopReason: "end_turn" | "max_turns";
    };

export interface CompactionOptions {
  /** Compaction on/off; defaults to true when `contextWindow` is set. */
  enabled?: boolean;
  /** Headroom kept for the model's answer; see `shouldCompact`. */
  reserve?: number;
  /** Verbatim tail kept after compaction, in estimated tokens. */
  keepRecent?: number;
}

export interface RunAgentOptions {
  adapter: ModelAdapter;
  tools: ToolDefinition[];
  permission: PermissionEngine;
  sink: ApprovalSink;
  session: SessionStore;
  /** Project cwd; every tool handler resolves paths against it. */
  cwd: string;
  system: string;
  /** Prior conversation (e.g. replayed on --continue); the system prompt is prepended once. */
  messages?: Message[];
  maxTurns?: number;
  signal: AbortSignal;
  /**
   * Model context window in tokens. Undefined = compaction disabled; callers
   * opt in by declaring the window they are targeting.
   */
  contextWindow?: number;
  compaction?: CompactionOptions;
}

const HEADLESS_HINT = "rerun with --yolo or add an allow rule to .chantier/settings.json";

/**
 * The boring loop: stream → accumulate → execute tools (denials feed back as
 * results, never as error branching) → repeat until a turn has zero tool calls.
 * Consecutive readOnly tool calls run concurrently, in the order the model
 * emitted them; mutating calls run sequentially.
 *
 * Context management: when `contextWindow` is set, compaction is checked
 * between turns (after tool results are appended, before the next stream) and
 * once as a reactive fallback when a stream fails with a context-overflow
 * error. Compaction replaces the in-memory context with summary + kept tail,
 * appends one `compaction` entry plus the summary as a regular user message to
 * the session log (the log stays append-only; `load()` is untouched), and
 * preserves assistant tool-call / tool-result pairing.
 */
export async function* runAgent(opts: RunAgentOptions): AsyncGenerator<AgentEvent> {
  const maxTurns = opts.maxTurns ?? 50;
  const byName = new Map(opts.tools.map((tool) => [tool.name, tool]));
  const system: SystemMessage = { role: "system", content: opts.system };
  const messages: Message[] = [system, ...(opts.messages ?? [])];
  const available = opts.tools.filter((tool) => !opts.permission.isRemoved(tool.name));

  const contextWindow = opts.contextWindow;
  const compactionEnabled = contextWindow !== undefined && (opts.compaction?.enabled ?? true);
  const reserve = opts.compaction?.reserve ?? DEFAULT_COMPACTION_RESERVE;
  const keepRecent = opts.compaction?.keepRecent ?? DEFAULT_COMPACTION_KEEP_RECENT;

  /**
   * Ordinal of each message within the session log's message-entry sequence
   * (the header and compaction entries are not counted; null = never logged,
   * i.e. the system message). Maintained even when compaction is off — it is
   * then garbage but never read.
   */
  const ordinals: Array<number | null> = [null];
  let nextOrdinal = 0;
  if (compactionEnabled) {
    const priorEntries = await opts.session.load(opts.session.id);
    const logged = priorEntries.reduce(
      (count, entry) => (entry.type === "message" ? count + 1 : count),
      0,
    );
    const given = opts.messages ?? [];
    // Preferred alignment: exact suffix match against the log's view order.
    // Handles the compaction view, where the hoisted summary message breaks
    // the naive suffix offset (its log ordinal is late but it is ordered
    // first, so a pure count-based offset would assign wrong ordinals and a
    // later compaction entry could split a tool pair on the next view()).
    const aligned = alignedMessageOrdinals(priorEntries, given);
    if (aligned !== null) {
      ordinals.push(...aligned);
    } else {
      // Fallback (full replay of a compacted log and foreign inputs): assume
      // the given messages are the last `given.length` logged entries.
      const offset = Math.max(
        0,
        logged - given.filter((message) => message.role !== "system").length,
      );
      let seen = 0;
      for (const message of given) {
        if (message.role === "system") {
          ordinals.push(null);
          continue;
        }
        ordinals.push(offset + seen);
        seen += 1;
      }
    }
    nextOrdinal = logged;
  } else {
    ordinals.push(...(opts.messages ?? []).map(() => null));
  }

  let usage: Usage | undefined;
  let turns = 0;
  let lastText = "";

  const appendMessage = async (message: AssistantMessage | ToolResultMessage) => {
    messages.push(message);
    ordinals.push(nextOrdinal);
    await opts.session.append({ type: "message", message });
  };

  type CompactionOutcome = { tokensBefore: number; tokensAfter: number; summaryChars: number };

  /**
   * Runs one compaction against the current context and rewires the live
   * message list (system + summary message + kept tail). Never throws: a
   * failed compaction keeps the run going uncompacted. Appends the compaction
   * entry (which carries the summary) and the summary message to the log.
   */
  const runCompaction = async (): Promise<CompactionOutcome | null> => {
    if (!compactionEnabled || contextWindow === undefined) return null;
    let kept: CompactionResult;
    try {
      kept = await compactConversation({
        adapter: opts.adapter,
        messages,
        keepRecent,
        window: contextWindow,
        reserve,
        signal: opts.signal,
      });
    } catch {
      return null;
    }
    if (kept.summary.length === 0) return null;
    const keptOrdinals = ordinals.slice(kept.keptStart);
    const entry: CompactionEntry = {
      type: "compaction",
      summary: kept.summary,
      firstKeptMessageIndex: keptOrdinals[0] ?? nextOrdinal,
      tokensBefore: kept.tokensBefore,
      createdAt: new Date().toISOString(),
    };
    await opts.session.append(entry);
    const summaryMessage = compactedSummaryMessage(kept.summary);
    await opts.session.append({ type: "message", message: summaryMessage });
    messages.splice(0, messages.length, system, summaryMessage, ...kept.keptMessages);
    ordinals.splice(0, ordinals.length, null, nextOrdinal, ...keptOrdinals);
    nextOrdinal += 1;
    return {
      tokensBefore: kept.tokensBefore,
      tokensAfter: kept.estimatedAfter,
      summaryChars: kept.summary.length,
    };
  };

  while (turns < maxTurns) {
    turns += 1;
    let turnText = "";
    const toolCalls: ToolCallBlock[] = [];
    let turnStart = messages.length;
    let overflowError: unknown;

    for (;;) {
      turnText = "";
      toolCalls.length = 0;
      try {
        for await (const event of opts.adapter.stream(messages, available, opts.signal)) {
          if (event.type === "text-delta") {
            turnText += event.text;
            yield event;
          } else if (event.type === "tool-call") {
            toolCalls.push({ type: "tool-call", id: event.id, name: event.name, args: event.args });
          } else {
            usage = event.usage;
          }
        }
        break;
      } catch (error) {
        if (!looksLikeContextOverflow(error)) throw error;
        // Reactive fallback: one compaction + retry; a second overflow
        // surfaces the original error, not the retry's.
        if (overflowError !== undefined) throw overflowError;
        overflowError = error;
        const outcome = await runCompaction();
        if (outcome === null) throw error;
        // The context list shrank; the next turn's delta accounting restarts
        // from the compacted tail.
        turnStart = messages.length;
        yield { type: "compaction", ...outcome };
      }
    }

    const assistant: AssistantMessage = {
      role: "assistant",
      content: [
        ...(turnText.length > 0 ? [{ type: "text" as const, text: turnText }] : []),
        ...toolCalls,
      ],
    };
    await appendMessage(assistant);

    if (toolCalls.length === 0) {
      yield { type: "result", text: turnText, usage, turns, stopReason: "end_turn" };
      return;
    }
    lastText = turnText;

    for (const group of consecutiveReadOnlyGroups(toolCalls, byName)) {
      const results = await Promise.all(group.map((call) => executeCall(call, opts, byName)));
      for (const [index, result] of results.entries()) {
        await appendMessage(result);
        yield {
          type: "tool-result",
          toolCallId: result.toolCallId,
          toolName: result.toolName,
          args: group[index]?.args ?? {},
          content: result.content,
        };
      }
    }

    // Between turns: after every tool result is appended (pairs are complete,
    // never mid-batch), before the next stream.
    if (compactionEnabled && contextWindow !== undefined) {
      const turnDelta = messages.slice(turnStart);
      const tokensUsed = usage
        ? usage.inputTokens + usage.outputTokens + estimateMessageTokens(turnDelta)
        : estimateMessageTokens(messages);
      if (shouldCompact({ tokensUsed, window: contextWindow, reserve, keepRecent })) {
        const outcome = await runCompaction();
        if (outcome !== null) yield { type: "compaction", ...outcome };
      }
    }
  }

  yield { type: "result", text: lastText, usage, turns: maxTurns, stopReason: "max_turns" };
}

/** Groups consecutive readOnly calls; the first mutating call breaks the run. */
function* consecutiveReadOnlyGroups(
  calls: ToolCallBlock[],
  byName: Map<string, ToolDefinition>,
): Generator<ToolCallBlock[]> {
  let group: ToolCallBlock[] = [];
  for (const call of calls) {
    if (byName.get(call.name)?.readOnly === true) {
      group.push(call);
      continue;
    }
    if (group.length > 0) {
      yield group;
      group = [];
    }
    yield [call];
  }
  if (group.length > 0) yield group;
}

async function executeCall(
  call: ToolCallBlock,
  opts: RunAgentOptions,
  byName: Map<string, ToolDefinition>,
): Promise<ToolResultMessage> {
  const base = { role: "tool-result" as const, toolCallId: call.id, toolName: call.name };
  const tool = byName.get(call.name);
  if (tool === undefined) {
    return {
      ...base,
      content: `Permission denied: tool "${call.name}" is not available. It was removed by a deny rule or does not exist. Use one of the listed tools.`,
    };
  }
  const ctx: ToolContext = {
    cwd: opts.cwd,
    session: opts.session,
    permission: opts.permission,
    signal: opts.signal,
  };
  const specifier = tool.specifier?.(call.args);
  const decision = opts.permission.evaluate(call.name, specifier, tool.readOnly);
  if (decision === "deny") {
    return {
      ...base,
      content: `Permission denied: ${call.name}(${specifier ?? ""}) is denied by permission rules. This decision is final; do not retry this call.`,
    };
  }
  if (decision === "ask") {
    // askDetail is optional approval-UI metadata; failing to compute it (unreadable
    // file, malformed args) must never block the ask itself.
    let detail: ApprovalDetail | undefined;
    try {
      detail = await tool.askDetail?.(call.args, ctx);
    } catch {
      detail = undefined;
    }
    const approval = await opts.sink.ask({
      tool: call.name,
      input: call.args,
      reason: specifier === undefined ? call.name : `${call.name} ${specifier}`,
      detail,
    });
    if (!approval.approved) {
      const reason = approval.reason ?? `the request was not approved (${HEADLESS_HINT})`;
      return {
        ...base,
        content: `Permission denied: ${call.name}(${specifier ?? ""}) was not approved. ${reason}`,
      };
    }
  }
  try {
    const content = await tool.handler(call.args, ctx);
    return { ...base, content };
  } catch (error) {
    const description = error instanceof Error ? error.message : String(error);
    return {
      ...base,
      content: `Error: tool ${call.name} failed: ${description}. Adjust the arguments and retry if useful.`,
    };
  }
}
