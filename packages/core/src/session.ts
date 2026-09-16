import { createHash, randomBytes } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { COMPACTED_MARKER } from "./compaction.ts";
import type { Message, SessionEntry, SessionStore } from "./types.ts";

export const DEFAULT_SESSIONS_ROOT = path.join(homedir(), ".chantier", "sessions");

export function sessionsDirFor(sessionsRoot: string, cwd: string): string {
  const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 12);
  return path.join(sessionsRoot, hash);
}

export interface CreateSessionOptions {
  cwd: string;
  provider: string;
  model: string;
  sessionsRoot?: string;
  id?: string;
}

export interface ResumeSessionOptions {
  cwd: string;
  sessionsRoot?: string;
  id: string;
}

function newSessionId(): string {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(4).toString("hex")}`;
}

function buildStore(file: string, dir: string, id: string, selfId: string): SessionStore {
  const readEntries = async (loadId: string): Promise<SessionEntry[]> => {
    const target = loadId === selfId ? file : path.join(dir, `${loadId}.jsonl`);
    const raw = await readFile(target, "utf8");
    return raw
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as SessionEntry);
  };
  return {
    id,
    dir,
    async append(entry: SessionEntry) {
      await appendFile(file, `${JSON.stringify(entry)}\n`);
    },
    load: readEntries,
    async view(viewId: string) {
      const entries = await readEntries(viewId);
      return sessionView(entries);
    },
  };
}

/** Creates a new session file and writes the header line immediately. */
export async function createSessionStore(opts: CreateSessionOptions): Promise<SessionStore> {
  const sessionsRoot = opts.sessionsRoot ?? DEFAULT_SESSIONS_ROOT;
  const dir = sessionsDirFor(sessionsRoot, opts.cwd);
  await mkdir(dir, { recursive: true });
  const id = opts.id ?? newSessionId();
  const file = path.join(dir, `${id}.jsonl`);

  const header: SessionEntry = {
    type: "session",
    id,
    cwd: opts.cwd,
    provider: opts.provider,
    model: opts.model,
    createdAt: new Date().toISOString(),
  };
  await appendFile(file, `${JSON.stringify(header)}\n`);
  return buildStore(file, dir, id, id);
}

/** Reattaches to an existing session file (--continue); no new header line. */
export async function resumeSessionStore(opts: ResumeSessionOptions): Promise<SessionStore> {
  const sessionsRoot = opts.sessionsRoot ?? DEFAULT_SESSIONS_ROOT;
  const dir = sessionsDirFor(sessionsRoot, opts.cwd);
  const file = path.join(dir, `${opts.id}.jsonl`);
  return buildStore(file, dir, opts.id, opts.id);
}

/**
 * Folds the append-only log into the model-facing context: everything with a
 * message ordinal below the last compaction's `firstKeptMessageIndex` is
 * replaced by that compaction's summary message (a regular logged `user`
 * message — see `CompactionEntry`). Logs without compaction entries view as
 * the plain message sequence, so old sessions and `--continue` stay safe.
 *
 * Two subtleties make this more than a filter:
 * - The boundary is applied to the WHOLE log, not just entries after the
 *   compaction marker: in the append order the kept tail is logged before the
 *   compaction entry, so a forward pass alone would leak pre-boundary
 *   messages into the view.
 * - The summary message is hoisted to the front of the kept span. It is logged
 *   after the boundary messages (append-only), but the model-facing context is
 *   system + summary + kept tail — the live agent list and `view()` must
 *   agree, and hoisting restores that order without touching the log.
 */
export function sessionView(entries: readonly SessionEntry[]): Message[] {
  // Defensive max: a later compaction can only keep a suffix of what the
  // previous one kept, since it summarizes the current context view.
  let keptFrom = 0;
  for (const entry of entries) {
    if (entry.type === "compaction") {
      keptFrom = Math.max(keptFrom, entry.firstKeptMessageIndex);
    }
  }
  let hoisted: Message | undefined;
  let lastCompaction = -1;
  for (let i = 0; i < entries.length; i += 1) {
    if (entries[i]?.type === "compaction") lastCompaction = i;
  }
  if (lastCompaction >= 0) {
    const next = entries[lastCompaction + 1];
    // Per the CompactionEntry convention the trailing message is the summary
    // message; the marker check keeps foreign logs (no marker) un-hoisted.
    if (
      next?.type === "message" &&
      next.message.role === "user" &&
      next.message.content[0]?.type === "text" &&
      next.message.content[0].text.startsWith(COMPACTED_MARKER)
    ) {
      hoisted = next.message;
    }
  }
  const messages: Message[] = [];
  let ordinal = 0;
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const isHoisted = entry.message === hoisted;
    if (!isHoisted && ordinal >= keptFrom) messages.push(entry.message);
    ordinal += 1;
  }
  if (hoisted !== undefined) messages.unshift(hoisted);
  return messages;
}

/** `--continue`: newest session file (by mtime) in this cwd's session dir. */
export async function loadNewestSessionId(
  cwd: string,
  sessionsRoot: string = DEFAULT_SESSIONS_ROOT,
): Promise<string | null> {
  const dir = sessionsDirFor(sessionsRoot, cwd);
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return null; // no sessions for this cwd yet
  }
  const jsonl = files.filter((name) => name.endsWith(".jsonl"));
  if (jsonl.length === 0) return null;
  let newest: { name: string; mtimeMs: number } | null = null;
  for (const name of jsonl) {
    const info = await stat(path.join(dir, name));
    // Timestamped ids make names sortable; ties on mtime resolve to the later name.
    if (
      newest === null ||
      info.mtimeMs > newest.mtimeMs ||
      (info.mtimeMs === newest.mtimeMs && name > newest.name)
    ) {
      newest = { name, mtimeMs: info.mtimeMs };
    }
  }
  return newest ? newest.name.replace(/\.jsonl$/, "") : null;
}
