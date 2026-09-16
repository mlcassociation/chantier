import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Stored provider API keys. The file lives at `~/.chantier/auth.json`, is
 * written with owner-only permissions (0600) at creation and on every rewrite,
 * and never leaves this module with its contents echoed anywhere.
 */
export const KNOWN_AUTH_PROVIDERS = ["anthropic", "openai-compatible"] as const;

export type AuthProviderName = (typeof KNOWN_AUTH_PROVIDERS)[number];

/** Env vars consulted per provider, in precedence order (mirrors the adapters). */
export const PROVIDER_ENV_KEYS: Record<AuthProviderName, readonly string[]> = {
  anthropic: ["CHANTIER_ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY"],
  "openai-compatible": ["OPENAI_API_KEY"],
};

export interface AuthProviderEntry {
  apiKey: string;
  updatedAt: string;
}

export interface AuthFile {
  version: 1;
  providers: Record<string, AuthProviderEntry>;
}

export function defaultAuthRoot(): string {
  return path.join(homedir(), ".chantier");
}

export function authFilePath(root: string = defaultAuthRoot()): string {
  return path.join(root, "auth.json");
}

export function isKnownAuthProvider(provider: string): provider is AuthProviderName {
  return (KNOWN_AUTH_PROVIDERS as readonly string[]).includes(provider);
}

function assertKnownAuthProvider(provider: string): void {
  if (!isKnownAuthProvider(provider)) {
    throw new Error(
      `Unknown provider "${provider}". Known auth providers: ${KNOWN_AUTH_PROVIDERS.join(", ")}.`,
    );
  }
}

function parseAuthFile(raw: unknown, file: string): AuthFile {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${file} must contain a JSON object.`);
  }
  const source = raw as Record<string, unknown>;
  if (source.version !== 1) {
    throw new Error(`${file} has unsupported version ${String(source.version)}; expected 1.`);
  }
  const rawProviders = source.providers;
  if (typeof rawProviders !== "object" || rawProviders === null || Array.isArray(rawProviders)) {
    throw new Error(`${file} "providers" must be an object.`);
  }
  const providers: Record<string, AuthProviderEntry> = {};
  for (const [name, entry] of Object.entries(rawProviders as Record<string, unknown>)) {
    const entryRecord =
      typeof entry === "object" && entry !== null && !Array.isArray(entry)
        ? (entry as Record<string, unknown>)
        : undefined;
    if (
      entryRecord === undefined ||
      typeof entryRecord.apiKey !== "string" ||
      entryRecord.apiKey.length === 0
    ) {
      throw new Error(
        `${file} entry "${name}" must map to an object with a non-empty "apiKey" string.`,
      );
    }
    const updatedAt = entryRecord.updatedAt;
    providers[name] = {
      apiKey: entryRecord.apiKey,
      updatedAt: typeof updatedAt === "string" ? updatedAt : "",
    };
  }
  return { version: 1, providers };
}

export async function loadAuth(root: string = defaultAuthRoot()): Promise<AuthFile> {
  const file = authFilePath(root);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, providers: {} };
    }
    throw new Error(`Cannot read ${file}: ${(error as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${(error as Error).message}`);
  }
  return parseAuthFile(parsed, file);
}

async function writeAuthFile(root: string, auth: AuthFile): Promise<void> {
  const file = authFilePath(root);
  await mkdir(root, { recursive: true });
  // Atomic replace through a 0600 temp sibling: the key material is never
  // readable beyond owner at any point, even mid-write. rename() swaps the
  // inode wholesale, so a pre-existing looser file cannot leak the new bytes.
  const temp = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temp, "w", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(auth, null, 2)}\n`, "utf8");
  } finally {
    await handle.close();
  }
  try {
    await rename(temp, file);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
  // Enforce 0600 on every rewrite, whatever the previous mode was.
  await chmod(file, 0o600);
}

export async function saveProvider(root: string, provider: string, apiKey: string): Promise<void> {
  assertKnownAuthProvider(provider);
  if (apiKey.length === 0) {
    throw new Error(`Refusing to store an empty API key for ${provider}.`);
  }
  const auth = await loadAuth(root);
  auth.providers[provider] = { apiKey, updatedAt: new Date().toISOString() };
  await writeAuthFile(root, auth);
}

/** Removes one entry; the file stays (possibly with empty `providers`), re-chmodded 0600. */
export async function removeProvider(root: string, provider: string): Promise<boolean> {
  assertKnownAuthProvider(provider);
  const auth = await loadAuth(root);
  if (!(provider in auth.providers)) return false;
  delete auth.providers[provider];
  await writeAuthFile(root, auth);
  return true;
}

/** The stored key for a provider, or null when auth.json holds none. */
export async function resolveApiKey(
  root: string | undefined,
  provider: AuthProviderName,
): Promise<string | null> {
  const auth = await loadAuth(root);
  const entry = auth.providers[provider];
  return entry === undefined ? null : entry.apiKey;
}

/** File mode of auth.json, or null when the file does not exist yet. */
export async function authFileMode(root: string = defaultAuthRoot()): Promise<number | null> {
  try {
    return (await stat(authFilePath(root))).mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** `sk-ant-…f3a9` style mask (first 6 + last 4); `configured` below 12 chars. */
export function maskApiKey(key: string): string {
  return key.length >= 12 ? `${key.slice(0, 6)}…${key.slice(-4)}` : "configured";
}
