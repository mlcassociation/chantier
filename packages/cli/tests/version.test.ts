import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);

const cliDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("cli --version", () => {
  it("prints the package.json version — banner can never drift from the manifest", async () => {
    const pkg = JSON.parse(await readFile(path.join(cliDir, "package.json"), "utf8")) as {
      version?: string;
    };
    // Exercise the real entry point: node's --import tsx runs the TS source
    // directly. The development condition is what every workspace manifest's
    // exports map checks first, mirroring the vitest resolution (src, not dist).
    const { stdout } = await run(
      process.execPath,
      [
        "--conditions=development",
        "--import",
        "tsx",
        path.join(cliDir, "src", "index.ts"),
        "--version",
      ],
      { cwd: cliDir },
    );
    expect(stdout.trim()).toBe(pkg.version);
  });
});
