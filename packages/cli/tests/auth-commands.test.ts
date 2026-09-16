import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { authFilePath, loadAuth, removeProvider, saveProvider } from "../src/auth.ts";
import { promptHidden, resolveProviderKey, runAuthCommand } from "../src/auth-commands.ts";

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "chantier-authcli-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  roots.length = 0;
});

interface Sink {
  stream: Writable;
  text: () => string;
}

function sink(): Sink {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk);
      callback();
    },
  });
  return { stream, text: () => Buffer.concat(chunks).toString("utf8") };
}

const EMPTY_ENV: NodeJS.ProcessEnv = {};

async function statusText(root: string, env: NodeJS.ProcessEnv = EMPTY_ENV): Promise<string> {
  const out = sink();
  const code = await runAuthCommand(["status"], {
    root,
    stdout: out.stream,
    stderr: sink().stream,
    isTTY: false,
    env,
  });
  expect(code).toBe(0);
  return out.text();
}

describe("chantier auth login", () => {
  it("stores a key from --api-key-file without printing it", async () => {
    const root = await makeRoot();
    const keyFile = path.join(root, "key.txt");
    await writeFile(keyFile, "sk-ant-filestored-9876\n");
    const out = sink();
    const err = sink();
    const code = await runAuthCommand(
      ["login", "--provider", "anthropic", "--api-key-file", keyFile],
      {
        root,
        stdout: out.stream,
        stderr: err.stream,
        isTTY: false,
        env: {},
      },
    );
    expect(code).toBe(0);
    expect((await loadAuth(root)).providers.anthropic?.apiKey).toBe("sk-ant-filestored-9876");
    const output = `${out.text()}${err.text()}`;
    expect(output).not.toContain("sk-ant-filestored-9876");
    expect(output).toContain("sk-ant…9876");
    expect(output).toContain("0600");
    expect((await stat(authFilePath(root))).mode & 0o777).toBe(0o600);
  });

  it("reads the key from piped stdin when non-interactive", async () => {
    const root = await makeRoot();
    const out = sink();
    const code = await runAuthCommand(["login", "anthropic"], {
      root,
      stdin: Readable.from(["sk-ant-pipedstdin-5544\n"]),
      stdout: out.stream,
      stderr: sink().stream,
      isTTY: false,
      env: {},
    });
    expect(code).toBe(0);
    expect((await loadAuth(root)).providers.anthropic?.apiKey).toBe("sk-ant-pipedstdin-5544");
    expect(out.text()).not.toContain("sk-ant-pipedstdin-5544");
  });

  it("requires --provider when stdin is not a TTY", async () => {
    const root = await makeRoot();
    const err = sink();
    const code = await runAuthCommand(["login"], {
      root,
      stdin: Readable.from([]),
      stdout: sink().stream,
      stderr: err.stream,
      isTTY: false,
      env: {},
    });
    expect(code).toBe(2);
    expect(err.text()).toContain("No provider given");
  });

  it("rejects unknown provider names with the known list", async () => {
    const root = await makeRoot();
    const err = sink();
    const code = await runAuthCommand(["login", "bedrock", "--api-key-file", "-"], {
      root,
      stdin: Readable.from([]),
      stdout: sink().stream,
      stderr: err.stream,
      isTTY: false,
      env: {},
    });
    expect(code).toBe(2);
    expect(err.text()).toContain('Unknown provider "bedrock"');
    expect(err.text()).toContain("anthropic, openai-compatible");
  });

  it("exits 2 with a clear error on an empty key", async () => {
    const root = await makeRoot();
    const err = sink();
    const code = await runAuthCommand(["login", "anthropic"], {
      root,
      stdin: Readable.from(["   \n"]),
      stdout: sink().stream,
      stderr: err.stream,
      isTTY: false,
      env: {},
    });
    expect(code).toBe(2);
    expect(err.text()).toContain("Empty API key for anthropic");
  });

  it("offers the numbered provider choice when interactive and no provider given", async () => {
    const root = await makeRoot();
    const keyFile = path.join(root, "key.txt");
    await writeFile(keyFile, "sk-ollama-choice-1111");
    const out = sink();
    const code = await runAuthCommand(["login", "--api-key-file", keyFile], {
      root,
      stdin: Readable.from(["2\n"]),
      stdout: out.stream,
      stderr: sink().stream,
      isTTY: true,
      env: {},
    });
    expect(code).toBe(0);
    expect(out.text()).toContain("Select a provider:");
    expect((await loadAuth(root)).providers["openai-compatible"]?.apiKey).toBe(
      "sk-ollama-choice-1111",
    );
  });

  it("rejects an invalid provider choice", async () => {
    const root = await makeRoot();
    const err = sink();
    const code = await runAuthCommand(["login", "--api-key-file", path.join(root, "nope")], {
      root,
      stdin: Readable.from(["9\n"]),
      stdout: sink().stream,
      stderr: err.stream,
      isTTY: true,
      env: {},
    });
    expect(code).toBe(2);
    expect(err.text()).toContain('Invalid provider choice "9"');
  });

  it("hides typed input behind the muted readline", async () => {
    const out = sink();
    const answer = await promptHidden("Paste API key (input hidden): ", {
      stdin: Readable.from(["sk-ant-hiddenprompt-31\n"]),
      stdout: out.stream,
      stderr: sink().stream,
      isTTY: true,
      env: {},
    });
    expect(answer).toBe("sk-ant-hiddenprompt-31");
    expect(out.text()).not.toContain("sk-ant-hiddenprompt-31");
  });
});

describe("chantier auth status", () => {
  it("masks keys and reports the resolution source without leaking material", async () => {
    const root = await makeRoot();
    await saveProvider(root, "anthropic", "sk-ant-authsource-7777");
    const out = sink();
    const code = await runAuthCommand(["status"], {
      root,
      stdout: out.stream,
      stderr: sink().stream,
      isTTY: false,
      env: {},
    });
    expect(code).toBe(0);
    const text = out.text();
    expect(text).toContain("anthropic");
    expect(text).toContain("sk-ant…7777");
    expect(text).toContain("auth.json");
    expect(text).toContain("mode 0600");
    expect(text).not.toContain("sk-ant-authsource-7777");
    expect(text).toContain("chantier auth login --provider openai-compatible");
  });

  it("shows env-sourced keys for the openai-compatible provider", async () => {
    const root = await makeRoot();
    const text = await statusText(root, { OPENAI_API_KEY: "sk-ollama-envkey-4242" });
    expect(text).toContain("sk-oll…4242");
    expect(text).toContain("env");
    expect(text).not.toContain("sk-ollama-envkey-4242");
  });

  it("reports the not-created store before the first login", async () => {
    const root = await makeRoot();
    const text = await statusText(root);
    expect(text).toContain("not created yet");
  });
});

describe("chantier auth logout", () => {
  it("removes only the requested provider and keeps the store usable", async () => {
    const root = await makeRoot();
    await saveProvider(root, "anthropic", "sk-ant-logout-9999");
    await saveProvider(root, "openai-compatible", "sk-ollama-logout-8888");
    const out = sink();
    const code = await runAuthCommand(["logout", "anthropic"], {
      root,
      stdout: out.stream,
      stderr: sink().stream,
      isTTY: false,
      env: {},
    });
    expect(code).toBe(0);
    const auth = await loadAuth(root);
    expect(auth.providers.anthropic).toBeUndefined();
    expect(auth.providers["openai-compatible"]?.apiKey).toBe("sk-ollama-logout-8888");
    expect(out.text()).not.toContain("sk-ant-logout-9999");
    // Second logout is idempotent.
    const again = sink();
    const codeAgain = await runAuthCommand(["logout", "anthropic"], {
      root,
      stdout: again.stream,
      stderr: sink().stream,
      isTTY: false,
      env: {},
    });
    expect(codeAgain).toBe(0);
    expect(again.text()).toContain("No stored API key for anthropic");
  });
});

describe("key resolution order", () => {
  it("prefers config.json over auth.json over env", async () => {
    const root = await makeRoot();
    await writeFile(
      path.join(root, "config.json"),
      JSON.stringify({ anthropic: { apiKey: "sk-config-1234567890ab" } }),
    );
    await saveProvider(root, "anthropic", "sk-authfile-1234567890");
    const configFirst = await resolveProviderKey({
      provider: "anthropic",
      configApiKey: "sk-config-1234567890ab",
      root,
      env: { ANTHROPIC_API_KEY: "sk-env-1234567890ab" },
    });
    expect(configFirst).toEqual({ key: "sk-config-1234567890ab", source: "config.json" });
    const authSecond = await resolveProviderKey({
      provider: "anthropic",
      configApiKey: undefined,
      root,
      env: { ANTHROPIC_API_KEY: "sk-env-1234567890ab" },
    });
    expect(authSecond).toEqual({ key: "sk-authfile-1234567890", source: "auth.json" });
    expect(await removeProvider(root, "anthropic")).toBe(true);
    const envThird = await resolveProviderKey({
      provider: "anthropic",
      root,
      env: { ANTHROPIC_API_KEY: "sk-env-1234567890ab" },
    });
    expect(envThird).toEqual({ key: "sk-env-1234567890ab", source: "env" });
    expect(await resolveProviderKey({ provider: "anthropic", root, env: {} })).toBeUndefined();
  });

  it("maps the ollama adapter name onto the openai-compatible auth slot", async () => {
    const root = await makeRoot();
    await saveProvider(root, "openai-compatible", "sk-ollama-slot-1212");
    const auth = await loadAuth(root);
    const stored = await readFile(authFilePath(root), "utf8");
    expect(stored).toContain("openai-compatible");
    expect(auth.providers["openai-compatible"]?.apiKey).toBe("sk-ollama-slot-1212");
  });
});
