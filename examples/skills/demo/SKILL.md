---
name: demo
description: A sample chantier skill — explains what skills are and how to write one.
---

# Demo skill

This file is the whole thing. A skill is a directory under a skills root —
`~/.chantier/skills/<name>/SKILL.md`, `.chantier/skills/<name>/SKILL.md`,
or the `.agents/skills/` / `~/.claude/skills/` spellings — containing a
`SKILL.md` with `name` + `description` frontmatter, exactly the
[agentskills.io](https://agentskills.io) shape.

How it behaves in chantier:

- The palette lists it as `/demo`; `/help` includes it.
- The system prompt carries only `name` + `description` until you invoke it
  (progressive disclosure); accepting `/demo` loads the body below the
  frontmatter into the conversation.
- Project-scope skills (`.chantier/skills/`, `.agents/skills/`) require a
  one-time trust approval per project; user-scope skills load freely.

Write your own: replace this file's frontmatter (`name` must be
`[a-z0-9-]`, 1–64 chars) and the body becomes whatever instructions you want
loadable on demand.