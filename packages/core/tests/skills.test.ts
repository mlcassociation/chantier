import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadSkillBody, loadSkills } from "../src/skills.ts";

/**
 * agentskills.io SKILL.md loader (spec §Theme 1): frontmatter subset parse
 * (colon-in-values, quotes, metadata map), name rules, discovery precedence,
 * skip-with-notice error policy, and the tier-2 body load.
 */

const dirs: Array<string> = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "chantier-skills-"));
  dirs.push(root);
  return root;
}

async function writeSkill(
  root: string,
  dirName: string,
  frontmatter: string,
  body = "Step one. Step two.",
): Promise<string> {
  const dir = path.join(root, dirName);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "SKILL.md"), `---\n${frontmatter}---\n\n${body}\n`, "utf8");
  return dir;
}

function collectNotices(): { onNotice: (line: string) => void; lines: Array<string> } {
  const lines: Array<string> = [];
  return { lines, onNotice: (line) => lines.push(line) };
}

describe("loadSkills — discovery", () => {
  it("reads a valid SKILL.md: dir name wins, description and optional fields pass through", async () => {
    const root = await makeRoot();
    await writeSkill(
      root,
      "demo",
      [
        "name: demo",
        "description: Run the demo flow",
        "license: MIT",
        "compatibility: chantier >= 0.5",
        "metadata:",
        "  version: 1.2",
        "  audience: ops",
        "",
      ].join("\n"),
    );
    const skills = await loadSkills([root]);
    expect(skills).toHaveLength(1);
    const skill = skills[0];
    if (skill === undefined) throw new Error("expected one skill");
    expect(skill.frontmatter.license).toBe("MIT");
    expect(skill.dir).toBe(path.join(root, "demo"));
    expect(skill.description).toBe("Run the demo flow");
    expect(skill.frontmatter.name).toBe("demo");
    expect(skill.frontmatter.license).toBe("MIT");
    expect(skill.frontmatter.compatibility).toBe("chantier >= 0.5");
    expect(skill.frontmatter.metadata).toEqual({ version: "1.2", audience: "ops" });
  });

  it("parses unquoted colons inside values (split on the FIRST colon)", async () => {
    const root = await makeRoot();
    await writeSkill(root, "colon", "name: colon\ndescription: Use when: the file: exists\n");
    const skills = await loadSkills([root]);
    expect(skills[0]?.description).toBe("Use when: the file: exists");
  });

  it("strips one pair of surrounding quotes", async () => {
    const root = await makeRoot();
    await writeSkill(root, "quoted", 'name: quoted\ndescription: "Has: colon, quoted"\n');
    const skills = await loadSkills([root]);
    expect(skills[0]?.description).toBe("Has: colon, quoted");
  });

  it("name ≠ dir warns and the directory name wins (CC precedent)", async () => {
    const root = await makeRoot();
    const notices = collectNotices();
    await writeSkill(root, "dir-name", "name: front-name\ndescription: Body text\n");
    const skills = await loadSkills([root], notices);
    expect(skills[0]?.name).toBe("dir-name");
    expect(notices.lines).toHaveLength(1);
    expect(notices.lines[0]).toContain("'dir-name': frontmatter name 'front-name' ignored");
  });

  it("first root in precedence order wins a name collision; the loser is skipped with a notice", async () => {
    const project = await makeRoot();
    const user = await makeRoot();
    await writeSkill(project, "demo", "name: demo\ndescription: project copy\n");
    await writeSkill(user, "demo", "name: demo\ndescription: user copy\n");
    const notices = collectNotices();
    const skills = await loadSkills([project, user], notices);
    expect(skills).toHaveLength(1);
    expect(skills[0]?.description).toBe("project copy");
    expect(notices.lines.join("\n")).toContain("duplicate name (first in precedence wins)");
  });

  it("a nonexistent root contributes nothing and never throws", async () => {
    const skills = await loadSkills([path.join(tmpdir(), "chantier-no-such-root-xyz")]);
    expect(skills).toEqual([]);
  });

  it("a stray file (not a directory) in the root is ignored", async () => {
    const root = await makeRoot();
    await writeFile(path.join(root, "README"), "not a skill", "utf8");
    expect(await loadSkills([root])).toEqual([]);
  });
});

describe("loadSkills — validation (skip + one-line notice, never fatal)", () => {
  const cases: Array<[label: string, frontmatter: string, reason: RegExp]> = [
    ["missing name", "description: Body text\n", /missing name/],
    ["missing description", "name: demo\n", /missing description/],
    ["uppercase name", "name: Demo\ndescription: Body text\n", /invalid name "Demo"/],
    ["leading dash", "name: -demo\ndescription: Body text\n", /invalid name "-demo"/],
    ["trailing dash", "name: demo-\ndescription: Body text\n", /invalid name "demo-"/],
    ["double dash", "name: do--uble\ndescription: Body text\n", /invalid name "do--uble"/],
    [
      "name over 64 chars",
      `name: ${"a".repeat(65)}\ndescription: Body text\n`,
      /invalid name "a{65}"/,
    ],
    ["no frontmatter", "just markdown\n", /missing or malformed frontmatter/],
  ];
  for (const [label, frontmatter, reason] of cases) {
    it(`skips a skill with ${label}`, async () => {
      const root = await makeRoot();
      await writeSkill(root, "demo", frontmatter);
      const notices = collectNotices();
      const skills = await loadSkills([root], notices);
      expect(skills).toEqual([]);
      expect(notices.lines).toHaveLength(1);
      expect(notices.lines[0]).toMatch(/^skill 'demo' skipped: /);
      expect(notices.lines[0]).toMatch(reason);
    });
  }

  it("skips a description over 1024 chars", async () => {
    const root = await makeRoot();
    await writeSkill(root, "demo", `name: demo\ndescription: ${"d".repeat(1025)}\n`);
    const notices = collectNotices();
    expect(await loadSkills([root], notices)).toEqual([]);
    expect(notices.lines[0]).toContain("description exceeds 1024 chars (1025)");
  });

  it("a missing SKILL.md in a subdirectory is a notice, and the loop continues to the next entry", async () => {
    const root = await makeRoot();
    await mkdir(path.join(root, "empty"));
    await writeSkill(root, "demo", "name: demo\ndescription: Body text\n");
    const notices = collectNotices();
    const skills = await loadSkills([root], notices);
    expect(skills.map((skill) => skill.name)).toEqual(["demo"]);
    expect(notices.lines).toHaveLength(1);
    expect(notices.lines[0]).toContain("no readable SKILL.md");
  });

  it("a frontmatter block that never closes is malformed (the helper always appends ---, so this file is written directly)", async () => {
    const root = await makeRoot();
    const dir = path.join(root, "unclosed");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "SKILL.md"),
      "---\nname: demo\ndescription: Body text\n",
      "utf8",
    );
    const notices = collectNotices();
    expect(await loadSkills([root], notices)).toEqual([]);
    expect(notices.lines[0]).toMatch(/missing or malformed/);
  });
});

describe("loadSkillBody", () => {
  it("returns the body below the closing delimiter, trimmed", async () => {
    const dir = await writeSkill(
      await makeRoot(),
      "demo",
      "name: demo\ndescription: Body text\n",
      "# Steps\n\n- first\n- second",
    );
    expect(
      await loadSkillBody({
        name: "demo",
        description: "Body text",
        dir,
        frontmatter: { name: "demo", description: "Body text" },
      }),
    ).toBe("# Steps\n\n- first\n- second");
  });

  it("normalizes CRLF line endings", async () => {
    const root = await makeRoot();
    const dir = path.join(root, "crlf");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "SKILL.md"),
      "---\r\nname: crlf\r\ndescription: Body text\r\n---\r\n\r\nbody line\r\n",
      "utf8",
    );
    const skills = await loadSkills([root]);
    const skill = skills[0];
    if (skill === undefined) throw new Error("expected one skill");
    expect(await loadSkillBody(skill)).toBe("body line");
  });

  it("returns an empty body for a frontmatter-less file", async () => {
    const root = await makeRoot();
    const dir = path.join(root, "plain");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "SKILL.md"), "no frontmatter here", "utf8");
    expect(
      await loadSkillBody({
        name: "plain",
        description: "d",
        dir,
        frontmatter: { name: "plain", description: "d" },
      }),
    ).toBe("");
  });
});
