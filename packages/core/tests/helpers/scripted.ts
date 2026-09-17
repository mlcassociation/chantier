import type { ModelAdapter, ModelEvent } from "@chantier/core";

/**
 * Test adapter that replays scripted model turns, one entry per `stream`
 * call; an Error entry throws instead of streaming, exhausted scripts yield
 * empty turns. `calls` counts streams so tests can assert exactly how many
 * model invocations happened.
 */
export function scriptedAdapter(
  turns: Array<ModelEvent[] | Error>,
): ModelAdapter & { calls: number } {
  let index = 0;
  return {
    calls: 0,
    async *stream() {
      this.calls += 1;
      const turn = turns[index] ?? [];
      index += 1;
      if (turn instanceof Error) throw turn;
      for (const event of turn) yield event;
    },
  } as ModelAdapter & { calls: number };
}
