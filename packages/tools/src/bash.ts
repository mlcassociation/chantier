import { spawn } from "node:child_process";
import type { ToolDefinition } from "@chantier/core";
import { MAX_TOOL_OUTPUT_CHARS, truncateOutput } from "./common.ts";

const DEFAULT_TIMEOUT_MS = 120_000;

export const bashTool: ToolDefinition = {
  name: "bash",
  description:
    "Run a shell command under /bin/sh in the project cwd. stdout and stderr are captured and the " +
    "exit code is reported. Commands are killed after the timeout (default 120 s).",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to run" },
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
    const timeoutMs =
      typeof input.timeoutMs === "number" && input.timeoutMs > 0
        ? Math.floor(input.timeoutMs)
        : DEFAULT_TIMEOUT_MS;

    return truncateOutput(await runShell(command, ctx.cwd, timeoutMs, ctx.signal));
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
  // Cap accumulation: stop buffering well beyond the truncation cap so a runaway
  // producer cannot balloon memory, and kill the tree once the cap is hit.
  const ACCUMULATION_CAP = MAX_TOOL_OUTPUT_CHARS + 100_000;
  let stdout = "";
  let stderr = "";
  let capped = false;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    if (stdout.length > ACCUMULATION_CAP || stderr.length > ACCUMULATION_CAP) return;
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    if (stdout.length > ACCUMULATION_CAP || stderr.length > ACCUMULATION_CAP) return;
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

  const capTimer = setInterval(() => {
    if (stdout.length > ACCUMULATION_CAP || stderr.length > ACCUMULATION_CAP) {
      capped = true;
      killTree();
    }
  }, 250);

  const timer = setTimeout(killTree, timeoutMs);

  const finish = (tail: string) => {
    clearTimeout(timer);
    clearInterval(capTimer);
    const capNote = capped ? "\n[output capped; command killed]" : "";
    resolve(`${stdout}${stderr ? (stdout ? "\n--- stderr ---\n" : "") + stderr : ""}${capNote}${tail}`);
  };

  child.on("error", (error) => {
    finish(`\nError: failed to spawn shell: ${error.message}`);
  });
  child.on("close", (code, signalKilled) => {
    if (signalKilled !== null && (signalKilled === "SIGKILL" || signalKilled === "SIGTERM")) {
      finish(`\nCommand killed (signal ${signalKilled}) after ${timeoutMs} ms.`);
      return;
    }
    finish(`\nExit code: ${code === null ? `signal ${String(signalKilled)}` : code}`);
  });
  return promise;
}
