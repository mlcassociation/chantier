import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Redirects $HOME to a fresh temp dir for the duration of a test that mounts
 * the app: TaskInput's history persists to ~/.chantier/history.jsonl, and
 * tests must never read or write the real user home. Returns the restore
 * function (call it in a finally block or afterEach).
 */
export async function useTempHome(): Promise<() => void> {
  const dir = await mkdtemp(join(tmpdir(), "chantier-home-"));
  const previous = process.env.HOME;
  process.env.HOME = dir;
  return () => {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
  };
}
