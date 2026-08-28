# Browsergator product specification

## Problem

The machine has one dedicated agent Chrome, but agent conversations currently spawn independent `chrome-devtools-mcp` processes. Each process owns its own selected-page state and CDP sessions. The live discovery on 2026-08-27 found 20 server processes, 20 npm wrappers, and 20 telemetry watchdogs attached around the same browser.

Chrome DevTools MCP documents `--experimentalPageIdRouting` for the case where concurrent agents already share one server instance. It exposes a page argument inside that process; it does not turn many stdio processes into a singleton or coordinate their mutations.

## MVP outcome

One authenticated Streamable HTTP MCP endpoint owns one long-lived CDP browser connection. Every page-scoped operation has an explicit `pageId`. Different pages can mutate concurrently; mutations for one page are FIFO serialized. Runtime leases, protected-tab rules, observation buffers, audit events, diagnostics, and reconnect handling live in the same process.

Codex, Claude Code, Gemini CLI, TeamRoom/Forge agents, and other MCP clients may use the endpoint simultaneously. Direct Streamable HTTP is preferred; stdio-only clients use a stateless bridge to the same gateway. Transport sessions and logical agents are separate.

## MVP scope

- Browser connection and target lifecycle discovery
- Twelve MCP tools listed in `MCP-TOOLS.md`
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
- Explicit separation of client session, agent, task, browser session, browser context, page, and lease owner

## Deferred

Element-level click/type/drag/scroll, uploads/downloads, dialogs and CAPTCHA resume UX, request interception, browser contexts, full storage/cookie APIs, emulation, traces, screencast, richer atomic action plans, durable multi-process state, natural interaction, and CloakBrowser sessions.

## Non-goals

- Launching, restarting, killing, or repairing Chrome
- CAPTCHA solving
- Purchases, trading, BankID, or sensitive form submission
- LAN/internet exposure
- Preserving complete sensitive network bodies

## Acceptance criteria

All quality gates pass; two simulated MCP clients can mutate different tabs concurrently; same-tab mutations execute FIFO; reads are not held behind that FIFO; leases expire and clean up on client loss; logical ownership survives a reconnect; protected tabs reject unauthorized mutations; the stdio adapter reaches the shared HTTP singleton; and a mock CDP disconnect/reconnect is observable.
