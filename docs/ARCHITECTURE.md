# Browsergator architecture

## Runtime shape

```text
Native HTTP clients                 stdio-only clients
   │ Authorization + HTTP               │ stateless adapter
   └──────────────────────┬──────────────┘
   ▼
HTTP boundary ─ health/readiness/status
   │
   ▼
MCP tool layer ─ validation, correlation, error mapping
   │
   ▼
BrowserGateway
   ├─ ProtectedTabPolicy
   ├─ LeaseManager (explicit owner + TTL + client-session cleanup)
   ├─ PerTabFifo (mutations only)
   ├─ IdempotencyStore
   ├─ EventStore (bounded rings)
   └─ AuditLogger (redacted JSONL)
   │
   ▼
WebSocketCdpDriver
   ├─ one browser-level WebSocket
   ├─ flattened target sessions, keyed by Chrome targetId/pageId
   ├─ continuous Target discovery
   └─ reconnect loop
```

`pageId` is the stable Chrome `TargetID`, not a gateway-local numeric selection. There is no shared “current tab”.

## Identity and state ownership

The singleton process owns all queues, leases, idempotency records, MCP transports, CDP target sessions, and event buffers. These are intentionally in memory for the MVP. The audit stream is append-only JSONL on disk.

The gateway keeps seven identifiers separate: MCP client session, `agentId`, `taskId`, `browserSessionId`, `browserContextId`, `pageId`, and `leaseOwnerId`. A client session is transport state and a best-effort cleanup hook, not agent authority. Lease equality uses the explicit lease owner plus agent and task. Chrome connection epochs receive a gateway-generated browser session ID; targets expose their CDP browser context and page ID.

## CDP strategy

The driver fetches `/json/version`, opens the advertised browser WebSocket, enables target discovery, and uses flattened `Target.attachToTarget` sessions. Commands carry the target session ID over the single socket. This supports parallel page traffic without one WebSocket per client and keeps event observation independent of connected agents.

The driver never starts Chrome. A disconnected browser makes readiness fail and page operations return `BROWSER_DISCONNECTED`; reconnection uses bounded exponential backoff.

## MCP transport

The implementation uses stateful Streamable HTTP sessions from the official TypeScript SDK. Each initialization gets an opaque MCP client session ID. DELETE/transport close releases leases still associated with that client as a cleanup optimization; TTL remains authoritative recovery. Application identity travels explicitly as `agentId`, `taskId`, and `leaseOwnerId`, with `correlationId` and `idempotencyKey` where relevant. The stdio adapter contains no application state and creates an ordinary upstream HTTP client session.

## Versions verified 2026-08-27

- Live Chrome: 151.0.7922.140
- Live Chrome DevTools MCP processes: 1.7.0; npm latest during discovery: 1.8.0
- `@modelcontextprotocol/sdk`: 1.30.0
- Node: 22.22.1

Primary references: [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp), [MCP TypeScript SDK server guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/server.md), [MCP Streamable HTTP transport](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports), and [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/).
