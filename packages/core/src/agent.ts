import type { ApprovalDetail, ApprovalSink, PermissionEngine } from "@chantier/permissions";
import type { ModelAdapter } from "./model-adapter.ts";
import type {
  AssistantMessage,
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
  | {
      type: "result";
      text: string;
      usage?: Usage;
      turns: number;
      stopReason: "end_turn" | "max_turns";
    };

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
}

const HEADLESS_HINT = "rerun with --yolo or add an allow rule to .chantier/settings.json";

/**
 * The boring loop: stream → accumulate → execute tools (denials feed back as
 * results, never as error branching) → repeat until a turn has zero tool calls.
 * Consecutive readOnly tool calls run concurrently, in the order the model
 * emitted them; mutating calls run sequentially.
 */
export async function* runAgent(opts: RunAgentOptions): AsyncGenerator<AgentEvent> {
  const maxTurns = opts.maxTurns ?? 50;
  const byName = new Map(opts.tools.map((tool) => [tool.name, tool]));
  const system: SystemMessage = { role: "system", content: opts.system };
  const messages: Message[] = [system, ...(opts.messages ?? [])];
  const available = opts.tools.filter((tool) => !opts.permission.isRemoved(tool.name));

  let usage: Usage | undefined;
  let turns = 0;
  let lastText = "";

  while (turns < maxTurns) {
    turns += 1;
    let turnText = "";
    const toolCalls: ToolCallBlock[] = [];

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

    const assistant: AssistantMessage = {
      role: "assistant",
      content: [
        ...(turnText.length > 0 ? [{ type: "text" as const, text: turnText }] : []),
        ...toolCalls,
      ],
    };
    messages.push(assistant);
    await opts.session.append({ type: "message", message: assistant });

    if (toolCalls.length === 0) {
      yield { type: "result", text: turnText, usage, turns, stopReason: "end_turn" };
      return;
    }
    lastText = turnText;

    for (const group of consecutiveReadOnlyGroups(toolCalls, byName)) {
      const results = await Promise.all(group.map((call) => executeCall(call, opts, byName)));
      for (const [index, result] of results.entries()) {
        messages.push(result);
        await opts.session.append({ type: "message", message: result });
        yield {
          type: "tool-result",
          toolCallId: result.toolCallId,
          toolName: result.toolName,
          args: group[index]?.args ?? {},
          content: result.content,
        };
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
