import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { ToolDefinition } from "./types.ts";

/**
 * Tool-usage rules the model needs to drive the harness correctly.
 */
const TOOL_RULES = `# Tool usage rules

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

/** Doing-tasks discipline shared by every model family. */
const DOING_TASKS = `# Doing tasks

- Prefer editing existing files over creating new ones.
- Do exactly what was asked: no scope creep — no extra retries, telemetry, or
  abstraction "while you're at it"; the real ask only.
- Comments explain WHY, not WHAT; skip them where the code already says it.
- Verify behavioral changes by running the changed path, not by re-reading the edit.
- State uncertainty plainly rather than guessing.`;

const DENIALS = `# Permission denials

A denied tool call is final for that exact invocation: never retry the identical
denied call. Adjust the arguments or switch the approach, or continue with what
is allowed, and state plainly that the action was not permitted.`;

/** Present in the prompt only when a tool named "task" is offered. */
const DELEGATION = `# Delegating subtasks

- Delegate self-contained subtasks with the full context the child needs in the
  prompt (paths, constraints, acceptance); the child returns a final summary.
- Scale the prompt effort to the subtask: brief for mechanical work, detailed
  for design work.
- Do not delegate single sequential edits you can do directly.`;

/**
 * Per-model-family prompt profile. Only the identity section is
 * profile-specific; every other section is shared, fixed-order text.
 */
export interface ModelProfile {
  /** Family name, for diagnostics and tests. */
  name: string;
  /** Replaces the default identity paragraph when present. */
  identity?: string;
}

/** Default semantics: today's identity, unchanged. */
const DEFAULT_PROFILE: ModelProfile = { name: "default" };

// Terse-output bias, strict JSON tool arguments, one short closing paragraph,
// and explicit adjust-don't-retry guidance — the failure modes observed with
// the GLM chat family.
const GLM_PROFILE: ModelProfile = {
  name: "glm",
  identity: `You are chantier, a terminal coding agent working directly in the user's project directory.
Style for this model family: keep prose terse; tool arguments are strict JSON
objects with no trailing commentary inside tool calls; finish each task with one
short final paragraph and nothing more. When a tool call is denied or fails,
adjust the arguments or change the approach — never loop identical retries.`,
};

const CLAUDE_PROFILE: ModelProfile = {
  name: "claude",
  identity: `You are chantier, a terminal coding agent working directly in the user's project directory.
Read before you write; strongly prefer editing existing files over creating new
ones; do exactly the task asked with no scope creep; when something is unclear,
say so plainly instead of guessing.`,
};

/**
 * Profile registry: family prefix match on the model id — `glm-` and `claude-`
 * resolve their profiles, anything else the default. Prefixes match the leading
 * id so suffixed tags (e.g. `glm-5.3-flash:cloud`) still resolve to the family.
 */
export function resolveModelProfile(model: string): ModelProfile {
  if (model.startsWith("glm-")) return GLM_PROFILE;
  if (model.startsWith("claude-")) return CLAUDE_PROFILE;
  return DEFAULT_PROFILE;
}

/**
 * Builds the system prompt from fixed, blank-line-joined sections: environment,
 * identity (profile-adjustable), doing-tasks rules, denial rule, delegation
 * (only when a `task` tool is offered), tool catalog, tool rules, and every
 * AGENTS.md from cwd up to the git root last.
 *
 * `profile` omitted means the default profile: identity and tool rules keep
 * today's semantics, new sections are purely additive.
 */
export async function buildSystemPrompt(
  cwd: string,
  tools: ToolDefinition[],
  profile: ModelProfile = DEFAULT_PROFILE,
): Promise<string> {
  const toolCatalog = tools
    .map(
      (tool) =>
        `- ${tool.name}${tool.readOnly ? " (read-only)" : ""}: ${tool.description.split(".")[0]}.`,
    )
    .join("\n");

  const sections: string[] = [
    await environmentSection(cwd),
    profile.identity ?? IDENTITY,
    DOING_TASKS,
    DENIALS,
  ];
  if (tools.some((tool) => tool.name === "task")) sections.push(DELEGATION);
  sections.push(`# Available tools\n\n${toolCatalog}`, TOOL_RULES);

  const agentsDocs = await collectAgentsMd(cwd);
  if (agentsDocs.length > 0) {
    sections.push(`# Project instructions (AGENTS.md)\n\n${agentsDocs.join("\n\n")}`);
  }
  return sections.join("\n\n");
}

/** Environment facts first; the branch line is omitted rather than fabricated. */
async function environmentSection(cwd: string): Promise<string> {
  const branch = await resolveBranch(await findGitRoot(path.resolve(cwd)));
  const lines = [
    "# Environment",
    "",
    `- cwd: ${cwd}`,
    `- date: ${new Date().toISOString().slice(0, 10)} (UTC)`,
  ];
  if (branch !== null) lines.push(`- branch: ${branch}`);
  return lines.join("\n");
}

/**
 * Branch read from the filesystem, no git process spawned: `.git/HEAD` with
 * `ref: refs/heads/<name>` yields the name; a raw sha means detached. Missing
 * or unreadable HEAD → null → the caller omits the branch line.
 */
async function resolveBranch(gitRoot: string | null): Promise<string | null> {
  if (gitRoot === null) return null;
  const head = await readFile(path.join(gitRoot, ".git", "HEAD"), "utf8").catch(() => null);
  if (head === null) return null;
  const match = /^ref: refs\/heads\/(.+)$/.exec(head.trim());
  return match?.[1] ?? "(detached)";
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
