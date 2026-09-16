import type { Message, ModelEvent, ToolDefinition } from "./types.ts";

/**
 * The provider seam. Core never imports a provider SDK; implementations live in
 * `@chantier/providers` and translate into these events.
 */
export interface ModelAdapter {
  /** `messages` always starts with a SystemMessage (see core context assembly). */
  stream(
    messages: Message[],
    tools: ToolDefinition[],
    signal: AbortSignal,
  ): AsyncIterable<ModelEvent>;
}
