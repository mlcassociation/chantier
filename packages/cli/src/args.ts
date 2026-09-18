import { parseArgs } from "node:util";

export interface CliArgValues {
  prompt?: string;
  continue?: boolean;
  model?: string;
  "max-turns"?: string;
  yolo?: boolean;
  verbose?: boolean;
  version?: boolean;
  help?: boolean;
  "screen-reader"?: boolean;
  "no-color"?: boolean;
  /** Headless gate: load project skills without the interactive approval. */
  "trust-skills"?: boolean;
  "trust-mcp"?: boolean;
}

export type AuthCommandName = "login" | "status" | "logout";

export interface AuthCommandSpec {
  /** Undefined = no subcommand given (callers print the auth usage). */
  command?: AuthCommandName;
  provider?: string;
  apiKeyFile?: string;
  help: boolean;
}

const AUTH_COMMANDS: readonly AuthCommandName[] = ["login", "status", "logout"];

const AUTH_OPTIONS = {
  provider: { type: "string" },
  "api-key-file": { type: "string" },
  help: { type: "boolean", short: "h" },
} as const;

/**
 * Strict parser for `chantier auth <sub>` argv (without the leading "auth").
 * Unknown flags, unknown subcommands and unexpected positionals throw. The
 * API key itself is deliberately not a flag — only `--api-key-file`.
 */
export function parseAuthArgs(argv: readonly string[]): AuthCommandSpec {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: AUTH_OPTIONS,
    allowPositionals: true,
  });
  const [head, ...rest] = positionals;
  if (head === undefined) {
    if (rest.length > 0) {
      throw new Error(`Unexpected argument "${rest[0]}" before the auth command.`);
    }
    return { command: undefined, help: values.help === true };
  }
  if (!(AUTH_COMMANDS as readonly string[]).includes(head)) {
    throw new Error(`Unknown auth command "${head}". Known commands: ${AUTH_COMMANDS.join(", ")}.`);
  }
  const command = head as AuthCommandName;
  const flagProvider = values.provider;
  const positionalProvider = rest[0];
  if (rest.length > 1) {
    throw new Error(`Unexpected extra argument "${rest[1]}" for \`chantier auth ${command}\`.`);
  }
  if (
    flagProvider !== undefined &&
    positionalProvider !== undefined &&
    flagProvider !== positionalProvider
  ) {
    throw new Error(
      `Conflicting provider arguments: "${positionalProvider}" and --provider "${flagProvider}".`,
    );
  }
  const provider = flagProvider ?? positionalProvider;
  if (command === "status" && provider !== undefined) {
    throw new Error("`chantier auth status` takes no provider argument.");
  }
  return { command, provider, apiKeyFile: values["api-key-file"], help: values.help === true };
}

const OPTIONS = {
  prompt: { type: "string", short: "p" },
  continue: { type: "boolean" },
  model: { type: "string" },
  "max-turns": { type: "string" },
  yolo: { type: "boolean" },
  verbose: { type: "boolean" },
  version: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  "screen-reader": { type: "boolean" },
  "trust-skills": { type: "boolean" },
  "trust-mcp": { type: "boolean" },
  "no-color": { type: "boolean" },
} as const;

/** Strict argv parser: unknown flags throw (callers print usage and exit 2). */
export function parseCliArgs(argv: readonly string[]): CliArgValues {
  return parseArgs({ args: [...argv], options: OPTIONS }).values as CliArgValues;
}
