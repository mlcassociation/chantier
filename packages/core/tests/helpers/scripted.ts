import type { ModelAdapter, ModelEvent } from "@chantier/core";

/**
 * Test adapter that replays scripted model turns, one array per `stream`
 * call; exhausted scripts yield empty turns. `calls` counts streams so tests
 * can assert exactly how many model invocations happened.
 */
export function scriptedAdapter(turns: ModelEvent[][]): ModelAdapter & { calls: number } {
  let index = 0;
  return {
    calls: 0,
    async *stream() {
      this.calls += 1;
      const events = turns[index] ?? [];
      index += 1;
      for (const event of events) yield event;
    },
  } as ModelAdapter & { calls: number };
}