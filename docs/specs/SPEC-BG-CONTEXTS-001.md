# SPEC-BG-CONTEXTS-001 — Explicit browser-window + incognito/browser-context support

**Status:** Draft
**Priority:** P1
**Owner:** browsergator code-agent (to be assigned)
**Created:** 2026-08-31 by orchestrator (relaying Jesper)
**Constraints:** work directly in shared repo, no fork-and-abandon, preserve existing changes, NO production deploy without Jesper approval

## 1. Problem

Today Browsergator serves many agents sharing ONE Chrome instance with a flat page-pool. Missing:
- No first-class **browser-context** concept — every tab shares cookies/storage/auth
- No **incognito** or isolation for sensitive-work (auth-heavy flows, cross-account testing)
- No way to open a **new window** cleanly (spawning tabs sometimes ends up in Claude/plugin tab-groups per `Document Claude plugin tab-group conflict` bug, commit `2360872`)
- Identity model conflates context/page/agent/task/lease — hard to enforce ownership at context boundary

## 2. Goals (must-have)

1. **New APIs** in gateway + MCP + stdio-adapter:
   - `create_browser_context({ owner, ttl, incognito?, name? }) → { browserContextId }`
   - `dispose_browser_context({ browserContextId, force? }) → { disposed, closedPages }`
   - `open_tab({ url, browserContextId?, newWindow?, agentId, taskId, leaseOwnerId }) → { pageId, browserContextId, windowId }`
2. **Identity separation** — every operation tracks 5 distinct dims:
   - `browserContextId` (isolation boundary — cookies/storage)
   - `pageId` (existing Chrome target-id)
   - `agentId` (logical caller)
   - `taskId` (unit-of-work)
   - `leaseOwnerId` (mutation-serialization)
3. **Ownership & lifecycle**:
   - Every context has an explicit `owner` (agentId or human-labelled)
   - Context TTL (default 30 min, configurable per-call)
   - Auto-cleanup job runs every N sec, disposes expired contexts + their pages
   - `force` on dispose closes even non-idle pages
4. **New windows don't create tab groups** — see #3 conflict. Use CDP `Target.createBrowserContext` + `Target.createTarget` with `newWindow: true` and NOT the Chrome-UI "new window in group" path.
5. **Single Chrome/CDP socket + gateway authority preserved.** Contexts are additive over existing pool, not a rewrite.

## 3. Non-goals

- Multi-Chrome-instance orchestration (still ONE Chrome per gateway)
- Persistent contexts across gateway restarts (in-memory only for now)
- Cross-context resource sharing (localStorage bridge, cookie transfer) — explicitly out

## 4. Acceptance Criteria

- **AC1:** `create_browser_context` returns a stable `browserContextId`; two contexts have isolated cookies (verified via test — set cookie in A, read from B returns null)
- **AC2:** `open_tab` with `browserContextId` places the tab in that context; without it uses the default context (backwards-compatible)
- **AC3:** `open_tab` with `newWindow: true` creates a new Chrome window NOT in any tab-group; verified via CDP `Target.getTargets` inspection
- **AC4:** `dispose_browser_context` closes all pages in the context and frees resources; called on non-existent id returns friendly error, not crash
- **AC5:** Context TTL enforced — a context past `ttl` gets auto-disposed within `cleanupInterval` seconds; disposal event logged
- **AC6:** `force` flag on dispose closes even pages with active leases; without `force` returns error if leases active
- **AC7:** All existing MCP tools (list_tabs, navigate, snapshot, screenshot, etc.) accept `browserContextId` optional param and filter/scope accordingly
- **AC8:** Types updated in `src/types.ts`; driver in `src/cdp/`; gateway in `src/gateway.ts`; MCP schemas in `src/mcp/` and `src/http/`; stdio-adapter in `src/stdio-adapter.ts`; mocks in `test/`
- **AC9:** Docs updated (README.md + `docs/` — new file `docs/BROWSER-CONTEXTS.md`)
- **AC10:** `npm run lint && npm run typecheck && npm test && npm run build` all green
- **AC11:** Live smoke tested ONLY against tmp test-target (a dedicated CDP-Chrome spawned for testing, not user's daily Chrome)

## 5. Rollout / Safety

- No production deploy without Jesper approval (per Constitution)
- Feature-flag `EXPERIMENTAL_BROWSER_CONTEXTS=1` gate for first 2 weeks
- Backwards-compat: all existing tools MUST work without `browserContextId` param (uses default context)
- Migration: no data-migration needed; contexts are ephemeral

## 6. Open Questions (for code-agent to resolve during design)

1. How to expose `browserContextId` in `list_tabs` output — new column, or nested grouping?
2. Should `create_browser_context` accept an `incognito: true` flag OR should incognito be a separate context-type entirely?
3. Cleanup granularity — per-context TTL, per-page idle-timeout, or both?
4. Concurrent-lease behavior — can two agents lease pages in the SAME context, or is one-agent-per-context stricter?
5. How does BUG-8-agentId-metadata interact with `browserContextId` — is `context.owner` derived from `agentId` on first tab or set explicitly?

## 7. Files to touch (initial estimate)

- `src/types.ts` — new BrowserContext type + expanded identity types
- `src/gateway.ts` — context lifecycle + auto-cleanup loop
- `src/cdp/` — CDP `Target.createBrowserContext` + `Target.disposeBrowserContext` wrappers
- `src/mcp/` + `src/http/` — new MCP tool schemas + HTTP endpoints
- `src/stdio-adapter.ts` — stdio-bridge for new tools
- `test/` — new unit tests for context lifecycle + isolation + integration test
- `docs/BROWSER-CONTEXTS.md` — new doc
- `README.md` — Add to tool-list

## 8. Estimated size

Medium — probably 1-2 days work for a focused code-agent. Bounded: no scope creep into other parity-gaps (those go in SPEC-BG-PARITY-AUDIT-001).
