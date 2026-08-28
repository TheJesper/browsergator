# Test plan

## Automated unit tests

- FIFO preserves enqueue order and never overlaps same-page work.
- Lease claim, renew, conflict, explicit release, TTL expiry, client-session cleanup, and ownership across reconnect.
- Header and recursive secret redaction.
- Protected URL matching and allowlist decisions.
- Ring buffer bounds.
- Idempotent replay and conflicting reuse.

## Mock-CDP integration tests

- Two simulated clients mutate different pages concurrently.
- Two clients mutate the same page in FIFO order.
- A read completes while a mutation on that page is waiting.
- Unauthorized protected-page navigation is rejected.
- Browser disconnect produces `BROWSER_DISCONNECTED`; reconnect restores operations.
- Response-body unavailable behavior is stable.

## HTTP/MCP tests

- Health/readiness behavior.
- Missing/invalid bearer rejection.
- Two independent Streamable HTTP MCP clients share the singleton gateway.
- MCP session close releases owned runtime leases.
- A real child-process stdio adapter forwards discovery and tool calls to the same HTTP gateway.

## Live smoke test gate

Run only after all mock tests, lint, typecheck, and build pass. Confirm port 9222 belongs to Chrome using the dedicated profile. The test may open one new `https://example.com/` page, operate only on its returned page ID, and close only that page. Never navigate or close pre-existing targets and never start/stop Chrome.
