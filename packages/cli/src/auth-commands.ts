import { readFile } from "node:fs/promises";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { type Readable, Writable } from "node:stream";
import type { ProviderConfig } from "@chantier/providers";
import { type AuthCommandSpec, parseAuthArgs } from "./args.ts";
import {
  type AuthProviderName,
  authFileMode,
  authFilePath,
  defaultAuthRoot,
  isKnownAuthProvider,
  KNOWN_AUTH_PROVIDERS,
  loadAuth,
  maskApiKey,
  PROVIDER_ENV_KEYS,
  removeProvider,
  resolveApiKey,
  saveProvider,
} from "./auth.ts";
import { loadConfig } from "./config.ts";

const AUTH_USAGE = `chantier auth — manage stored provider API keys

Usage:
  chantier auth login [provider]   Store an API key for a provider
  chantier auth status             Show configured providers and masked keys
  chantier auth logout [provider]  Remove a stored API key

Options:
  --provider <name>       anthropic | openai-compatible (positional or flag)
  --api-key-file <path>   Read the key from a file, or "-" for stdin (scripts)
  -h, --help              Show this help

Providers: anthropic, openai-compatible (Ollama and OpenAI-compatible endpoints).
Keys live in ~/.chantier/auth.json (chmod 0600). Typed input is hidden and the
key is never printed back; "status" shows a masked form.`;

export interface AuthCommandIo {
  stdin: Readable;
  stdout: Writable;
  stderr: Writable;
  /** Whether stdin is an interactive terminal. */
  isTTY: boolean;
  env: NodeJS.ProcessEnv;
}

export interface AuthCommandOptions extends Partial<Omit<AuthCommandIo, "env">> {
  /** Root directory holding auth.json/config.json; defaults to ~/.chantier. */
  root?: string;
  env?: NodeJS.ProcessEnv;
}

export type KeySource = "config.json" | "auth.json" | "env";

export interface KeyResolution {
  key: string;
  source: KeySource;
}

const AUTH_PROVIDER_FOR_ADAPTER: Record<string, AuthProviderName> = {
  anthropic: "anthropic",
  ollama: "openai-compatible",
};

/** Maps an adapter/provider name onto its auth.json slot ("ollama" → "openai-compatible"). */
export function authProviderForAdapter(adapterProvider: string): AuthProviderName | undefined {
  return AUTH_PROVIDER_FOR_ADAPTER[adapterProvider];
}

/** The explicit config.json key slot for a provider (accepts both name spellings). */
export function configKeyFor(config: ProviderConfig, provider: string): string | undefined {
  const name = provider === "openai-compatible" ? "ollama" : provider;
  if (name === "anthropic") return config.anthropic?.apiKey;
  if (name === "ollama") return config.ollama?.apiKey;
  return undefined;
}

/**
 * Resolution order for a provider key: explicit config.json `apiKey`, then
 * auth.json, then the standard env vars. Undefined = nothing configured; the
 * adapter layer owns the final corrective error.
 */
export async function resolveProviderKey(options: {
  provider: AuthProviderName;
  configApiKey?: string;
  root?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<KeyResolution | undefined> {
  if (options.configApiKey !== undefined && options.configApiKey.length > 0) {
    return { key: options.configApiKey, source: "config.json" };
  }
  const authKey = await resolveApiKey(options.root, options.provider);
  if (authKey !== null) return { key: authKey, source: "auth.json" };
  const env = options.env ?? process.env;
  for (const name of PROVIDER_ENV_KEYS[options.provider]) {
    const value = env[name];
    if (typeof value === "string" && value.length > 0) return { key: value, source: "env" };
  }
  return undefined;
}

/** Entry point for `chantier auth <sub>`; argv excludes the leading "auth". */
export async function runAuthCommand(
  argv: readonly string[],
  options: AuthCommandOptions = {},
): Promise<number> {
  const io: AuthCommandIo = {
    stdin: options.stdin ?? process.stdin,
    stdout: options.stdout ?? process.stdout,
    stderr: options.stderr ?? process.stderr,
    isTTY: options.isTTY ?? process.stdin.isTTY === true,
    env: options.env ?? process.env,
  };
  const root = options.root ?? defaultAuthRoot();
  try {
    const spec = parseAuthArgs(argv);
    if (spec.command === undefined || spec.help) {
      io.stdout.write(`${AUTH_USAGE}\n`);
      return 0;
    }
    if (spec.command === "login") return await runLogin(spec, io, root);
    if (spec.command === "status") return await runStatus(io, root);
    return await runLogout(spec, io, root);
  } catch (error) {
    io.stderr.write(`Error: ${(error as Error).message}\n\n${AUTH_USAGE}\n`);
    return 2;
  }
}

async function runLogin(spec: AuthCommandSpec, io: AuthCommandIo, root: string): Promise<number> {
  const provider = await resolveProviderArg(spec, io);
  let raw: string;
  if (spec.apiKeyFile !== undefined) {
    raw =
      spec.apiKeyFile === "-"
        ? await readAllStdin(io.stdin)
        : await readFile(spec.apiKeyFile, "utf8");
  } else if (io.isTTY) {
    raw = await promptHidden(`Paste API key for ${provider} (input hidden): `, io);
  } else {
    raw = await readAllStdin(io.stdin);
  }
  const apiKey = raw.trim();
  if (apiKey.length === 0) {
    throw new Error(`Empty API key for ${provider}; nothing was saved.`);
  }
  await saveProvider(root, provider, apiKey);
  io.stdout.write(
    `Saved ${provider} API key (${maskApiKey(apiKey)}) to ${authFilePath(root)}; file permissions 0600.\n`,
  );
  return 0;
}

async function runStatus(io: AuthCommandIo, root: string): Promise<number> {
  const config = await loadConfig({ root, quiet: true });
  await loadAuth(root); // surface a corrupt store with a clear error before rendering
  const file = authFilePath(root);
  const mode = await authFileMode(root);
  const storeNote =
    mode === null ? "not created yet (run `chantier auth login`)" : `mode 0${mode.toString(8)}`;
  io.stdout.write(`Auth store: ${file} (${storeNote})\n\n`);
  const rows: { provider: string; configured: string; key: string; source: string }[] = [];
  const hints: string[] = [];
  for (const provider of KNOWN_AUTH_PROVIDERS) {
    const resolution = await resolveProviderKey({
      provider,
      configApiKey: configKeyFor(config, provider),
      root,
      env: io.env,
    });
    if (resolution === undefined) {
      rows.push({ provider, configured: "no", key: "-", source: "-" });
      hints.push(`not configured: chantier auth login --provider ${provider}`);
    } else {
      rows.push({
        provider,
        configured: "yes",
        key: maskApiKey(resolution.key),
        source: resolution.source,
      });
    }
  }
  const providerWidth = Math.max(...rows.map((row) => row.provider.length)) + 2;
  for (const row of rows) {
    io.stdout.write(
      `${row.provider.padEnd(providerWidth)}${row.configured.padEnd(12)}${row.key.padEnd(15)}${row.source}\n`,
    );
  }
  for (const hint of hints) io.stdout.write(`${hint}\n`);
  return 0;
}

async function runLogout(spec: AuthCommandSpec, io: AuthCommandIo, root: string): Promise<number> {
  const provider = await resolveProviderArg(spec, io);
  const removed = await removeProvider(root, provider);
  io.stdout.write(
    removed
      ? `Removed the stored ${provider} API key from ${authFilePath(root)}.\n`
      : `No stored API key for ${provider} in ${authFilePath(root)}.\n`,
  );
  return 0;
}

async function resolveProviderArg(
  spec: AuthCommandSpec,
  io: AuthCommandIo,
): Promise<AuthProviderName> {
  let provider = spec.provider;
  if (provider === undefined) {
    if (!io.isTTY) {
      throw new Error(
        "No provider given (non-interactive input). Pass one, e.g. `chantier auth login --provider anthropic`.",
      );
    }
    provider = await chooseProvider(io);
  }
  if (!isKnownAuthProvider(provider)) {
    throw new Error(
      `Unknown provider "${provider}". Known auth providers: ${KNOWN_AUTH_PROVIDERS.join(", ")}.`,
    );
  }
  return provider;
}

/** Numbered provider choice for interactive use; empty answer defaults to anthropic. */
async function chooseProvider(io: AuthCommandIo): Promise<AuthProviderName> {
  io.stdout.write(
    "Select a provider:\n  1. anthropic\n  2. openai-compatible (Ollama or any OpenAI-compatible endpoint)\n",
  );
  const rl = createInterface({ input: io.stdin, output: io.stdout });
  try {
    const answer = (await rl.question("Provider [1]: ")).trim();
    if (answer === "" || answer === "1") return "anthropic";
    if (answer === "2") return "openai-compatible";
    throw new Error(`Invalid provider choice "${answer}"; enter 1 or 2.`);
  } finally {
    rl.close();
  }
}

/** One hidden-prompt question: a readline whose echo bytes are all swallowed. */
export async function promptHidden(question: string, io: AuthCommandIo): Promise<string> {
  const muted = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const rl = createInterface({ input: io.stdin, output: muted, terminal: true });
  try {
    const answer = await rl.question(question);
    io.stdout.write("\n");
    return answer;
  } finally {
    rl.close();
  }
}

async function readAllStdin(stdin: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin as AsyncIterable<Buffer | string>) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
