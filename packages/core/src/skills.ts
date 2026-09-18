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
