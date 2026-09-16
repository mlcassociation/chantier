import { createHash, randomBytes } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { SessionEntry, SessionStore } from "./types.ts";

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
  return {
    id,
    dir,
    async append(entry: SessionEntry) {
      await appendFile(file, `${JSON.stringify(entry)}\n`);
    },
    async load(loadId: string) {
      const target = loadId === selfId ? file : path.join(dir, `${loadId}.jsonl`);
      const raw = await readFile(target, "utf8");
      return raw
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as SessionEntry);
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
