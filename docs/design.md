# Design rationale

Why chantier is built the way it is. Every section cites a public primary source; the
field research behind these choices covered 13 open-source coding agents (aider, opencode,
codex, gemini-cli, crush, pi, cline, goose, OpenHands, SWE-agent, mini-SWE-agent, Roo, amp)
and Anthropic's published agent guidance.

## The loop is small and typed

The core is a manual tool loop over a typed message union: the model streams a turn, tool
calls are appended as results, and the loop repeats until a text-only turn. No framework,
no state machine library — an async generator and a discriminated union, mirroring the
shape Anthropic ships in the Claude Agent SDK and recommends in
[Building effective agents](https://www.anthropic.com/engineering/building-effective-agents).

Consequences worth knowing:

- Tool failures feed back as ordinary results, so a wrong path or a failed grep is
  recoverable by the model without error-type branching.
- Stop conditions are first-class: `--max-turns`, budget accounting in usage records.

## Tools are an interface, not an afterthought

Eight built-ins: `read`, `write`, `edit`, `bash`, `glob`, `grep`, `webfetch`, `task`.
Anthropic's [writing effective tools](https://www.anthropic.com/engineering/writing-tools-for-agents)
argues most of the quality gap between agents is tool design — and the SWE-agent paper
(arXiv 2405.15793) demonstrates the same from the outside. chantier follows the three
practical rules that follow from both:

- **Token-capped, model-facing output.** Every tool result is prose with a hard cap;
  long output spills to a file with the path handed to the model, never truncated
  silently.
- **Corrective error prose.** "No matches." tells a model nothing; "no matches —
  try a narrower glob or an exact substring" lets it correct course. Ambiguous edits
  echo the nearby lines they matched.
- **Read-before-edit is enforced, not requested.** The harness tracks file state per
  session and refuses edits to unread or stale files, with a re-read-first message.

## Permissions are enforced, never negotiated

The engine is deny-first: **deny → ask → allow, first match wins**; silence never
approves. The model never reads the rules — it sees outcomes, so it cannot argue with
a rule it cannot see. Details verified against Claude Code's permission model
([permissions](https://code.claude.com/docs/en/permissions)):

- Bash text rules are a convenience for humans, not a security boundary: `bash(rm *)`
  does not stop `bash("rm x")` via another spelling. Real enforcement is the approval
  prompt by default and OS-level isolation when you need more.
- Wildcard under-matching fails safe: a rule that matches less than intended falls
  through to the default decision rather than widening a grant.
- Subagents inherit parent rules verbatim; remembered "always allow" grants never
  cross the boundary; a denied child mutation surfaces in the parent's approval UI.

## Sessions are an append-only log; compaction is a view

Session storage is JSONL, append-only, replay-on-load — the pi/OpenHands pattern.
Compaction adds a derived view over that log (a `compaction` entry pointing at the
last kept entry id plus a summary): the file is never rewritten, `--continue` and
forks stay safe, and the transcript above a compaction point remains intact. The
auto-trigger is checked between turns with a conservative reserve (Codex's clamp-first
approach) plus a reactive fallback when a provider call overflows mid-turn.

Token accounting requests `include_usage` from providers that support it (Ollama
needs the flag; the default `stream_options` omit it) and falls back to a character
estimator when a provider reports nothing.

## Subagents: summary-return, depth cap by construction

`task` re-enters the same loop with a fresh JSONL session, the parent's permission
engine, and the parent's abort signal. Only the child's final summary returns (capped
at 50 KiB) — the full transcript lives in the child's own session file. The depth cap
is structural, not a check: the child's toolset is the built-in set, which contains no
`task` tool, so recursion is impossible by construction (Claude Code's mechanism for
depth limits). Design evidence: Anthropic's
[multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)
and [agent-sdk sub-agents](https://code.claude.com/docs/en/agent-sdk/sub-agents);
pi's parent-strict inheritance.

## Standards before invention

- **Skills** follow the [agentskills.io](https://agentskills.io) specification
  verbatim: `SKILL.md` with `name` + `description` frontmatter, progressive
  disclosure, optional bundled scripts. A skill is a directory; nothing else.
- **MCP** uses the official TypeScript SDK
  ([spec 2025-06-18](https://modelcontextprotocol.io)); tools arrive named
  `mcp__<server>__<tool>`, keep their JSON Schema unchanged, route through the same
  permission ladder, and a dead server fails soft with a notice rather than ending
  the session.
- **Project context** is `AGENTS.md` — the portable name nine projects converged on —
  loaded last in the system prompt. Environment facts (cwd, date, git state) are
  composed, never guessed by the model.

## Local models are first-class

chantier's origin was driving small, cheap models by a non-developer operator, so the
defaults bias toward them: a terse system-prompt profile for `glm-`/Ollama-family
models, explicit `includeUsage`, a conservative compaction reserve, and structured
JSON tool args (a text-SEARCH/REPLACE edit surface measured worse for tool-calling
models — aider's original workaround). The provider seam (`ModelAdapter`) is the only
place a provider SDK is imported.

## Accessibility is a property, not a port

The TUI is ink (the stack of Claude Code and gemini-cli) rendering an append-only
transcript — everything lands in scrollback, nothing is redrawn in place. Screen-reader
mode (`--screen-reader`) emits the flat labeled form the same ink renderer already
supports, gates decorative glyphs behind an ASCII fallback, and the stream flushes at
paragraph boundaries so assistive tech hears finalized text. `NO_COLOR` and `--no-color`
are honored directly. References: ink's screen-reader support, gemini-cli's
`--screen-reader`, Claude Code's [accessibility docs](https://code.claude.com/docs/en/accessibility),
and CHI 2021 "Accessibility of Command Line Interfaces".

## What chantier deliberately does not do (yet)

- No client/server split — the TUI owns its loop; an HTTP session server is a known
  retrofit once third-party surfaces actually need it.
- No repo map (aider's tree-sitter index) — measured cheap win for large-repo context;
  on the roadmap.
- No worktree isolation for parallel writer agents yet — the subagent story grows
  toward it (see [ROADMAP.md](../ROADMAP.md)).
- No permission-less "yolo" default anywhere; `--yolo` exists for headless automation
  and is loud about it.