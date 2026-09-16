import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { Message, ModelAdapter, ModelEvent, ToolDefinition, Usage } from "@chantier/core";
import { jsonSchema, type ModelMessage, streamText, type ToolSet, tool } from "ai";

// --- core Message[] → AI SDK ModelMessage[] -----------------------------------

function toModelMessages(messages: Message[]): ModelMessage[] {
  return messages.map((message): ModelMessage => {
    switch (message.role) {
      case "system":
        return { role: "system", content: message.content };
      case "user":
        return {
          role: "user",
          content: message.content.map((block) => ({ type: "text", text: block.text })),
        };
      case "assistant":
        return {
          role: "assistant",
          content: message.content.map((block) =>
            block.type === "text"
              ? { type: "text", text: block.text }
              : {
                  type: "tool-call",
                  toolCallId: block.id,
                  toolName: block.name,
                  input: block.args,
                },
          ),
        };
      case "tool-result":
        return {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: message.toolCallId,
              toolName: message.toolName,
              output: { type: "text", value: message.content },
            },
          ],
        };
    }
    throw new Error(`Unreachable: unknown message role ${(message as { role: string }).role}`);
  });
}

// --- ToolDefinition[] → AI SDK ToolSet (no execute: core executes) -------------

function toToolSet(tools: ToolDefinition[]): ToolSet {
  const set: ToolSet = {};
  for (const definition of tools) {
    set[definition.name] = tool({
      description: definition.description,
      inputSchema: jsonSchema<Record<string, unknown>>(definition.inputSchema),
    });
  }
  return set;
}

// --- shared stream mapping ------------------------------------------------------

type SdkModel = Parameters<typeof streamText>[0]["model"];

/** Maps an AI SDK text stream onto the core `ModelEvent` union.
 * `finishReason: 'tool-calls'` never terminates the loop — the agent decides turns. */
async function* mapStream(
  model: SdkModel,
  messages: Message[],
  tools: ToolDefinition[],
  signal: AbortSignal,
): AsyncIterable<ModelEvent> {
  // ai v7 requires the system prompt via `instructions`, not inside `messages`.
  const instructions = messages
    .filter((message): message is Extract<Message, { role: "system" }> => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");
  const rest = messages.filter((message) => message.role !== "system");
  const result = streamText({
    model,
    instructions,
    messages: toModelMessages(rest),
    tools: toToolSet(tools),
    abortSignal: signal,
  });
  for await (const part of result.stream) {
    switch (part.type) {
      case "text-delta":
        yield { type: "text-delta", text: part.text };
        break;
      case "tool-call":
        yield {
          type: "tool-call",
          id: part.toolCallId,
          name: part.toolName,
          args: (part.input ?? {}) as Record<string, unknown>,
        };
        break;
      case "error":
        throw part.error instanceof Error ? part.error : new Error(String(part.error));
      case "finish": {
        const usage = part.totalUsage;
        const mapped: Usage = {
          inputTokens: usage?.inputTokens ?? 0,
          outputTokens: usage?.outputTokens ?? 0,
        };
        yield { type: "finish", stopReason: "end_turn", usage: mapped };
        break;
      }
      default:
        break; // reasoning/start-step/etc. are not part of the core event surface in v0.1
    }
  }
}

/** Test seam: build a `ModelAdapter` from any AI SDK language model instance. */
export function createSdkModelAdapter(model: SdkModel): ModelAdapter {
  return { stream: (messages, tools, signal) => mapStream(model, messages, tools, signal) };
}

// --- adapters -------------------------------------------------------------------

export interface AnthropicAdapterOptions {
  apiKey?: string;
  model?: string;
}

export function createAnthropicAdapter(options: AnthropicAdapterOptions = {}): ModelAdapter {
  const apiKey =
    options.apiKey ?? process.env.CHANTIER_ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "No Anthropic API key. Set CHANTIER_ANTHROPIC_API_KEY or run `chantier auth` (coming in v0.2).",
    );
  }
  return createSdkModelAdapter(createAnthropic({ apiKey })(options.model ?? "claude-sonnet-4-5"));
}

export interface OllamaAdapterOptions {
  baseUrl?: string;
  model?: string;
}

export function createOllamaAdapter(options: OllamaAdapterOptions = {}): ModelAdapter {
  // OpenAI-compatible clients require a non-empty key; Ollama ignores it.
  const provider = createOpenAICompatible({
    name: "ollama",
    baseURL: options.baseUrl ?? "http://127.0.0.1:11434/v1",
    apiKey: "ollama",
  });
  return createSdkModelAdapter(provider(options.model ?? "llama3.2"));
}

// --- factory ---------------------------------------------------------------------

export interface ProviderConfig {
  provider?: string;
  ollama?: { baseUrl?: string; model?: string };
  anthropic?: { apiKey?: string; model?: string };
}

/** Resolves the adapter from merged config; `providerOverride` wins over config. */
export function resolveAdapter(config: ProviderConfig, providerOverride?: string): ModelAdapter {
  const provider = providerOverride ?? config.provider ?? "ollama";
  if (provider === "ollama") {
    const ollama = config.ollama ?? {};
    return createOllamaAdapter({ baseUrl: ollama.baseUrl, model: ollama.model });
  }
  if (provider === "anthropic") {
    return createAnthropicAdapter({
      apiKey: config.anthropic?.apiKey,
      model: config.anthropic?.model,
    });
  }
  throw new Error(`Unknown provider "${provider}". Known providers: ollama, anthropic.`);
}
