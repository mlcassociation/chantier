/**
 * Frozen v0.6.0 contract (spec /home/debian/portfolio/chantier/v06-spec.md
 * §Theme 1): agentskills.io SKILL.md types. Types only — Worker CoreExt
 * implements the loader (frontmatter parse, discovery, precedence, trust).
 */

/** Validated SKILL.md frontmatter (agentskills.io/specification subset). */
export interface SkillFrontmatter {
  /** 1–64 chars, [a-z0-9-], no lead/trail/consecutive `-`. */
  readonly name: string;
  /** 1–1024 chars, what + when. */
  readonly description: string;
  readonly license?: string;
  /** ≤500 chars. */
  readonly compatibility?: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

/** A discovered skill; the body is NOT loaded (progressive disclosure). */
export interface Skill {
  readonly name: string;
  readonly description: string;
  /** Absolute directory holding SKILL.md (body + bundled files resolve here). */
  readonly dir: string;
  readonly frontmatter: SkillFrontmatter;
}

/**
 * Scan the given roots (each root = a directory of `<name>/SKILL.md`
 * subdirectories). First occurrence per name wins (caller passes roots in
 * precedence order); invalid skills are skipped with a one-line notice.
 */
export type LoadSkills = (roots: readonly string[]) => Promise<readonly Skill[]>;

/** Tier-2 load: the full markdown body below the frontmatter. */
export type LoadSkillBody = (skill: Skill) => Promise<string>;

// --- Implementation -----------------------------------------------------------

import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

/** agentskills.io name rules: 1–64 chars, [a-z0-9-], no lead/trail/consecutive `-`. */
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const NAME_MAX = 64;
const DESCRIPTION_MAX = 1024;
const COMPATIBILITY_MAX = 500;

export interface LoadSkillsOptions {
  /** Called once per skipped-but-diagnosable skill with a one-line reason. */
  onNotice?: (notice: string) => void;
}

type SkillRead = { readonly skill: Skill } | { readonly reason: string };

/**
 * Scans each root one level deep for `<name>/SKILL.md`. Roots are in
 * precedence order (project before user; the caller decides) and the first
 * occurrence of a name wins. Nonexistent or unreadable roots contribute
 * nothing; unreadable directories are skipped silently; a skill whose
 * frontmatter parses but fails validation is skipped with a one-line notice.
 */
export async function loadSkills(
  roots: readonly string[],
  options: LoadSkillsOptions = {},
): Promise<readonly Skill[]> {
  const onNotice = options.onNotice;
  const byName = new Map<string, Skill>();
  for (const root of roots) {
    let entries: Dirent[];
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      continue; // nonexistent root = empty
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(root, entry.name);
      let read: SkillRead;
      try {
        read = await readSkill(dir, entry.name, onNotice);
      } catch {
        continue; // unreadable dir skipped silently
      }
      if ("reason" in read) {
        onNotice?.(`skill '${entry.name}' skipped: ${read.reason}`);
        continue;
      }
      if (byName.has(read.skill.name)) {
        onNotice?.(
          `skill '${read.skill.name}' from ${dir} skipped: duplicate name (first in precedence wins)`,
        );
        continue;
      }
      byName.set(read.skill.name, read.skill);
    }
  }
  return [...byName.values()];
}

/** Tier-2 load: the full markdown body below the frontmatter delimiter. */
export async function loadSkillBody(skill: Skill): Promise<string> {
  const text = (await readFile(path.join(skill.dir, "SKILL.md"), "utf8")).replaceAll("\r\n", "\n");
  const doc = parseFrontmatter(text);
  if (doc === undefined) return "";
  return doc.body.trim();
}

/** Reads and validates one `<dir>/SKILL.md`; a validation failure skips it. */
async function readSkill(
  dir: string,
  dirName: string,
  onNotice: ((notice: string) => void) | undefined,
): Promise<SkillRead> {
  let text: string;
  try {
    text = (await readFile(path.join(dir, "SKILL.md"), "utf8")).replaceAll("\r\n", "\n");
  } catch {
    return { reason: "no readable SKILL.md" };
  }
  const doc = parseFrontmatter(text);
  if (doc === undefined) {
    return { reason: "missing or malformed frontmatter (expects --- delimited YAML)" };
  }
  const name = doc.fields.name;
  if (name === undefined || name.length === 0) return { reason: "missing name" };
  if (name.length > NAME_MAX || !NAME_PATTERN.test(name)) {
    return {
      reason: `invalid name "${name}" (1-${NAME_MAX} chars, [a-z0-9-], no lead/trail/double -)`,
    };
  }
  const description = doc.fields.description;
  if (description === undefined || description.length === 0)
    return { reason: "missing description" };
  if (description.length > DESCRIPTION_MAX) {
    return { reason: `description exceeds ${DESCRIPTION_MAX} chars (${description.length})` };
  }
  const compatibility = doc.fields.compatibility;
  if (compatibility !== undefined && compatibility.length > COMPATIBILITY_MAX) {
    return { reason: `compatibility exceeds ${COMPATIBILITY_MAX} chars (${compatibility.length})` };
  }
  if (name !== dirName) {
    // CC precedent: a valid frontmatter name disagreeing with the directory
    // is a warning, not an error — the directory name wins.
    onNotice?.(`skill '${dirName}': frontmatter name '${name}' ignored (name ≠ dir)`);
  }
  const frontmatter: SkillFrontmatter = {
    name,
    description,
    ...(doc.fields.license === undefined ? {} : { license: doc.fields.license }),
    ...(compatibility === undefined ? {} : { compatibility }),
    ...(Object.keys(doc.metadata).length === 0 ? {} : { metadata: doc.metadata }),
  };
  return { skill: { name: dirName, description, dir, frontmatter } };
}

interface FrontmatterDoc {
  /** Top-level `key: value` pairs (quotes stripped). */
  readonly fields: Readonly<Record<string, string>>;
  /** Entries of the `metadata:` map (one indentation level). */
  readonly metadata: Readonly<Record<string, string>>;
  /** Everything after the closing `---`, verbatim. */
  readonly body: string;
}

/**
 * Line-based YAML frontmatter for the SKILL.md subset: `key: value` pairs
 * split on the FIRST colon per line, so unquoted colons inside values parse
 * (the gemini-cli bug); surrounding single/double quotes are stripped. Only
 * one nesting level is supported, under `metadata:`. Returns undefined when
 * the delimiters are missing or a line is not a plain `key: value` pair.
 */
function parseFrontmatter(text: string): FrontmatterDoc | undefined {
  const lines = text.split("\n");
  if ((lines[0] ?? "").trimEnd() !== "---") return undefined;
  const fields: Record<string, string> = {};
  const metadata: Record<string, string> = {};
  let inMetadata = false;
  let bodyStart = -1;
  // Accumulator for the field/metadata entry being built, which may span
  // lines: YAML block scalars (`>` folded, `|` literal) and plain values.
  let current:
    | {
        map: Record<string, string>;
        key: string;
        mode: "fold" | "keep" | undefined;
        value: string;
      }
    | undefined;
  const flush = (): void => {
    if (current === undefined) return;
    const folded =
      current.mode === undefined
        ? current.value
        : current.mode === "fold"
          ? current.value
              .split("\n")
              .map((line) => line.trim())
              .filter((line) => line.length > 0)
              .join(" ")
          : current.value.replace(/^\n+/, "");
    current.map[current.key] = folded.trim();
    current = undefined;
  };
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (line.trimEnd() === "---") {
      flush();
      bodyStart = i + 1;
      break;
    }
    if (line.trim().length === 0) {
      if (current !== undefined && current.mode !== undefined) current.value += "\n";
      continue;
    }
    if (/^\s/.test(line)) {
      if (current !== undefined && current.mode !== undefined) {
        current.value += `\n${line.trim()}`;
        continue;
      }
      if (inMetadata) {
        const entry = splitKeyValue(line.trim());
        if (entry === undefined) return undefined;
        metadata[entry[0]] = entry[1];
        continue;
      }
      return undefined; // indentation with no open scalar
    }
    flush();
    const pair = splitKeyValue(line);
    if (pair === undefined) return undefined;
    const indicator = /^[|>][+-]?\d*$/.exec(pair[1]);
    if (indicator === null) {
      inMetadata = pair[0] === "metadata" && pair[1].length === 0;
      if (!inMetadata) fields[pair[0]] = pair[1];
      continue;
    }
    inMetadata = false;
    current = {
      map: fields,
      key: pair[0],
      mode: indicator[0].startsWith("|") ? "keep" : "fold",
      value: "",
    };
  }
  if (bodyStart === -1) return undefined; // no closing delimiter
  return { fields, metadata, body: lines.slice(bodyStart).join("\n") };
}

/**
 * Splits on the FIRST colon (values may contain colons), trims both sides,
 * and strips one pair of surrounding single/double quotes. Undefined for a
 * missing colon or an empty key.
 */
function splitKeyValue(line: string): [key: string, value: string] | undefined {
  const colon = line.indexOf(":");
  if (colon <= 0) return undefined;
  const key = line.slice(0, colon).trim();
  if (key.length === 0) return undefined;
  let value = line.slice(colon + 1).trim();
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    value = value.slice(1, -1);
  }
  return [key, value];
}
