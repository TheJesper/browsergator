# Concurrency model

## Invariants

1. There is one gateway process and one browser-level CDP socket.
2. Every mutation for page P enters P's FIFO tail.
3. Mutation queues for P and Q are independent and may run simultaneously.
4. Ordinary reads do not enter a mutation queue.
5. A valid foreign lease blocks mutation, even after the caller reaches the head of the queue.
6. An expired lease is removed before every claim/check and by periodic cleanup.
7. Lease ownership is `{leaseOwnerId, agentId, taskId}` and is independent of the MCP client session.
8. Client-session termination releases leases still associated with it as best-effort cleanup; TTL is the final cleanup mechanism.

## Automatic lease behavior

`navigate` and `close_tab` use an ephemeral lease while executing unless the same explicit owner/agent/task already owns the tab. A foreign lease yields `LEASE_CONFLICT`. Explicitly owned leases remain after the mutation; ephemeral leases release in `finally`. Renewing from a new MCP connection transfers the cleanup association without changing logical ownership.

## Atomic operation

`run_atomic` performs claim → fresh policy check → action → verification → release inside one page FIFO slot. Its idempotency key stores the completed result. A retry with a different request fingerprint returns `IDEMPOTENCY_CONFLICT`.

## Reads during mutation

Reads intentionally observe the current browser state and may overlap a mutation. Callers needing a post-mutation observation should use `run_atomic` verification or wait for the mutation response before reading.

## Crash behavior

In-memory leases disappear with the singleton. Chrome stays running. On restart, target discovery reconstructs page/event observation; old queues, leases, and response-body handles are not recovered.
