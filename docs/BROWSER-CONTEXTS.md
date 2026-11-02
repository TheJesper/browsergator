# Browser contexts, windows and isolation

Browsergator still uses one shared Chrome/CDP connection, but agents can request explicit CDP browser contexts when they need isolated cookies and storage. Contexts are incognito-like, owned by one logical `agentId`, and expire automatically.

## Lifecycle

1. Call `create_browser_context` with `owner` equal to your `agentId` and an optional `ttlMs`/`name`.
2. Pass the returned `browserContextId` to `open_tab`.
3. Use the returned explicit `pageId` for every page operation.
4. Call `dispose_browser_context` when finished. `force=false` refuses disposal while any page in the context has an active lease; use `force=true` only when the owner intentionally wants those leases revoked.

Omitting `browserContextId` preserves the default Chrome context and all existing clients remain compatible. The default context cannot be disposed.

## New windows

Set `newWindow: true` on `open_tab`. Browsergator maps this to CDP `Target.createTarget({ newWindow: true })` and returns `windowId` when Chrome reports it. Browsergator never uses Chrome UI tab-group operations, so opening a window does not create a tab group.

## Identity and safety

`browserContextId`, `pageId`, `agentId`, `taskId`, and `leaseOwnerId` remain separate. An MCP session is transport state only and is not an agent identity. Contexts are in-memory and are not restored after gateway restart. The stateless stdio adapter forwards these tools to the same HTTP gateway and owns no Chrome state.
