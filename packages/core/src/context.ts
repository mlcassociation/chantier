import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { ToolDefinition } from "./types.ts";

/** Tool-usage rules the model needs to drive the harness correctly. */
const TOOL_RULES = `
# Tool usage rules

- Paths are relative to the project cwd unless you pass an absolute path deliberately.
- Protected paths (.env, .env.*, *.pem, id_rsa*, ~/.ssh) are refused by the harness; do not retry them.
- read returns numbered lines; use offset/limit to window big files instead of re-reading everything.
- edit requires an exact unique oldString; include surrounding context when text is not unique.
- write refuses to overwrite a multi-line file without overwrite: true; prefer edit for targeted changes.
- Tool output is truncated at a character cap; note the [truncated] marker and read narrower ranges.
`;

const IDENTITY = `You are chantier, a terminal coding agent. You work inside the user's project directory:
read before you write, make surgical edits, and explain what you did in one short paragraph at the end
of a task. When a mutation is denied, state it plainly and continue with what is allowed.`;

/** Builds the system prompt: identity + tool rules + every AGENTS.md from cwd up to the git root. */
export async function buildSystemPrompt(cwd: string, tools: ToolDefinition[]): Promise<string> {
  const toolCatalog = tools
    .map(
      (tool) =>
        `- ${tool.name}${tool.readOnly ? " (read-only)" : ""}: ${tool.description.split(".")[0]}.`,
    )
    .join("\n");

  const agentsDocs = await collectAgentsMd(cwd);
  const agentsSection =
    agentsDocs.length > 0
      ? `\n# Project instructions (AGENTS.md)\n\n${agentsDocs.join("\n\n")}`
      : "";

  return `${IDENTITY}

# Available tools

${toolCatalog}
${TOOL_RULES}${agentsSection}`;
}

/**
 * AGENTS.md discovery: walk from cwd to the git root. Files from ancestor
 * directories come first, the nearest file last (nearer = later in context).
 * No @import expansion in v0.1 (planned for v0.2).
 */
async function collectAgentsMd(cwd: string): Promise<string[]> {
  const docs: string[] = [];
  const dir = path.resolve(cwd);
  const stop = await findGitRoot(dir);
  const floor = stop ?? path.parse(dir).root;
  // Collect ancestor-first: walk upward, then reverse so nearest is last.
  const chain: string[] = [];
  for (let current = dir; ; current = path.dirname(current)) {
    chain.push(current);
    if (current === stop || current === path.parse(current).root) break;
  }
  void floor;
  for (const candidate of chain.reverse()) {
    const file = path.join(candidate, "AGENTS.md");
    const info = await stat(file).catch(() => null);
    if (info?.isFile() === true) {
      const content = await readFile(file, "utf8");
      if (content.trim().length > 0) docs.push(`--- ${file} ---\n${content.trim()}`);
    }
  }
  return docs;
}

async function findGitRoot(dir: string): Promise<string | null> {
  let current = path.resolve(dir);
  for (;;) {
    const info = await stat(path.join(current, ".git")).catch(() => null);
    if (info !== null) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
