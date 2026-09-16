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
  "no-color": { type: "boolean" },
} as const;

/** Strict argv parser: unknown flags throw (callers print usage and exit 2). */
export function parseCliArgs(argv: readonly string[]): CliArgValues {
  return parseArgs({ args: [...argv], options: OPTIONS }).values as CliArgValues;
}
