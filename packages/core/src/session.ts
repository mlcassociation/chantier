import { createHash, randomBytes } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  COMPACTED_MARKER,
  compactConversation,
  compactedSummaryMessage,
  DEFAULT_COMPACTION_KEEP_RECENT,
  DEFAULT_COMPACTION_RESERVE,
  estimateMessageTokens,
  shouldCompact,
} from "./compaction.ts";
import type { ModelAdapter } from "./model-adapter.ts";
import type {
  CompactionEntry,
  Message,
  SessionEntry,
  SessionStore,
  SystemMessage,
} from "./types.ts";

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

// The 4-char base36 sequence makes same-millisecond creations from this process
// sort lexically by creation order, so "newest" tie-breaks in loadNewestSessionId
// stay correct even on filesystems with millisecond timestamp granularity.
let sequence = 0;
function newSessionId(): string {
  sequence = (sequence + 1) % 1_679_616;
  const seq = sequence.toString(36).padStart(4, "0");
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${seq}${randomBytes(2).toString("hex")}`;
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
  return viewWithOrdinals(entries).map((viewed) => viewed.message);
}

/** A view message together with its true log ordinal (position among message entries). */
interface ViewMessage {
  message: Message;
  ordinal: number;
}

/** `sessionView` with ordinals, shared by the alignment and compaction helpers. */
function viewWithOrdinals(entries: readonly SessionEntry[]): ViewMessage[] {
  // Defensive max: a later compaction can only keep a suffix of what the
  // previous one kept, since it summarizes the current context view.
  let keptFrom = 0;
  for (const entry of entries) {
    if (entry.type === "compaction") {
      keptFrom = Math.max(keptFrom, entry.firstKeptMessageIndex);
    }
  }
  let hoisted: Message | undefined;
  let hoistedOrdinal = -1;
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
  const view: ViewMessage[] = [];
  let ordinal = 0;
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    if (entry.message === hoisted) {
      hoistedOrdinal = ordinal;
    } else if (ordinal >= keptFrom) {
      view.push({ message: entry.message, ordinal });
    }
    ordinal += 1;
  }
  if (hoisted !== undefined) {
    view.unshift({ message: hoisted, ordinal: hoistedOrdinal });
  }
  return view;
}

/**
 * True log ordinals for `given` messages when they form a suffix of the log's
 * view — the shape every flow this harness builds produces (`sessionView()`
 * output plus messages appended after the last load, which land at the end).
 * Returns null when the suffix match fails (e.g. a full replay of a compacted
 * log, whose pre-boundary messages are absent from the view); callers fall
 * back to the naive suffix-offset heuristic in that case. System messages are
 * never logged; their slots stay null.
 */
export function alignedMessageOrdinals(
  entries: readonly SessionEntry[],
  given: readonly Message[],
): Array<number | null> | null {
  const view = viewWithOrdinals(entries);
  const result: Array<number | null> = new Array(given.length).fill(null);
  let cursor = view.length - 1;
  for (let i = given.length - 1; i >= 0; i -= 1) {
    const message = given[i];
    if (message === undefined) return null;
    if (message.role === "system") continue; // never logged; stays null
    // JSON-level equality: the given messages come from a different load()
    // parse than these log entries, so identity is unavailable.
    let viewed = view[cursor];
    while (
      cursor >= 0 &&
      viewed !== undefined &&
      JSON.stringify(viewed.message) !== JSON.stringify(message)
    ) {
      cursor -= 1;
      viewed = view[cursor];
    }
    if (viewed === undefined) return null;
    result[i] = viewed.ordinal;
    cursor -= 1;
  }
  return result;
}

export interface CompactionOutcome {
  tokensBefore: number;
  tokensAfter: number;
  summaryChars: number;
}

export interface CompactSessionOptions {
  store: SessionStore;
  adapter: ModelAdapter;
  /** The system prompt; never summarized, stays first in the next context. */
  system: string;
  contextWindow: number;
  reserve?: number;
  keepRecent?: number;
  signal?: AbortSignal;
}

/**
 * Caller-driven compaction between agent runs: estimates the current view and,
 * when `shouldCompact` fires, summarizes everything but the recent tail and
 * appends one compaction entry plus the summary message through the same
 * append-only `SessionStore.append` seam the agent uses. Returns null when the
 * estimate is under the threshold or the summarizer produced nothing (nothing
 * to do); the caller re-derives the context with `sessionView(store.load())`.
 */
export async function compactSession(
  opts: CompactSessionOptions,
): Promise<CompactionOutcome | null> {
  const reserve = opts.reserve ?? DEFAULT_COMPACTION_RESERVE;
  const keepRecent = opts.keepRecent ?? DEFAULT_COMPACTION_KEEP_RECENT;
  const entries = await opts.store.load(opts.store.id);
  const view = viewWithOrdinals(entries);
  const systemMessage: SystemMessage = { role: "system", content: opts.system };
  const messages: Message[] = [systemMessage, ...view.map((viewed) => viewed.message)];
  const tokensUsed = estimateMessageTokens(messages);
  if (!shouldCompact({ tokensUsed, window: opts.contextWindow, reserve, keepRecent })) {
    return null;
  }
  const kept = await compactConversation({
    adapter: opts.adapter,
    messages,
    keepRecent,
    window: opts.contextWindow,
    reserve,
    signal: opts.signal,
  });
  if (kept.summary.length === 0) return null;
  const loggedCount = entries.reduce(
    (count, entry) => (entry.type === "message" ? count + 1 : count),
    0,
  );
  // keptStart indexes into [system, ...view], so the first kept message is
  // view[keptStart - 1] and its view ordinal is its true log ordinal. Empty
  // kept spans summarize everything: the boundary is the next logged ordinal.
  const firstKept = view[kept.keptStart - 1];
  const entry: CompactionEntry = {
    type: "compaction",
    summary: kept.summary,
    firstKeptMessageIndex: firstKept?.ordinal ?? loggedCount,
    tokensBefore: kept.tokensBefore,
    createdAt: new Date().toISOString(),
  };
  await opts.store.append(entry);
  await opts.store.append({ type: "message", message: compactedSummaryMessage(kept.summary) });
  return {
    tokensBefore: kept.tokensBefore,
    tokensAfter: kept.estimatedAfter,
    summaryChars: kept.summary.length,
  };
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
