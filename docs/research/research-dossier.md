# Open-source terminal harness — research dossier (2026-09-16)

Project: **chantier** — DASHLEA × MLC public open-source TypeScript terminal coding-agent harness.
(Name verified 2026-09-16: npm free, GitHub org free, chantier-cli.dev/getchantier.dev/chantier.sh
unregistered, no dev-tool brand collision; rejected esquisse = dreamRs R-package SEO shadow.)
Shape decided by owner: TypeScript/Node · interactive TUI first milestone · provider-pluggable
(local Ollama / API key / OAuth, never wired to a private proxy) · approval on every mutation ·
build-in-public video series · private repo until v0.1 · multi-week pace.
This dossier = synthesis of 5 research tracks (full briefs at
`agent://OssLandscape`, `agent://ClaudeCodePatterns`, `agent://OmpDeepDive`,
`agent://TsStackResearch`, `agent://OssCredibility` — read each before implementing a subsystem).

## 1. What the field converged on (verified 2026-09-16, 13 projects, star counts via GitHub API)

### Industry standards (6+ independent projects each — copy these)
| Pattern | Evidence |
|---|---|
| Core loop: model → tool calls → results appended → repeat until text-only; typed message stream | all 13; Agent SDK ships it as async generator + discriminated union |
| Small fixed core toolset (~8–10): read/write/edit, bash, glob/grep, webfetch; mini-swe-agent proves ~100 lines + bash-only hits 65% SWE-bench | cline, opencode, pi, crush, gemini, codex, OpenHands… |
| Native function-calling tool schemas (2 deliberate dissenters: aider text-diff, mini-swe-agent backtick blocks) | 11 of 13 |
| Permission ladder: ask-by-default → auto modes → yolo escape hatch; declarative allow/ask/deny rules with wildcards + last-match-wins + tiered precedence | opencode (wildcards, `.env`-deny default, doom-loop tripwire), gemini (TOML policy engine, admin tiers, deny removes tool from context), claude SDK (`Bash(npm *)`, deny→ask→allow first-match), codex, goose, crush |
| OS/container sandbox as the real boundary; prompts = UX not security | codex (Seatbelt/Landlock/seccomp, network-off default, `.git` read-only even in workspace-write), OpenHands (Docker/Agent Server), pi (explicit "in-process sandboxes are misleading" + 3 containerization patterns) |
| Provider abstraction over OpenAI-compatible wire + native Anthropic/Google adapters + community model catalog | pi-ai, opencode (Vercel AI SDK + models.dev 75+), crush (Catwalk), aider (LiteLLM), goose (45+ providers incl. command-based auth) |
| Subscription OAuth logins + API keys + local models (2025-26 add-on) | codex (ChatGPT OAuth), pi (/login), goose (Copilot device-flow), cline |
| MCP as external tool transport (annotations `readOnlyHint` feed permission/parallelism decisions; deferred schema loading via ToolSearch) | 9 projects; MCP spec 2025-06-18 |
| Agent Skills standard (SKILL.md, progressive disclosure: name+description → body → bundled files) | agentskills.io: Claude Code, Cursor, Copilot, Gemini CLI, Codex, OpenCode, OpenHands, Goose, pi, cline, amp |
| AGENTS.md as the portable context-file name; markdown-with-frontmatter for agents/skills/config | 9 projects |
| Sessions persisted on disk (JSONL), resumable/forkable; headless mode beside the TUI (print flag / JSON stream / server) | all 13; pi's in-file branch tree most advanced |
| Context compaction as built-in (pluggable condensers = OpenHands' most principled version) | 7 |
| Subagents for context isolation: own context window, tool grant, return-only-summary handoff, depth-capped recursion, worktree isolation option | 7 |
| Client/server split: server owns sessions/state, TUI/IDE/CI are disposable clients | opencode (OpenAPI-generated SDK), cline hub-spoke, crush serve, OpenHands agent server — "retrofitting it later is expensive" |
| Dual-model plan/act split (plan strong, act cheap) | aider architect, cline Plan&Act, amp Dial, roo, opencode plan agent |
| Harness-as-library: both Anthropic (Claude Agent SDK TS) and OpenAI (Agents SDK) extracted their harness into a library in 2025 | the loop+permissions+sessions layer IS the product |

### Differentiators (watch, adopt selectively)
- aider repo map (tree-sitter symbol graph, ~1k-token budget) — cheapest big-repo context trick, nobody standardized it.
- cline checkpoints (shadow-git rollback of edits, conversation preserved) — strongest undo UX.
- codex sandbox-first defaults (context-aware: versioned repo → workspace-write+on-request; untrusted → read-only) + model-based safety monitor.
- amp specialist subagents (oracle = second-opinion model, librarian = codebase research) + closed-source cautionary tale.
- gemini policy engine (admin-owned dirs, root-owned) — enterprise, skip for v1.
- pi's supply-chain hardening (pinned deps, min-release-age, shrinkwrap) — "differentiator today, likely table stakes for credibility."
- pi's honesty stance: no permission system by design + project-trust gate (trust.json) + containerization docs — legitimate public position, but owner chose approval-on-mutation, so we ship the ladder instead.
- goose tool-shim for non-tool-calling models — only if local weak models become first-class.

## 2. Official Anthropic patterns (primary docs; full brief at agent://ClaudeCodePatterns)
1. **Boring loop** — async generator, discriminated-union messages, environmental error recovery (tool failures feed back as results, no error-type branching), first-class stop conditions (maxTurns, maxBudgetUsd). Parallelism = property of the tool (readOnlyHint), not model output.
2. **Tools are an ACI contract** — few, consolidated (`get_customer_context` not 3 fetchers), token-efficient returns (25k cap in Claude Code), prompt-engineered errors, absolute paths, response_format enum; "we spent more time optimizing our tools than the overall prompt."
3. **Deny-first, harness-enforced permissions** — deny→ask→allow, first match; allow can never punch through deny; bare-name deny removes tool from model context; Bash text rules explicitly NOT a security boundary; sandboxing for real enforcement; `plan` mode as first-class read-only mode; silence never approves (hooks can deny, never approve).
4. **Hooks** — lifecycle events, JSON stdin/stdout decisions, merge-across-scopes, fail-closed.
5. **Agent Skills** — adopt agentskills.io verbatim (multi-vendor standard); progressive disclosure; skills can bundle deterministic scripts.
6. **MCP** — official TS SDK client; `mcp__server__tool` naming; same permission/parallelism pipes as built-ins; deferred schemas.
7. **Subagents** — frontmatter markdown definitions; return-only-summary contract; tool grants as allowlists; depth cap enforced by tool removal; parent-stricter-wins permission inheritance.

## 3. OMP internal design lessons (agent://OmpDeepDive)
Copy: guarded internal URL schemes as capability addresses; capability registry with numeric priority + dedup key; fail-soft discovery / fail-loud explicit overlays; everything-is-a-file; two-phase background memory consolidation (cheap model, redact-before-persist, lease/heartbeat, "memory is heuristic, repo is truth" contract); advisor subsystem **wholesale** (delta review, emission guard, severity ladder, immuneTurns, quarantine, never-a-peer, JSONL persistence) with read-only grants only; markdown subagent defs with depth cap by tool removal; 5-layer settings (deep-merge objects / replace arrays) with one schema powering CLI+TUI+validation; sticky RULES.md re-attached near current turn.
Avoid: legacy/migration zoo; 9-provider compat matrix (greenfield = one native convention); implicit `tools:[task]⇒spawns:*` escalation; memory 5-backend zoo; mutating advisor tools.

## 4. Recommended stack (agent://TsStackResearch)
- **TUI: Ink 7 + React 19** — de-facto standard for AI CLIs (Claude Code, Gemini CLI, Copilot CLI, Nanocoder, Neovate Code per Ink's official user list). ink>=6.7 `useCursor` for IME. Rejected: blessed (unmaintained), OpenTUI (needs Node 26+/Bun + Zig).
- **Providers: Vercel AI SDK (`ai` v5 + `@ai-sdk/*` + `@ai-sdk/openai-compatible` for Ollama) + models.dev open catalog** (opencode's proven 75+-provider pattern). In-house alternative with evidence: pi-ai's event taxonomy. OpenRouter = optional aggregator only (per-provider OAuth matters).
- **Agent loop: harness-owned**, over unified async stream events, streaming tool-call args, AbortSignal end-to-end (AI SDK streamText/stopWhen/prepareStep; opencode SSE+AbortController).
- **Auth: API keys + browser OAuth/PKCE with headless fallbacks** (Anthropic paste-code, OpenAI device-code), file storage + optional OS keyring.
- **Monorepo: npm workspaces + tsdown (or esbuild), pure ESM, engines node>=22** (Node 20 EOL 2026-04-30).
- **Windows: native support** via Git-Bash-primary/PowerShell-fallback shell tool + per-platform optional deps (Claude Code and pi precedent).

## 5. OSS credibility / license / governance (agent://OssCredibility)
- **License: Apache-2.0** (aider + goose, the two most community-trusted in this space): explicit patent grant (agent tooling is patent-dense), trademark reservation (§6) — Block lost goose's name and had to donate it to the AAIF/Linux Foundation; MIT (opencode) is fine but weaker on the name. Never FSL/CLA (crush anti-pattern: NOASSERTION on GitHub, rights concentrated). Never relicense later (HashiCorp/OpenTofu). Pair with: one-sentence trademark policy, DCO `git commit -s` instead of CLA.
- **Credibility engine:** docs site (even one static page) + readable per-release notes with contributor credit + zero-signup npm install + small reproducible benchmark/demo page per model release (the aider trust engine) + "agent wrote X% of this release" transparency per release.
- **Launch:** make it runnable → Show HN when genuinely useful, founder in-thread all day → monthly "what changed + data" cadence → secure name/domain/npm handles BEFORE launch (OpenCode/Crush brand collision fight is the cautionary tale).
- **Video pairing (build-in-public series):** (a) 60–90s readable demo GIF in README via VHS `.tape` files (crush's demo-GIF-too-fast was its top HN complaint); (b) architecture explainer ("how a harness is laid out") — the video that earns hacker respect (tptacek: "a blueprint for how to lay out an agent"); (c) devlogs/livestreams of real features (Dax model = launch distribution); (d) one-command install + striking TUI so Fireship-type creators can cover it.
- **Solo-maintainer realism:** automate releases (opencode's agent-bot pattern — imitable with our own agent); issue templates + triage policy (bugs-only on GitHub); no SLA; predictable small releases; dogfood + publish "agent wrote X%"; aider stall (13 months, 1,869 open issues) = the absence warning.

## 6. Proposed architecture (synthesis)

Monorepo `packages/`:
```
core/        agent loop: async generator, typed message union, turn/budget caps,
             compaction hook, JSONL session store (resume/fork), context-file discovery
providers/   Vercel AI SDK + @ai-sdk/* adapters, models.dev catalog, OAuth/key flows
tools/       built-ins v0.1: read, write, edit, bash, glob, grep, webfetch (todo = v2);
             Anthropic ACI rules: token-capped model-facing output, prompt-engineered errors
permissions/ allow/ask/deny + wildcards, deny→ask→allow, per-tool defaults (.env deny),
             plan mode, approval UI hook point
server/      session/state server (HTTP + OpenAPI SDK) — wraps the core session interface; v0.2
tui/         Ink 7 + React 19 client
cli/         headless runner (print mode, --output-format json)
skills/      agentskills.io SKILL.md loader + MCP client (official TS SDK)
advisor/     delta-review reviewer (OMP advisor pattern, read-only grants) — v2, not v0.1
```
v0.1 cut (first daily-use milestone, per owner: interactive TUI):
loop + 7 tools (read, write, edit, bash, glob, grep, webfetch) + permission ladder
(ask-by-default) + Ink TUI + 3 auth paths (Ollama, one API key, OAuth) + JSONL sessions +
AGENTS.md. Sessions/state sit behind a clean library interface from day one (that IS the
retrofit-cost-avoidance lesson from 6 harnesses); the `server/` package later becomes a thin
HTTP+OpenAPI wrapper over that interface. MCP, skills, server split, subagents, advisor, and
compaction polish land in subsequent episodes — each is itself video material.

## 7. Full source lists
OssLandscape (repos): github.com/Aider-AI/aider · github.com/aaif-goose/goose · github.com/cline/cline · github.com/RooCodeInc/Roo-Code · github.com/OpenHands/OpenHands · github.com/OpenHands/software-agent-sdk · github.com/SWE-agent/SWE-agent · github.com/SWE-agent/mini-SWE-agent · github.com/earendil-works/pi · github.com/anomalyco/opencode · github.com/charmbracelet/crush · github.com/openai/codex · github.com/google-gemini/gemini-cli · github.com/openai/openai-agents-python · github.com/anthropics/claude-agent-sdk-typescript
OssLandscape (docs/essays): aider.chat/docs/repomap.html · aider.chat/docs/usage/modes.html · aider.chat/docs/llms.html · goose-docs.ai/docs/getting-started/providers · goose-docs.ai/docs/guides/managing-tools/goose-permissions · docs.cline.bot/sdk/architecture/hub-spoke.md · docs.cline.bot/core-workflows/plan-and-act.md · docs.openhands.dev/sdk/arch/overview · arxiv.org/abs/2511.03690 · swe-agent.com/latest · mini-swe-agent.com/latest/faq · pi.dev/docs/latest (usage/extensions/security) · opencode.ai/docs (+ /permissions /plugins /providers /sdk) · learn.chatgpt.com/docs/agent-approvals-security · github.com/google-gemini/gemini-cli (policy-engine.md) · ampcode.com/docs/markdown/tools · news.ycombinator.com/item?id=44483338 + ?id=48491407 (two-OpenCode name fallout)
ClaudeCodePatterns (official): anthropic.com/engineering/building-effective-agents · anthropic.com/engineering/writing-tools-for-agents · anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills · code.claude.com/docs/en/agent-sdk (+ /agent-loop /permissions /sandboxing /hooks /sub-agents /skills) · agentskills.io · modelcontextprotocol.io/docs/getting-started/intro · modelcontextprotocol.io/docs/learn/architecture · modelcontextprotocol.io/specification/2025-06-18/server/tools
OmpDeepDive (omp:// read): skills.md · hooks.md · memory.md · advisor-watchdog.md · settings.md · config-usage.md · context-files.md · task-agent-discovery.md (+ omp:// index)
TsStackResearch (npm/GitHub/official): npmjs.com (ink, blessed, @opentui/core, ai, @ai-sdk/*) · github.com/google-gemini/gemini-cli · github.com/anomalyco/opencode (provider.ts, package.json) · github.com/earendil-works/pi-mono · ai-sdk.dev v5 (provider-management/tools/stopping-streams) · platform.claude.com (auth) · platform.openai.com (Codex auth + device-code) · github.com/ollama/ollama (OpenAI-compat) · models.dev · nodejs.org release schedule · codex "Going Native" announcement
OssCredibility (23): github.com/Aider-AI/aider · aider.chat (+ /2024/04/09/gpt-4-turbo.html) · news.ycombinator.com/item?id=39995725 (Show HN 432pts) · github.com/Aider-AI/aider/releases/tag/v0.86.0 ("wrote 88%") · github.com/anomalyco/opencode (+ releases/tag/v1.18.31, agent-bot author) · newsletter.pragmaticengineer.com/p/opencode · techfundingnews.com/opencode-the-background-story… · block.xyz/inside/block-open-source-introduces-codename-goose · github.com/aaif-goose/goose · thenewstack.io/block-goose-agentic-foundation · block.xyz/inside/block-anthropic-and-openai-launch-the-agentic-ai-foundation · linuxfoundation.org/press/…aaif… · aaif.io · charm.land/blog/crush-comes-home · news.ycombinator.com/item?id=44736176 (crush HN 367pts) · raw.githubusercontent.com/charmbracelet/crush/main/LICENSE.md + CLA.md · news.ycombinator.com/item?id=48491407 · raw.githubusercontent.com/block/goose/main/LICENSE (Apache-2.0) · hashicorp.com/blog/hashicorp-adopts-business-source-license · opentofu.org/manifesto · news.ycombinator.com/showhn.html · github.com/charmbracelet/vhs · youtube.com/watch?v=1VqKUrxR2C8 (Dax) · redmonk.com/sogrady/2026/06/04/bun-two-lessons · sonarsource.com/blog/maintainer-burnout-is-real · theregister.com "maintainers underpaid and going gray" (2024-09-18)
Key anchors: anthropic.com/engineering/building-effective-agents ·
anthropic.com/engineering/writing-tools-for-agents · code.claude.com/docs/en/agent-sdk ·
modelcontextprotocol.io · agentskills.io · pi.dev/docs · opencode.ai/docs/permissions ·
mini-swe-agent.com/latest/faq · learn.chatgpt.com/docs/agent-approvals-security ·
newsletter.pragmaticengineer.com/p/opencode · aaif.io · thenewstack.io/block-goose-agentic-foundation

## 8. Recording surface (video-series safety gate)
This box co-hosts production systems (CRMs, wallet passes, telephony, secrets, 10.10.x.x
topology). Every recorded episode is captured from a sanitized demo surface — a dedicated
throwaway project (VM or clean shell) with no prod .env reachable, no entity keys, no
internal IPs on screen — never the hub shell. QC gate for every episode, same class as the
render gates: "no secrets, no 10.10.x.x, no VM topology on screen." Same pattern as the
public-agent-tool demos (Claude Code, aider, OpenHands): demo in sandboxes, not prod shells.