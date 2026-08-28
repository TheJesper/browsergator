# Browsergator problem-fit analysis

**Date:** 2026-08-28
**Verdict:** Real problem, narrow but growing audience, defensible niche. Worth OSS push with focused messaging — not a viral HN moonshot on its own.

## 1. Exact problem
Multiple AI coding agents (Codex + Claude Code + Gemini + Copilot + custom) sharing ONE Chrome for automation each spawn their own `chrome-devtools-mcp` process, causing conflicting page-selection state, duplicated CDP sessions, and no coordination on same-tab mutations. Browsergator = single long-lived MCP gateway that fans many agents into one browser with explicit `pageId`, per-tab FIFO mutation queues, leases, and protected-tab policy.

## 2. Personas today
- **Multi-agent power users** running Codex + Claude Code + Gemini side-by-side against a persistent logged-in browser (Jesper's exact setup — 20 duplicate MCP processes observed 2026-08-27).
- **TeamRoom/Forge / multi-agent orchestration builders** (DevKit, crewAI, LangGraph, Swarm-style tools) needing shared browser state across agents.
- **QA / E2E automation** where multiple agent-driven test lanes hit the same authenticated app.
- **Prompt-eng / agent-eval labs** comparing agents against a live web app with real session.
- **Solo devs** annoyed by Chrome-CDP process explosion and lost session state between agents.

## 3. Alternatives + delta
| Alternative | Gap Browsergator closes |
|---|---|
| `chrome-devtools-mcp` per-agent stdio | No coordination, page-state races, 20× resource waste |
| `--experimentalPageIdRouting` | Only helps within ONE server process, doesn't unify many stdio clients |
| `playwright-mcp` | Launches own browsers, no share-existing-session, no leases |
| Isolated browser-per-agent | Loses shared login, wastes RAM, no cross-agent handoff |
| Direct CDP scripts | Everyone rebuilds queuing/leases/audit from scratch |

**Unique combo:** client-neutral Streamable HTTP + stateless stdio bridge + explicit logical identity (agent/task/lease separate from MCP session) + protected-tab policy + audit JSONL. Nothing else ships all five.

## 4. Adoption blockers
- Requires user-launched Chrome on CDP port (not launch-and-forget) — friction.
- Node 22.12+ requirement excludes conservative shops.
- No element-level click/type yet (v0.3) — pure automation folks bounce.
- Docs deep but no 60-sec "why me" landing / no demo GIF.
- Package name mismatch (`browsergator-mcp` vs stable id `browser-gateway`) confuses first-timers.
- Windows-first quickstart (PowerShell) — Linux/mac users need translated recipe.
- No public npm publish yet visible.

## 5. Marketing verdict
**Real hook exists but audience is 2026-vintage niche: people already running ≥2 agent CLIs.** That cohort is exploding (Codex GA, Claude Code, Gemini CLI, Copilot CLI all shipped in 2025-2026) — timing is good. Angles:

- **HN:** "Why my 20 Chrome-DevTools-MCP processes became one" — pain-story lede, resource-graph screenshot, MIT.
- **Reddit r/LocalLLaMA + r/ClaudeAI:** "Share one logged-in browser across Codex/Claude/Gemini" tutorial.
- **Product Hunt:** works if bundled with a 30-sec demo reel showing 3 agents on same Chrome without stepping on each other.
- **TikTok/short-form:** screen-recorded split-view of three agent CLIs cooperating on one tab — visually striking, promotor can produce.
- **Dev.to / blog:** deep-dive on per-page FIFO + leases (technical credibility).

**Not viral by itself** — needs demo reel + pain-story combo. Pair launch with the "why we built it" story (20 zombie processes) for authenticity.

## Recommendation
Ship v0.3 (element interaction) before big launch; polish 60-sec pitch on README top; publish to npm; then coordinated HN + Reddit + PH + short-form-video week.
