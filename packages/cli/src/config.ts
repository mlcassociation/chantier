import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import type { PermissionRules } from "@chantier/permissions";
import type { ProviderConfig } from "@chantier/providers";
import { defaultAuthRoot } from "./auth.ts";

export const DEFAULT_CONFIG: ProviderConfig = {
  provider: "ollama",
  ollama: { baseUrl: "http://127.0.0.1:11434/v1", model: "glm-5.3-flash:cloud" },
  anthropic: { model: "claude-sonnet-4-5" },
};

/** Loads ~/.chantier/config.json, merged over the built-in defaults. */
export async function loadConfig(
  options: { root?: string; quiet?: boolean } = {},
): Promise<ProviderConfig> {
  const root = options.root ?? defaultAuthRoot();
  const file = path.join(root, "config.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      if (options.quiet !== true) {
        process.stderr.write(
          "No ~/.chantier/config.json; using Ollama defaults (http://127.0.0.1:11434/v1). See examples/config.json.\n",
        );
      }
      return DEFAULT_CONFIG;
    }
    throw new Error(`${file} is not valid JSON: ${(error as Error).message}`);
  }
  // JSON.parse boundary: merged value is structurally validated by its consumers.
  return deepMerge(DEFAULT_CONFIG, parsed) as ProviderConfig;
}

export async function loadSettings(): Promise<PermissionRules> {
  const home = await readJsonObjectSafe(path.join(defaultAuthRoot(), "settings.json"));
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
  if (
    typeof base === "object" &&
    base !== null &&
    !Array.isArray(base) &&
    typeof overlay === "object" &&
    overlay !== null &&
    !Array.isArray(overlay)
  ) {
    const merged: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(overlay)) {
      merged[key] = key in merged ? deepMerge(merged[key], value) : value;
    }
    return merged;
  }
  return overlay ?? base;
}

function asStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : undefined;
}
