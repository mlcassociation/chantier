#!/usr/bin/env node
import process from "node:process";
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
  createRememberingEngine,
} from "@chantier/permissions";
import { resolveAdapter } from "@chantier/providers";
import { buildTools } from "@chantier/tools";
import { type CliArgValues, parseCliArgs } from "./args.ts";
import {
  authProviderForAdapter,
  configKeyFor,
  resolveProviderKey,
  runAuthCommand,
} from "./auth-commands.ts";
import { disableColors } from "./color.ts";
import { loadConfig, loadSettings } from "./config.ts";
import { runInteractive } from "./interactive.ts";

const VERSION = "0.1.0";

const USAGE = `chantier ${VERSION} — the readable open-source coding agent (headless core)

Usage:
  chantier -p <prompt> [options]   headless run
  chantier [options]               interactive TUI (needs a TTY)

Options:
  -p, --prompt <text>    The task for the agent (omit for the interactive TUI)
      --continue         Resume the newest session for this directory
      --model <spec>     Provider or provider/model (e.g. anthropic/claude-sonnet-4-5, ollama/glm-5.3-flash:cloud)
      --yolo             Approve every mutation automatically (headless default denies them)
      --max-turns <n>    Cap agent turns (default 50)
      --verbose          Print tool calls and results to stderr
      --screen-reader   Screen-reader mode: flat labeled output, aria hints (alias: CHANTIER_SCREEN_READER=1)
      --no-color        Disable color output (alias: NO_COLOR)
      --version          Print the version
  -h, --help             Show this help

Auth:     chantier auth login [provider]   store an API key in ~/.chantier/auth.json (0600)
          chantier auth status             masked keys + source per provider
          chantier auth logout [provider]  remove a stored key
          login flags: --provider <p>, --api-key-file <path> ("-" reads stdin)
          key order: config.json apiKey → auth.json → ANTHROPIC_API_KEY / OPENAI_API_KEY

Config:   ~/.chantier/config.json   (see examples/config.json)
Settings: ~/.chantier/settings.json ← .chantier/settings.json (allow/ask/deny rules)`;

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv[0] === "auth") {
    return runAuthCommand(argv.slice(1));
  }
  let values: CliArgValues;
  try {
    values = parseCliArgs(argv);
  } catch (error) {
    process.stderr.write(`Error: ${(error as Error).message}\n\n${USAGE}\n`);
    return 2;
  }
  disableColors(values["no-color"], process.env.NO_COLOR);

  if (values.version === true) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (values.help === true) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const prompt = values.prompt;
  const interactive = prompt === undefined || prompt.length === 0;
  if (interactive && process.stdout.isTTY !== true) {
    process.stderr.write(
      "Error: interactive mode needs a TTY; pass -p <prompt> for headless runs.\n\n",
    );
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }

  const config = await loadConfig();
  const { provider: providerOverride, model: modelOverride } =
    values.model === undefined
      ? { provider: undefined, model: undefined }
      : parseModelSpec(values.model);

  const provider = providerOverride ?? config.provider ?? "ollama";
  const model =
    modelOverride ?? (provider === "ollama" ? config.ollama?.model : config.anthropic?.model) ?? "";

  let adapter: ModelAdapter;
  try {
    // Key order: explicit config.json apiKey → auth.json → standard env vars
    // (the env fallback stays inside the adapter factories). No key is echoed.
    const authProvider = authProviderForAdapter(provider);
    const resolution =
      authProvider === undefined
        ? undefined
        : await resolveProviderKey({
            provider: authProvider,
            configApiKey: configKeyFor(config, provider),
          });
    adapter = resolveAdapter(config, providerOverride, resolution?.key);
  } catch (error) {
    process.stderr.write(`Error: ${(error as Error).message}\n`);
    return 2;
  }

  const permission = createPermissionEngine(await loadSettings());
  const sink = values.yolo === true ? createAllowAllSink() : createDenyAllSink();
  const tools = buildTools();

  const cwd = process.cwd();
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
  const system = await buildSystemPrompt(cwd, tools);
  const maxTurnsArg = values["max-turns"];
  if (maxTurnsArg !== undefined && (!/^\d+$/.test(maxTurnsArg) || Number(maxTurnsArg) <= 0)) {
    process.stderr.write(`Error: --max-turns must be a positive integer, got "${maxTurnsArg}".\n`);
    return 2;
  }
  const maxTurns = maxTurnsArg === undefined ? undefined : Number(maxTurnsArg);

  if (interactive) {
    const remembering = createRememberingEngine(permission);
    return runInteractive({
      adapter,
      tools,
      permission: remembering,
      session,
      cwd,
      system,
      messages,
      maxTurns,
      screenReader: values["screen-reader"],
    });
  }

  const userMessage: Message = { role: "user", content: [{ type: "text", text: prompt ?? "" }] };
  await session.append({ type: "message", message: userMessage });
  messages.push(userMessage);

  const controller = new AbortController();
  process.on("SIGINT", () => {
    controller.abort();
  });

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

process.exitCode = await main();
