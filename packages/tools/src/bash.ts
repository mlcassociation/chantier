import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ToolDefinition } from "@chantier/core";
import { MAX_TOOL_OUTPUT_CHARS, resolveInCwd, truncateOutput } from "./common.ts";

const DEFAULT_TIMEOUT_MS = 120_000;
/** Captured output beyond which the full buffer is spilled to a file instead of being truncated away. */
const SPILL_THRESHOLD = MAX_TOOL_OUTPUT_CHARS + 100_000;
/** Tail length kept in the tool result when a spill happens. */
const SPILL_TAIL_CHARS = 10_000;
/**
 * Absolute last resort: the command is killed once in-memory accumulation passes
 * this (a runaway producer that even a spill file cannot serve within reason).
 */
const HARD_CAP_CHARS = 10 * 1024 * 1024;

export const bashTool: ToolDefinition = {
  name: "bash",
  description:
    "Run a shell command under /bin/sh. stdout and stderr are captured and the exit code is reported. " +
    "Pass `workdir` to run the command in another directory (resolved relative to the project cwd; it must " +
    "already exist). Commands are killed after the timeout (default 120 s). When output exceeds the tool cap, " +
    "the full output is saved to a file under <cwd>/.chantier/spill/ and only the last ~10k characters are " +
    "returned with a header naming the spill file.",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to run" },
      workdir: {
        type: "string",
        description:
          "Directory to run the command in, relative to the project cwd (must exist; default: project cwd)",
      },
      timeoutMs: {
        type: "number",
        description: "Kill the command after this many milliseconds (default 120000)",
      },
    },
    required: ["command"],
  },
  readOnly: false,
  specifier: (input) => (typeof input.command === "string" ? input.command : undefined),
  handler: async (input, ctx) => {
    const command = typeof input.command === "string" ? input.command : undefined;
    if (command === undefined || command.length === 0) {
      return "Error: the `command` argument is required and must be a non-empty string.";
    }
    let runCwd = ctx.cwd;
    const workdirInput = typeof input.workdir === "string" ? input.workdir : undefined;
    if (workdirInput !== undefined) {
      const resolvedWorkdir = resolveInCwd(ctx.cwd, workdirInput);
      const info = await stat(resolvedWorkdir).catch(() => null);
      if (info === null) {
        return `Error: workdir ${resolvedWorkdir} does not exist. Create it first (e.g. bash: mkdir -p ${workdirInput}) or pass a directory that exists under ${ctx.cwd}.`;
      }
      if (!info.isDirectory()) {
        return `Error: workdir ${resolvedWorkdir} is not a directory. Pass a directory path.`;
      }
      runCwd = resolvedWorkdir;
    }
    const timeoutMs =
      typeof input.timeoutMs === "number" && input.timeoutMs > 0
        ? Math.floor(input.timeoutMs)
        : DEFAULT_TIMEOUT_MS;

    return truncateOutput(await runShell(command, runCwd, timeoutMs, ctx.signal));
  },
};

function runShell(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<string> {
  const { promise, resolve } = Promise.withResolvers<string>();
  const child = spawn("/bin/sh", ["-c", command], {
    cwd,
    signal,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true, // own process group: timeout kill takes down child grandchildren too
  });
  let stdout = "";
  let stderr = "";
  let hardCapped = false;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const killTree = () => {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  };

  const hardCapTimer = setInterval(() => {
    if (stdout.length + stderr.length > HARD_CAP_CHARS) {
      hardCapped = true;
      killTree();
    }
  }, 250);

  const timer = setTimeout(killTree, timeoutMs);

  const finish = (result: string) => {
    clearTimeout(timer);
    clearInterval(hardCapTimer);
    resolve(result);
  };

  child.on("error", (error) => {
    finish(`\nError: failed to spawn shell: ${error.message}`);
  });

  child.on("close", (code, signalKilled) => {
    void finalize(code, signalKilled);
  });

  const finalize = async (code: number | null, signalKilled: NodeJS.Signals | null) => {
    const combined = `${stdout}${stderr.length > 0 ? (stdout.length > 0 ? "\n--- stderr ---\n" : "") + stderr : ""}`;
    let body = combined;
    if (combined.length > SPILL_THRESHOLD) {
      body = await spilledBody(combined, cwd, command, hardCapped);
    }
    finish(`${body}${exitTail(code, signalKilled, timeoutMs)}`);
  };
  return promise;
}

/** Header + tail for an over-cap run; undefined spillPath falls back to a truncated body. */
async function spilledBody(
  combined: string,
  cwd: string,
  command: string,
  hardCapped: boolean,
): Promise<string> {
  const spillPath = await writeSpillFile(combined, cwd, command);
  if (spillPath === undefined) {
    return `[output exceeded cap (${combined.length} chars) and the spill file could not be written]\n${combined.slice(0, MAX_TOOL_OUTPUT_CHARS)}`;
  }
  const tail = combined.slice(Math.max(0, combined.length - SPILL_TAIL_CHARS));
  const capNote = hardCapped
    ? `[command killed: accumulated output passed the 10 MB in-memory cap]\n`
    : "";
  return `${capNote}[output exceeded cap \u2014 full output (${combined.length} chars) saved to ${spillPath}]\n${tail}`;
}

/** Writes the full captured output to <cwd>/.chantier/spill/<iso>-<sha8(command)>.txt. */
async function writeSpillFile(
  combined: string,
  cwd: string,
  command: string,
): Promise<string | undefined> {
  try {
    const spillDir = path.join(cwd, ".chantier", "spill");
    await mkdir(spillDir, { recursive: true });
    const stamp = new Date().toISOString();
    const hash = createHash("sha256").update(command).digest("hex").slice(0, 8);
    const spillPath = path.join(spillDir, `${stamp}-${hash}.txt`);
    await writeFile(spillPath, combined, "utf8");
    return spillPath;
  } catch {
    return undefined;
  }
}

function exitTail(
  code: number | null,
  signalKilled: NodeJS.Signals | null,
  timeoutMs: number,
): string {
  if (signalKilled !== null && (signalKilled === "SIGKILL" || signalKilled === "SIGTERM")) {
    return `\nCommand killed (signal ${signalKilled}) after ${timeoutMs} ms.`;
  }
  const benignOne =
    code === 1
      ? ` (exit 1 \u2014 commonly means "no results" for grep/rg/diff/test; not necessarily an error)`
      : "";
  return `\nExit code: ${code === null ? `signal ${String(signalKilled)}` : `${code}${benignOne}`}`;
}
