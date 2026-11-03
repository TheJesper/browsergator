# HANDOVER: Contexts + Parity work (P1 + P2)

**From:** orchestrator (relaying Jesper)
**Date:** 2026-08-31
**Priority:** P1 (contexts) then P2 (parity audit)
**Constraint:** work directly in shared repo; NO fork-and-abandon; preserve existing changes; NO production deploy without Jesper approval

## Two bounded work items

### P1 — SPEC-BG-CONTEXTS-001 (do FIRST)
`docs/specs/SPEC-BG-CONTEXTS-001.md`

Explicit browser-window + incognito/browser-context support.
- New APIs: `create_browser_context`, `dispose_browser_context`, `open_tab({...browserContextId?, newWindow?})`
- Separate identity: context / page / agent / task / lease
- Ownership + TTL + safe disposal + no tab-groups on newWindow
- Full AC list + files-to-touch in spec

**Estimate:** 1-2 days focused work.

### P2 — SPEC-BG-PARITY-AUDIT-001 (do AFTER P1 lands)
`docs/specs/SPEC-BG-PARITY-AUDIT-001.md`

Audit-first, then bounded per-feature specs.
- Inventory chrome-devtools-mcp gaps vs Browsergator's 22 tools
- Rank by multi-agent-utility × security × impl-cost
- Create child SPEC-BG-<TOOL>-001.md per top-5 gap
- NO big-bang implementation — one spec at a time

**Estimate:** 2-4h audit, 1-2h/spec skeletons.

## Working rules (from Jesper)

- Work IN this shared repo — no forks
- Preserve existing uncommitted changes (check `git status` first)
- Run lint + typecheck + test + build on each PR
- Live smoke ONLY on temp CDP-Chrome test-targets — never against user's daily Chrome
- No production/deploy push without Jesper approval
- One PR per feature — no bundled mega-changes

## What to do first

1. `git status` to see current state
2. Read `SPEC-BG-CONTEXTS-001.md` fully
3. Answer the 5 open questions in §6 with a design-note back to orch (tab 5 window 3 in OctoTerm 27336) OR write them into a `docs/specs/SPEC-BG-CONTEXTS-001-design.md`
4. Begin implementation — start with types.ts + cdp/ wrappers, then gateway, then MCP/HTTP surfaces
5. Ping orch when P1 shipped + tests green → we start P2

## Coordination points

- Overlaps with OctoTerm agent's BUG-8 work (metadata.agentId propagation) — the new identity model here should be aligned so agentId flows through both systems consistently
- `performance_screencast` gap (P2) overlaps with promotor's demo-video-stack — coordinate before implementing
- Any change to public API (README-visible tools) must be reflected in Slowgun contribution docs — see `CONTRIBUTING.md`

## Ref

- Repo: `W:/code/browsergator/` (github: TheJesper/browsergator, MIT, npm `browsergator-mcp`)
- Existing docs: `docs/`
- Commits since baseline: `2360872` (tab-group conflict doc), `da03499` (Slowgun encourage), `00a19cb` (parity expand + CI)
- Slowgun contribution model — direct-contribution not fork-and-PR

Reply to orch (OctoTerm tab 5 window 3, instance 27336) when P1 landed.
