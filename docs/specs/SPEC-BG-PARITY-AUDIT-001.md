# SPEC-BG-PARITY-AUDIT-001 — Chrome DevTools MCP Parity Audit + Bounded Roadmap

**Status:** Draft (audit-first, then per-feature bounded specs)
**Priority:** P2 (P1 is SPEC-BG-CONTEXTS-001 — do that first)
**Owner:** browsergator code-agent (audit-phase = 1 subagent; implementation-phase = one bounded child-spec per feature)
**Created:** 2026-08-31 by orchestrator
**Constraints:** NO big-bang change. Each feature = its own bounded child-spec with tests + docs. NO production deploy.

## 1. Problem

Browsergator has 22 MCP tools today (list_tabs, open_tab, close_tab, navigate, snapshot, screenshot, console_list, network_list, network_get_response_body, claim_tab, release_tab, run_atomic, click, fill, plus ~8 more per recent commits). Chrome DevTools MCP (upstream reference) has more capabilities. We need to know the gap + prioritize by multi-agent utility & security.

## 2. Deliverables

### Phase 1 — AUDIT (this spec's scope)

1. **Inventory** — table of chrome-devtools-mcp tools NOT yet in Browsergator. Sources:
   - `mcp__plugin_chrome-devtools-mcp_chrome-devtools__*` tool list (available in Claude Code sessions)
   - Upstream `chrome-devtools-mcp` repo README + tool-list
2. **Ranking** — for each gap, score on 3 axes (each 1-5):
   - **Multi-agent utility** — how much does having this shared across agents matter?
   - **Security-sensitivity** — does exposing this risk unauthorized state-mutation across agent boundaries?
   - **Implementation cost** — CDP-simple wrapper vs new abstraction layer?
3. **Candidate gap-list to consider** (non-exhaustive — audit MUST verify + expand):
   - `upload_file` — file-upload to `<input type=file>`, needed for form-heavy automation
   - `evaluate_script` — JS eval in page context, MASSIVE utility but security-sensitive (sandbox needed for multi-agent)
   - `emulate` — device/network/geo/timezone emulation, needed for responsive-QA
   - `performance_start_trace` / `performance_stop_trace` / `performance_analyze_insight` — perf profiling
   - `lighthouse_audit` — one-shot Lighthouse run, high-value for launch-QA
   - `performance_screencast` — video-recording of session (overlaps with promotor's video-stack, coordinate)
   - `take_heapsnapshot` — memory profiling
   - `handle_dialog` — auto-accept/dismiss alert/confirm/prompt (already flagged as CRITICAL in claude-in-chrome docs due to blocking behavior)
   - `emulate_extensions` — Chrome extension emulation
   - WebMCP / WebSocket relay for two-way page ↔ agent messaging
   - `drag` — drag-and-drop (needed for canvas/kanban UIs)
   - `hover` — hover-triggered UI (menus, tooltips)
   - `fill_form` — bulk form-fill (vs single-field `fill`)
   - `press_key` — keyboard events (vs `type_text`)
   - `wait_for` — wait-for-selector/text-visible (deterministic sync)
4. **Output:** `docs/PARITY-AUDIT-2026-08-31.md` with table columns: `tool | in browsergator? | multi-agent utility (1-5) | security (1-5) | impl-cost (1-5) | overall rank | notes`

### Phase 2 — SPEC-CREATION (post-audit)

For each ranked gap, create a bounded child-spec:
- `docs/specs/SPEC-BG-<TOOL>-001.md` (e.g. `SPEC-BG-EVALUATE-SCRIPT-001.md`)
- Each spec MUST have: scope, ACs, files-to-touch, size-estimate, security-considerations, testing-plan
- Implementation is ONE spec at a time, per-feature bounded, no big-bang PRs

### Phase 3 — IMPLEMENTATION

- SPEC-BG-CONTEXTS-001 is P1 — that goes first
- Then top-3 from parity-audit ranked list
- Each implementation = own PR, own tests, own docs
- **DO NOT** blindly implement all in one changeset

## 3. Acceptance Criteria (this audit-spec)

- **AC1:** `docs/PARITY-AUDIT-2026-08-31.md` written with full inventory + ranked scores
- **AC2:** At least top-5 gaps have draft child-specs in `docs/specs/SPEC-BG-<TOOL>-001.md` (skeleton, not full impl)
- **AC3:** Audit identifies which gaps overlap with SPEC-BG-CONTEXTS-001 (avoid duplication)
- **AC4:** Security-sensitive tools (evaluate_script, emulate_extensions) flagged with explicit lease/sandbox-strategy notes
- **AC5:** No code changed as part of AUDIT itself (only docs)

## 4. Constraints

- **Bounded:** audit is docs-only. Implementation follows in separate specs.
- **No production deploy** at any stage without Jesper approval
- **Work in shared repo** — no fork-and-abandon
- **Preserve existing changes** — audit builds on current state, doesn't replace
- Priority order enforced: **SPEC-BG-CONTEXTS-001 ships first**, then audit-driven backlog

## 5. Coordination

- Coordinate with `octoterm-web` agent — some gaps (performance_screencast) overlap with promo demo-tooling
- Coordinate with `promotor` for hero-video use-cases
- Ping orch when audit lands so I can pin the priorities from a portfolio-lens

## 6. Estimated size

- Audit: 2-4 hours (single code-agent, doc-only)
- Child-spec skeletons: 1-2 hours (one per top-5 gap)
- Implementation: separately scoped per child-spec
