# ADR 0005: Client-neutral transport and explicit logical identity

## Status

Accepted.

## Context

Codex, Claude Code, Gemini CLI, TeamRoom, and other MCP clients may connect concurrently. One MCP client session can represent multiple subagents, while a reconnect can give one logical agent a new MCP session. Treating the transport session as the lease owner would conflate unrelated lifecycles.

## Decision

Streamable HTTP is the primary transport. Clients with native support connect directly. A thin stateless stdio adapter proxies tool discovery and calls to the same HTTP endpoint for stdio-only clients; it owns no Chrome, CDP, page, queue, lease, or event state.

The runtime models these identifiers separately:

| Identifier | Meaning | Authority |
|---|---|---|
| MCP client session | One transport initialization/lifecycle | Cleanup hint only |
| `agentId` | Logical agent or subagent | Audit and policy principal |
| `taskId` | Unit of work | Audit/idempotency scope |
| `browserSessionId` | One gateway-to-Chrome connection epoch | Diagnostic, gateway-generated |
| `browserContextId` | Chrome browser context | CDP target metadata |
| `pageId` | Chrome page target | Required routing key |
| `leaseOwnerId` | Explicit runtime lease owner | Lease authority with agent/task |

Lease equality uses `leaseOwnerId + agentId + taskId`, never MCP session ID. The client session that most recently claimed or renewed a lease is retained only for best-effort disconnect cleanup. A reconnect with the same explicit owner can renew a lease and transfers that cleanup association to the new session.

## Consequences

Subagents sharing one connection cannot impersonate one another accidentally through transport state. Reconnects do not change logical ownership. Abrupt client loss still receives best-effort cleanup, with TTL as the final safety net. Every caller must provide explicit identity metadata on coordinated operations.
