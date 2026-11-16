# Browsergator product specification

## Problem

The machine has one dedicated agent Chrome, but agent conversations currently spawn independent `chrome-devtools-mcp` processes. Each process owns its own selected-page state and CDP sessions. The live discovery on 2026-08-27 found 20 server processes, 20 npm wrappers, and 20 telemetry watchdogs attached around the same browser.

Chrome DevTools MCP documents `--experimentalPageIdRouting` for the case where concurrent agents already share one server instance. It exposes a page argument inside that process; it does not turn many stdio processes into a singleton or coordinate their mutations.

## MVP outcome

One authenticated Streamable HTTP MCP endpoint owns one long-lived CDP browser connection. Every page-scoped operation has an explicit `pageId`. Different pages can mutate concurrently; mutations for one page are FIFO serialized. Runtime leases, protected-tab rules, observation buffers, audit events, diagnostics, and reconnect handling live in the same process.

Codex, Claude Code, Gemini CLI, TeamRoom/Forge agents, and other MCP clients may use the endpoint simultaneously. Direct Streamable HTTP is preferred; stdio-only clients use a stateless bridge to the same gateway. Transport sessions and logical agents are separate.

## MVP scope

- Browser connection and target lifecycle discovery
- Twenty-two MCP tools listed in `MCP-TOOLS.md`
- Per-page queues and expiring runtime leases
- Atomic navigate-and-verify operation
- Accessibility snapshot and PNG/JPEG screenshot
- Bounded console, network, WebSocket, and lifecycle observation
- Response-body retrieval when Chrome still retains the body
- Header/secret redaction and audit JSONL
- Bearer authentication, loopback binding, Host/Origin checks
- Protected URL patterns with agent allowlist
- Unit and mock-CDP integration tests
- Direct multi-client HTTP support plus a tested stateless stdio-to-HTTP adapter
- Selector/text/UID targeting, click/fill/form interaction, pointer/keyboard primitives, waits, and JavaScript dialog handling through the shared per-page queue
- Explicit separation of client session, agent, task, browser session, browser context, page, and lease owner

## Deferred

Scroll, uploads/downloads, richer dialog/CAPTCHA resume UX, request interception, browser contexts, full storage/cookie APIs, emulation, traces, screencast, richer atomic action plans, durable multi-process state, natural interaction, and CloakBrowser sessions.

## Non-goals

- Launching, restarting, killing, or repairing Chrome
- CAPTCHA solving
- Purchases, trading, BankID, or sensitive form submission
- LAN/internet exposure
- Preserving complete sensitive network bodies

## Acceptance criteria

All quality gates pass; two simulated MCP clients can mutate different tabs concurrently; same-tab mutations execute FIFO; reads are not held behind that FIFO; leases expire and clean up on client loss; logical ownership survives a reconnect; protected tabs reject unauthorized mutations; the stdio adapter reaches the shared HTTP singleton; and a mock CDP disconnect/reconnect is observable.

## Proposed operational hardening

Status: requirements proposal, not implementation or a claim that every criterion
below currently fails. Extend the existing diagnostics, leases and reconnect path;
do not introduce a second browser driver or recovery service.

### BG-OP-01 / P0: distinguish gateway liveness from browser readiness

Observation: HTTP liveness can recover while readiness remains `not_ready` and an
MCP call reports `BROWSER_DISCONNECTED`. A browser evaluation or CDP timeout alone
does not identify whether the fault is in the page, Chrome, transport or gateway.
The underlying cause must be diagnosed separately.

Acceptance criteria:

- `/healthz` answers within one second in a mock-CDP test where upstream browser
  calls never resolve. It must not depend on a successful CDP round trip.
- `/readyz` distinguishes connecting, connected, disconnected and recovering,
  including a bounded, redacted reason and the last successful connection time.
  Preserve existing status-field compatibility.
- Diagnostic output distinguishes HTTP/MCP handshake failures, page-command
  timeouts and browser disconnects. Do not report browser availability based only
  on the gateway's HTTP health.
- Recovery preserves unrelated tabs. A listening-but-unresponsive browser endpoint
  must not be interpreted as permission to spawn another Chrome/profile.
- A reconnect remains observable and bounded. When automatic recovery cannot
  succeed, report the specific operator action required rather than looping
  silently or returning success-shaped results.

### BG-OP-02 / P0: bounded calls and explicit partial completion

Acceptance criteria:

- Connect, initialization, tool execution and client shutdown each have a finite
  deadline and a distinguishable failure stage.
- When a sequence fails after earlier mutations, the client can identify completed,
  failed and not-attempted operations. Previously captured evidence is preserved.
- An MCP error produces a controlled client failure, not a secondary unhandled
  shutdown failure that hides the original error. Exercise this with disconnects,
  timeouts and interrupted client processes on supported operating systems.
- Document one diagnostic/recovery path through the gateway. Do not recommend
  bypassing coordination with direct CDP when the gateway is unavailable.

### BG-OP-03 / P1: cleanup ownership survives an interruption

Acceptance criteria:

- Reconnect diagnostics expose browser-session identity alongside page identity.
  Clients re-list tabs and verify origin/ownership before reusing a saved page ID.
- A client can retain a minimal, local cleanup journal for its own modified
  preferences and dispatch wrappers. Exclude credentials and unrelated storage.
- An interrupted cleanup is reported as pending, not completed. Retain the backup
  until restoration and read-back verification succeed.
- Gateway recovery must not close unrelated tabs, assume ownership of other
  clients' leases, or automatically clear origin-wide preferences.
- Test browser disconnect before restore, restore failure, expired lease and a
  replaced page/session. Cleanup must not claim success merely because a tab is
  missing.
