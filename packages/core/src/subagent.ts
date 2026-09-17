import {
  type ApprovalSink,
  createPermissionEngine,
  createRememberingEngine,
  type PermissionRules,
} from "@chantier/permissions";
import { runAgent } from "./agent.ts";
import { buildSystemPrompt } from "./context.ts";
import { createSessionStore } from "./session.ts";
import type { Message, ModelAdapter, ToolContext, ToolDefinition } from "./types.ts";

/** The returned summary is capped at 50 KiB; the full transcript stays in the child session. */
const SUMMARY_CAP_CHARS = 50 * 1024;

/** Children get their own (smaller) turn budget; the parent's cap says nothing about subtasks. */
const DEFAULT_SUBAGENT_TURNS = 25;

/**
 * Plain-string appendix for the child system prompt. Kept out of the composer
 * on purpose: the subagent role is a property of delegation, not of the
 * project's base prompt.
 */
const SUBAGENT_ROLE_APPENDIX =
  "\n\n# Subagent role\n\n" +
  "You are a subagent spawned by the parent agent to complete one self-contained task. " +
  "Work within the prompt you were given, use the allowed tools, and end with a single short " +
  "summary paragraph of what you did and found. Do not ask the user questions; decide and act.";

export interface SubagentDeps {
  /** The parent's model adapter; the child runs on the same provider/model seam. */
  adapter: ModelAdapter;
  /** The parent's settings rules, verbatim: deny rules bind the child, allow rules pre-approve. */
  rules: PermissionRules;
  /** The parent's approval sink: a child ask surfaces in the parent's approval UI. */
  sink: ApprovalSink;
  /** Provider label recorded in the child session header. */
  provider: string;
  model: string;
  /** Child turn cap; defaults to 25. */
  maxTurns?: number;
  /**
   * Declared model context window; opts the child into compaction (same
   * contract as runAgent). Undefined keeps compaction off for the child.
   */
  contextWindow?: number;
  /**
   * The child's toolset. Phase A depth cap: the child toolset is the builtin
   * set, which does not contain `task`, so a child cannot recurse by
   * construction.
   */
  tools: ToolDefinition[];
}

export interface SubagentResult {
  /** The child's final summary text (50 KiB cap, see spawnSubagent). */
  text: string;
  /** The child's own session id, so the parent can reference/inspect the transcript. */
  sessionId: string;
  truncated: boolean;
}

/**
 * Runs one child agent loop for a single `task` call and returns its final
 * summary. Isolation is structural: a fresh permission engine per spawn (the
 * parent's remembered grants never inherit; deny rules still win first), a
 * fresh session store (the child transcript is its own JSONL file), and a
 * task-free toolset. Child asks surface through the parent's sink, each one a
 * fresh decision. `ctx.signal` propagates: on abort the child loop stops and
 * the error surfaces as the parent's tool result.
 */
export async function spawnSubagent(
  input: { prompt: string },
  deps: SubagentDeps,
  ctx: ToolContext,
): Promise<SubagentResult> {
  // Fresh per spawn: the RememberingEngine allow-set starts empty, so grants
  // remembered in the parent session never carry over; deny rules still win.
  const childPermission = createRememberingEngine(createPermissionEngine(deps.rules));
  const childSession = await createSessionStore({
    cwd: ctx.cwd,
    provider: deps.provider,
    model: deps.model,
  });
  const system = `${await buildSystemPrompt(ctx.cwd, deps.tools)}${SUBAGENT_ROLE_APPENDIX}`;
  const userMessage: Message = { role: "user", content: [{ type: "text", text: input.prompt }] };
  // The caller owns appending the user message (headless/interactive
  // convention): the child transcript then starts with its prompt, and the
  // compaction alignment (when contextWindow is set) sees it as a logged
  // message instead of falling back to the count heuristic.
  await childSession.append({ type: "message", message: userMessage });

  let text = "";
  for await (const event of runAgent({
    adapter: deps.adapter,
    tools: deps.tools,
    permission: childPermission,
    sink: deps.sink,
    session: childSession,
    cwd: ctx.cwd,
    system,
    messages: [userMessage],
    maxTurns: deps.maxTurns ?? DEFAULT_SUBAGENT_TURNS,
    contextWindow: deps.contextWindow,
    compaction: deps.contextWindow === undefined ? undefined : { enabled: true },
    signal: ctx.signal,
  })) {
    // Consume every event; only the terminal result carries the summary text.
    if (event.type === "result") text = event.text;
  }

  if (text.length <= SUMMARY_CAP_CHARS) {
    return { text, sessionId: childSession.id, truncated: false };
  }
  return {
    text:
      `${text.slice(0, SUMMARY_CAP_CHARS)}\n[truncated: subagent summary exceeded 50 KiB cap; ` +
      `full transcript session id: ${childSession.id}]`,
    sessionId: childSession.id,
    truncated: true,
  };
}
