# MCP tools

All page-specific tools require an explicit Chrome target ID in `pageId`. Tool failures return a structured JSON object and set MCP `isError`.

## Reads

- `list_tabs`: current page targets plus protected/lease metadata. No page queue.
- `snapshot`: bounded accessibility tree for one page. No mutation queue.
- `screenshot`: PNG or JPEG image for one page. No mutation queue.
- `console_list`: bounded observed console/log/exception entries.
- `network_list`: bounded observed request/response/WebSocket metadata with sensitive headers redacted.
- `network_get_response_body`: asks Chrome for a retained response body. Returns `RESPONSE_BODY_UNAVAILABLE` if evicted or unknown and caps output size.

## Mutations

- `open_tab`: creates a new page target. It does not reuse an existing tab.
- `close_tab`: per-page FIFO mutation; denied for protected tabs unless authorized.
- `navigate`: per-page FIFO mutation with automatic short lease behavior.
- `run_atomic`: FIFO claim, policy check, navigate, optional URL/title verification, and release. The required idempotency key deduplicates retries.

## Coordination

- `claim_tab`: obtains or renews a short runtime lease for `{agentId, taskId, leaseOwnerId}`.
- `release_tab`: releases a matching lease ID and explicit logical owner. Client-session cleanup is only a best-effort fallback.

Mutation metadata uses required `agentId`, `taskId`, and `leaseOwnerId`, optional `correlationId`, and optional or required `idempotencyKey`. The server-supplied MCP client session is recorded separately and is never sufficient to identify an agent or lease owner.

## Error codes

`TAB_NOT_FOUND`, `TAB_PROTECTED`, `LEASE_CONFLICT`, `LEASE_EXPIRED`, `BROWSER_DISCONNECTED`, `NEEDS_HUMAN`, `RESPONSE_BODY_UNAVAILABLE`, `AUTH_REQUIRED`, `INVALID_CONFIG`, `IDEMPOTENCY_CONFLICT`, and `INTERNAL_ERROR`.
