import type { Message, ModelEvent, ToolDefinition } from "@chantier/core";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { describe, expect, it } from "vitest";
import {
  createAnthropicAdapter,
  createOllamaAdapter,
  createSdkModelAdapter,
  resolveAdapter,
} from "../src/index.ts";

const readTool: ToolDefinition = {
  name: "read",
  description: "Reads a file",
  inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  readOnly: true,
  handler: async () => "file contents",
};

const PROMPT: Message[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }];

async function collect(adapter: {
  stream: (m: Message[], t: ToolDefinition[], s: AbortSignal) => AsyncIterable<ModelEvent>;
}): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  for await (const event of adapter.stream(PROMPT, [readTool], new AbortController().signal)) {
    events.push(event);
  }
  return events;
}

describe("adapter event mapping", () => {
  it("maps a text-only stream to text-delta + finish(end_turn) with usage", async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "1" },
            { type: "text-delta", id: "1", delta: "Hello " },
            { type: "text-delta", id: "1", delta: "chantier" },
            {
              type: "finish",
              finishReason: { unified: "stop", raw: "stop" },
              usage: {
                inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 7, text: 7, reasoning: 0 },
              },
            },
          ],
        }),
      }),
    });
    const events = await collect(createSdkModelAdapter(model));
    expect(events).toEqual([
      { type: "text-delta", text: "Hello " },
      { type: "text-delta", text: "chantier" },
      { type: "finish", stopReason: "end_turn", usage: { inputTokens: 5, outputTokens: 7 } },
    ]);
  });

  it("maps a tool-call stream to a tool-call event (loop decides turns)", async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "stream-start", warnings: [] },
            {
              type: "tool-call",
              toolCallId: "call-1",
              toolName: "read",
              input: JSON.stringify({ path: "x.ts" }),
            },
            {
              type: "finish",
              finishReason: { unified: "tool-calls", raw: "tool_use" },
              usage: {
                inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 4, text: 0, reasoning: 4 },
              },
            },
          ],
        }),
      }),
    });
    const events = await collect(createSdkModelAdapter(model));
    expect(events).toEqual([
      { type: "tool-call", id: "call-1", name: "read", args: { path: "x.ts" } },
      { type: "finish", stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 4 } },
    ]);
  });
});

describe("resolveAdapter", () => {
  it("throws the corrective missing-key error for anthropic without a key", () => {
    const saved = {
      chantier: process.env.CHANTIER_ANTHROPIC_API_KEY,
      plain: process.env.ANTHROPIC_API_KEY,
    };
    delete process.env.CHANTIER_ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      expect(() => resolveAdapter({ provider: "anthropic" })).toThrow(
        "No Anthropic API key. Run `chantier auth login --provider anthropic`, set ANTHROPIC_API_KEY, or set anthropic.apiKey in ~/.chantier/config.json.",
      );
    } finally {
      if (saved.chantier) process.env.CHANTIER_ANTHROPIC_API_KEY = saved.chantier;
      if (saved.plain) process.env.ANTHROPIC_API_KEY = saved.plain;
    }
  });

  it("builds the anthropic adapter from the CLI-resolved key without env", () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      expect(() =>
        resolveAdapter({ provider: "anthropic" }, undefined, "sk-ant-injected"),
      ).not.toThrow();
      expect(() =>
        resolveAdapter({ provider: "anthropic", anthropic: { apiKey: "sk-ant-cfg" } }),
      ).not.toThrow();
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
  });

  it("rejects unknown providers with the known list", () => {
    expect(() => resolveAdapter({}, "fakeprovider")).toThrow(
      'Unknown provider "fakeprovider". Known providers: ollama, anthropic.',
    );
  });

  it("builds the ollama adapter from config", () => {
    const adapter = resolveAdapter({
      ollama: { baseUrl: "http://127.0.0.1:11434/v1", model: "glm-5.3-flash:cloud" },
    });
    expect(adapter.stream).toBeTypeOf("function");
    expect(createOllamaAdapter().stream).toBeTypeOf("function");
  });
});

describe("createAnthropicAdapter key precedence", () => {
  it("accepts keys from the environment", () => {
    process.env.ANTHROPIC_API_KEY = "plain-key";
    process.env.CHANTIER_ANTHROPIC_API_KEY = "chantier-key";
    try {
      expect(() => createAnthropicAdapter()).not.toThrow();
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.CHANTIER_ANTHROPIC_API_KEY;
    }
  });
});
