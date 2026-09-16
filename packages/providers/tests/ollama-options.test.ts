import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAnthropicAdapter,
  createOllamaAdapter,
  KNOWN_MODEL_CONTEXT_WINDOWS,
  resolveAdapter,
} from "../src/index.ts";

vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: vi.fn(() => (modelId: string) => ({ modelId })),
}));

const openaiCompatible = vi.mocked(createOpenAICompatible);

describe("createOllamaAdapter options", () => {
  beforeEach(() => {
    openaiCompatible.mockClear();
    delete process.env.OPENAI_API_KEY;
  });

  it("sets includeUsage so token usage reaches the finish event", () => {
    createOllamaAdapter({ model: "glm-5.3-flash:cloud" });
    expect(openaiCompatible).toHaveBeenCalledWith(
      expect.objectContaining({ name: "ollama", includeUsage: true }),
    );
  });

  it("sends an explicit key ahead of the OPENAI_API_KEY fallback and placeholder", () => {
    process.env.OPENAI_API_KEY = "sk-openai-env-123456";
    createOllamaAdapter({ apiKey: "sk-explicit-123456" });
    expect(openaiCompatible).toHaveBeenLastCalledWith(
      expect.objectContaining({ apiKey: "sk-explicit-123456" }),
    );
    createOllamaAdapter({});
    expect(openaiCompatible).toHaveBeenLastCalledWith(
      expect.objectContaining({ apiKey: "sk-openai-env-123456" }),
    );
    delete process.env.OPENAI_API_KEY;
    createOllamaAdapter({});
    expect(openaiCompatible).toHaveBeenLastCalledWith(
      expect.objectContaining({ apiKey: "ollama" }),
    );
  });

  it("accepts a contextWindow option and falls back to the documented map", () => {
    createOllamaAdapter({ model: "glm-5.3-flash:cloud", contextWindow: 65536 });
    const settings = openaiCompatible.mock.calls[0]?.[0];
    expect(settings).toBeDefined();
    expect(KNOWN_MODEL_CONTEXT_WINDOWS["glm-5.3-flash:cloud"]).toBe(131072);
    expect(KNOWN_MODEL_CONTEXT_WINDOWS["claude-sonnet-4-5"]).toBe(200000);
  });

  it("resolveAdapter threads a config contextWindow through without breaking the interface", () => {
    expect(() =>
      resolveAdapter({
        provider: "ollama",
        ollama: { model: "glm-5.3-flash:cloud", contextWindow: 131072 },
      }),
    ).not.toThrow();
    expect(() =>
      resolveAdapter({ provider: "anthropic", anthropic: { apiKey: "k", contextWindow: 200000 } }),
    ).not.toThrow();
    expect(() => createAnthropicAdapter({ apiKey: "k", contextWindow: 200000 })).not.toThrow();
    expect(() => createOllamaAdapter({ contextWindow: 131072 })).not.toThrow();
  });
});
