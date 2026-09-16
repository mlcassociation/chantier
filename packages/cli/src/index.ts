#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import {
  buildSystemPrompt,
  createSessionStore,
  loadNewestSessionId,
  type Message,
  type ModelAdapter,
  resumeSessionStore,
  runAgent,
  type SessionStore,
} from "@chantier/core";
import {
  createAllowAllSink,
  createDenyAllSink,
  createPermissionEngine,
  type PermissionRules,
} from "@chantier/permissions";
import { type ProviderConfig, resolveAdapter } from "@chantier/providers";
import { buildTools } from "@chantier/tools";

const VERSION = "0.1.0";
const DEFAULT_CONFIG: ProviderConfig = {
  provider: "ollama",
  ollama: { baseUrl: "http://127.0.0.1:11434/v1", model: "glm-5.3-flash:cloud" },
  anthropic: { model: "claude-sonnet-4-5" },
};

const USAGE = `chantier ${VERSION} — the readable open-source coding agent (headless core)

Usage:
  chantier -p <prompt> [options]

Options:
  -p, --prompt <text>    The task for the agent (required in v0.1)
      --continue         Resume the newest session for this directory
      --model <spec>     Provider or provider/model (e.g. anthropic/claude-sonnet-4-5, ollama/glm-5.3-flash:cloud)
      --yolo             Approve every mutation automatically (headless default denies them)
      --max-turns <n>    Cap agent turns (default 50)
      --verbose          Print tool calls and results to stderr
      --version          Print the version
  -h, --help             Show this help

Config:   ~/.chantier/config.json   (see examples/config.json)
Settings: ~/.chantier/settings.json ← .chantier/settings.json (allow/ask/deny rules)`;

interface ArgvValues {
  prompt?: string;
  continue?: boolean;
  model?: string;
  "max-turns"?: string;
  yolo?: boolean;
  verbose?: boolean;
  version?: boolean;
  help?: boolean;
}

async function main(): Promise<number> {
  let values: ArgvValues;
  try {
    values = parseArgs({
      options: {
        prompt: { type: "string", short: "p" },
        continue: { type: "boolean" },
        model: { type: "string" },
        "max-turns": { type: "string" },
        yolo: { type: "boolean" },
        verbose: { type: "boolean" },
        version: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    }).values as ArgvValues;
  } catch (error) {
    process.stderr.write(`Error: ${(error as Error).message}\n\n${USAGE}\n`);
    return 2;
  }

  if (values.version === true) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (values.help === true) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const prompt = values.prompt;
  if (prompt === undefined || prompt.length === 0) {
    process.stderr.write("Error: -p <prompt> is required in v0.1.\n\n");
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }

  const config = await loadConfig();
  const { provider: providerOverride, model: modelOverride } =
    values.model === undefined
      ? { provider: undefined, model: undefined }
      : parseModelSpec(values.model);

  let adapter: ModelAdapter;
  try {
    adapter = resolveAdapter(config, providerOverride);
  } catch (error) {
    process.stderr.write(`Error: ${(error as Error).message}\n`);
    return 2;
  }

  const permission = createPermissionEngine(await loadSettings());
  const sink = values.yolo === true ? createAllowAllSink() : createDenyAllSink();
  const tools = buildTools();

  const cwd = process.cwd();
  const provider = providerOverride ?? config.provider ?? "ollama";
  const model =
    modelOverride ?? (provider === "ollama" ? config.ollama?.model : config.anthropic?.model) ?? "";
  let session: SessionStore;
  let messages: Message[] = [];
  if (values.continue === true) {
    const previousId = await loadNewestSessionId(cwd);
    if (previousId === null) {
      process.stderr.write("Error: no previous session to continue for this directory.\n");
      return 2;
    }
    session = await resumeSessionStore({ cwd, id: previousId });
    const entries = await session.load(previousId);
    messages = entries.filter((entry) => entry.type === "message").map((entry) => entry.message);
  } else {
    session = await createSessionStore({ cwd, provider, model });
  }
  const userMessage: Message = { role: "user", content: [{ type: "text", text: prompt }] };
  await session.append({ type: "message", message: userMessage });
  messages.push(userMessage);

  const system = await buildSystemPrompt(cwd, tools);
  const controller = new AbortController();
  process.on("SIGINT", () => {
    controller.abort();
  });

  const maxTurnsArg = values["max-turns"];
  if (maxTurnsArg !== undefined && (!/^\d+$/.test(maxTurnsArg) || Number(maxTurnsArg) <= 0)) {
    process.stderr.write(`Error: --max-turns must be a positive integer, got "${maxTurnsArg}".\n`);
    return 2;
  }

  try {
    for await (const event of runAgent({
      adapter,
      tools,
      permission,
      sink,
      session,
      cwd,
      system,
      messages,
      maxTurns: maxTurnsArg === undefined ? undefined : Number(maxTurnsArg),
      signal: controller.signal,
    })) {
      if (event.type === "text-delta") {
        process.stdout.write(event.text);
      } else if (event.type === "tool-result") {
        process.stderr.write(`→ ${event.toolName}(${formatArgs(event.args)})\n`);
        if (values.verbose === true) {
          const body =
            event.content.length > 500 ? `${event.content.slice(0, 500)}…` : event.content;
          process.stderr.write(`  ${body}\n`);
        }
      } else {
        process.stdout.write("\n");
        const usage = event.usage;
        const tokens =
          usage === undefined ? "" : ` · ${usage.inputTokens} in / ${usage.outputTokens} out`;
        process.stdout.write(`(${event.turns} turn${event.turns === 1 ? "" : "s"}${tokens})\n`);
      }
    }
    return 0;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ABORT_ERR" || (error as Error).name === "AbortError") {
      process.stderr.write("\nInterrupted. Session saved; resume with --continue.\n");
      return 130;
    }
    process.stderr.write(`Error: ${(error as Error).message}\n`);
    return 2;
  }
}

function formatArgs(args: Record<string, unknown>): string {
  const json = JSON.stringify(args) ?? "{}";
  return json.length > 120 ? `${json.slice(0, 120)}…` : json;
}

/** `--model` accepts `provider`, `provider/model`, or a bare model id for the default provider. */
function parseModelSpec(spec: string): { provider?: string; model?: string } {
  const slash = spec.indexOf("/");
  const head = slash === -1 ? spec : spec.slice(0, slash);
  const tail = slash === -1 ? undefined : spec.slice(slash + 1);
  if (head === "ollama" || head === "anthropic") {
    return tail === undefined ? { provider: head } : { provider: head, model: tail };
  }
  return { model: spec };
}

async function loadConfig(): Promise<ProviderConfig> {
  const file = path.join(homedir(), ".chantier", "config.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      process.stderr.write(
        "No ~/.chantier/config.json; using Ollama defaults (http://127.0.0.1:11434/v1). See examples/config.json.\n",
      );
      return DEFAULT_CONFIG;
    }
    throw new Error(`~/.chantier/config.json is not valid JSON: ${(error as Error).message}`);
  }
  // JSON.parse boundary: merged value is structurally validated by its consumers.
  return deepMerge(DEFAULT_CONFIG, parsed) as ProviderConfig;
}

async function loadSettings(): Promise<PermissionRules> {
  const home = await readJsonObjectSafe(path.join(homedir(), ".chantier", "settings.json"));
  const project = await readJsonObjectSafe(path.join(process.cwd(), ".chantier", "settings.json"));
  const merged = deepMerge(home, project) as Record<string, unknown>;
  return {
    allow: asStringArray(merged.allow),
    ask: asStringArray(merged.ask),
    deny: asStringArray(merged.deny),
  };
}

async function readJsonObjectSafe(file: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Objects deep-merge; arrays and scalars replace. */
function deepMerge(base: unknown, overlay: unknown): unknown {
  if (Array.isArray(base) || Array.isArray(overlay)) return overlay ?? base;
  if (isPlainObject(base) && isPlainObject(overlay)) {
    const merged: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(overlay)) {
      merged[key] = key in merged ? deepMerge(merged[key], value) : value;
    }
    return merged;
  }
  return overlay ?? base;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : undefined;
}

process.exitCode = await main();
