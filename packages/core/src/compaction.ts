import type { ModelAdapter } from "./model-adapter.ts";
import type { Message, ToolResultMessage, UserMessage } from "./types.ts";

/**
 * Rough token estimate: ~4 characters per token for English/code text. Used
 * when a provider does not report usage; deliberately cheap and deterministic
 * rather than accurate — the reserve/keepRecent margins absorb the error.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Compaction trigger margins, per the design dossier (§9.1). */
export const DEFAULT_COMPACTION_RESERVE = 16_000;
export const DEFAULT_COMPACTION_KEEP_RECENT = 20_000;

/**
 * Marker prefixing the summary message injected after a compaction. The same
 * text is logged as a regular `user` message and re-built in memory, so the
 * agent's live context and `view()` agree byte-for-byte.
 */
export const COMPACTED_MARKER = "[context compacted — earlier conversation summarized]\n\n";

/** Fires when the next call would leave less than reserve + keepRecent of headroom. */
export function shouldCompact(opts: {
  tokensUsed: number;
  window: number;
  reserve?: number;
  keepRecent?: number;
}): boolean {
  const reserve = opts.reserve ?? DEFAULT_COMPACTION_RESERVE;
  const keepRecent = opts.keepRecent ?? DEFAULT_COMPACTION_KEEP_RECENT;
  return opts.tokensUsed >= opts.window - reserve - keepRecent;
}

/** Best-effort context-overflow detection: provider error texts vary widely. */
export function looksLikeContextOverflow(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /context (?:length|window)|maximum context length|prompt is too long|input length exceeds|too many tokens|token limit|reduce the (?:length|number of tokens)/i.test(
    text,
  );
}

/** Flat text rendering of a message for the estimator fallback. */
function messageText(message: Message): string {
  if (message.role === "system") return message.content;
  if (message.role === "user") {
    return message.content.map((block) => block.text).join("");
  }
  if (message.role === "assistant") {
    return message.content
      .map((block) => {
        if (block.type === "text") return block.text;
        return `${block.name}${block.id}${JSON.stringify(block.args)}`;
      })
      .join("");
  }
  return message.content;
}

/** Sums `estimateTokens` over messages; the chars/4 fallback for missing usage. */
export function estimateMessageTokens(messages: readonly Message[]): number {
  let tokens = 0;
  for (const message of messages) tokens += estimateTokens(messageText(message));
  return tokens;
}

/**
 * Compact textual rendering of a conversation for the summarizer model.
 * Deterministic and role-tagged; tool-call args are inlined as JSON.
 */
export function serializeConversation(messages: readonly Message[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    if (message.role === "system") {
      parts.push(`[system]\n${message.content}`);
    } else if (message.role === "user") {
      parts.push(`[user]\n${message.content.map((block) => block.text).join("\n")}`);
    } else if (message.role === "assistant") {
      const blocks = message.content.map((block) =>
        block.type === "text"
          ? block.text
          : `tool-call ${block.name} id=${block.id}: ${JSON.stringify(block.args)}`,
      );
      parts.push(`[assistant]\n${blocks.join("\n")}`);
    } else {
      parts.push(`[tool-result ${message.toolCallId} (${message.toolName})]\n${message.content}`);
    }
  }
  return parts.join("\n\n");
}

export const COMPACT_PROMPT = `You are summarizing a coding-agent conversation so the work can continue in a fresh context window. Write the summary as plain text with exactly these sections:

ACTIVE TASK
- The user's current request and intent, in the user's own terms. Quote the latest instruction's original wording when it is precise.

DECISIONS AND CONSTRAINTS
- Key decisions made (with the why), invariants, preferences, and constraints that must not be violated.

FILES AND CODE
- Files read or modified, one line each: path, what was done or learned, and why it matters.

UNRESOLVED THREADS
- Open questions, pending next steps, and anything attempted that did not work (with the error).

TO REMEMBER
- Anything the user explicitly asked to remember, verbatim.

Rules: preserve exact identifiers, paths, commands, and error messages; do not invent facts; output nothing before or after the sections; be concise but complete — this summary replaces the conversation it summarizes.`;

/** Old tool results are the biggest context sinks; prune them for summarization. */
const TOOL_RESULT_PRUNE_CHARS = 800;

function pruneToolResult(result: ToolResultMessage): ToolResultMessage {
  if (result.content.length <= TOOL_RESULT_PRUNE_CHARS) return result;
  return {
    ...result,
    content: `${result.content.slice(0, TOOL_RESULT_PRUNE_CHARS)}\n[...tool result truncated, ${result.content.length} chars total]`,
  };
}

/** Prunes oversized tool-result payloads from the span that gets summarized. */
function pruneOldToolResults(messages: readonly Message[]): Message[] {
  return messages.map((message) =>
    message.role === "tool-result" ? pruneToolResult(message) : message,
  );
}

function findAssistantWithCall(
  messages: readonly Message[],
  from: number,
  toolCallId: string,
): number {
  for (let i = from; i >= 1; i -= 1) {
    const message = messages[i];
    if (
      message?.role === "assistant" &&
      message.content.some((block) => block.type === "tool-call" && block.id === toolCallId)
    ) {
      return i;
    }
  }
  return -1;
}

/**
 * Walks the boundary back until every kept tool-result has its assistant
 * tool-call inside the kept span (and therefore every kept call has its
 * result). Splitting a pair would 400 on strict APIs.
 */
function safeBoundary(messages: readonly Message[], start: number): number {
  let boundary = start;
  for (;;) {
    const seen = new Set<string>();
    let moved = false;
    for (let i = boundary; i < messages.length; i += 1) {
      const message = messages[i];
      if (message === undefined) break;
      if (message.role === "assistant") {
        for (const block of message.content) {
          if (block.type === "tool-call") seen.add(block.id);
        }
      } else if (message.role === "tool-result" && !seen.has(message.toolCallId)) {
        const assistantIndex = findAssistantWithCall(messages, i - 1, message.toolCallId);
        if (assistantIndex < 1) return 1; // malformed log: keep everything, summarize nothing
        boundary = assistantIndex;
        moved = true;
        break;
      }
    }
    if (!moved) return boundary;
  }
}

export interface CompactionResult {
  /** Summarizer output for everything before the kept span. Empty = nothing to summarize. */
  summary: string;
  /** Tail of the input conversation that stays verbatim; never contains a SystemMessage. */
  keptMessages: Message[];
  /**
   * Index into the `messages` input of the first kept message, so callers can
   * align their own per-message metadata (keptMessages === messages.slice(keptStart)).
   */
  keptStart: number;
  tokensBefore: number;
  /** Estimated context size after re-injection (summary message + kept messages). */
  estimatedAfter: number;
}

export interface CompactConversationOptions {
  adapter: ModelAdapter;
  /**
   * Full conversation, starting with the SystemMessage (the caller rebuilds it
   * from the system prompt). The system message is never summarized and never
   * returned in keptMessages.
   */
  messages: Message[];
  keepRecent: number;
  window: number;
  reserve: number;
  signal?: AbortSignal;
}

/**
 * Summarizes everything except the most recent `keepRecent` tokens-worth of
 * messages and returns the pieces for re-injection. Pure with respect to the
 * session: it never mutates any store; callers decide what to append.
 */
export async function compactConversation(
  opts: CompactConversationOptions,
): Promise<CompactionResult> {
  const { adapter, messages, keepRecent, window, reserve } = opts;
  if (messages[0]?.role !== "system") {
    throw new Error("compactConversation: messages must start with the SystemMessage");
  }
  if (window - reserve - keepRecent <= 0) {
    throw new RangeError(
      `compaction cannot fit: window ${window} must exceed reserve ${reserve} + keepRecent ${keepRecent}`,
    );
  }

  let acc = 0;
  let boundary = messages.length;
  while (boundary > 1 && acc < keepRecent) {
    boundary -= 1;
    const message = messages[boundary];
    if (message !== undefined) acc += estimateTokens(messageText(message));
  }
  const keptStart = safeBoundary(messages, boundary);

  const summarizedSpan = messages.slice(1, keptStart);
  const keptMessages = messages.slice(keptStart);
  const tokensBefore = estimateMessageTokens(messages);
  const keptTokens = estimateMessageTokens(keptMessages);
  if (summarizedSpan.length === 0) {
    return { summary: "", keptMessages, keptStart, tokensBefore, estimatedAfter: keptTokens };
  }

  const summary = await summarizeWithAdapter(
    adapter,
    serializeConversation(pruneOldToolResults(summarizedSpan)),
    opts.signal,
  );
  const estimatedAfter = estimateTokens(COMPACTED_MARKER + summary) + keptTokens;
  return { summary, keptMessages, keptStart, tokensBefore, estimatedAfter };
}

const EMPTY_SIGNAL = new AbortController().signal;

async function summarizeWithAdapter(
  adapter: ModelAdapter,
  conversationText: string,
  signal?: AbortSignal,
): Promise<string> {
  const messages: Message[] = [
    {
      role: "system",
      content:
        "You summarize coding-agent conversations. Output only the requested summary sections as plain text.",
    },
    {
      role: "user",
      content: [
        {
          type: "text",
          text: `${COMPACT_PROMPT}\n\n<conversation>\n${conversationText}\n</conversation>`,
        },
      ],
    },
  ];
  let text = "";
  // No tools: the summarizer must answer with text, in a single turn.
  for await (const event of adapter.stream(messages, [], signal ?? EMPTY_SIGNAL)) {
    if (event.type === "text-delta") text += event.text;
  }
  return text.trim();
}

/** Builds the regular user message that carries the summary after compaction. */
export function compactedSummaryMessage(summary: string): UserMessage {
  return {
    role: "user",
    content: [{ type: "text", text: `${COMPACTED_MARKER}${summary}` }],
  };
}
