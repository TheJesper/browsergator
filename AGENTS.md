# Browsergator agent rules

These rules apply to the entire repository.

1. Never start, stop, kill, reconfigure, or attach to a normal user browser. The only permitted live CDP target is the dedicated agent Chrome at the configured loopback URL and profile `C:/Users/jespe/.cache/chrome-devtools-mcp/chrome-profile`.
2. Never remove Chrome profile lock files while Chrome is running and never use broad process-kill commands.
3. Do not connect integration tests to the real CDP endpoint. Tests must use `MockBrowserDriver` unless a human explicitly requests a live smoke test.
4. A live smoke test may only open a new harmless tab, use `example.com`, and close only the page ID created by that test.
5. Keep the gateway and CDP on loopback by default. Do not weaken token, Host, or Origin validation without a documented security review.
6. Every page-scoped tool must require explicit `pageId`. Mutations must pass through the per-tab FIFO coordinator and protected-tab policy.
7. Never log raw authorization headers, cookies, passwords, API keys, BankID data, request post bodies, or full response bodies.
8. Update the relevant docs and tests when changing concurrency, security, MCP tools, or event behavior.
9. Before handoff, run `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build`.
10. Keep MCP client session, `agentId`, `taskId`, `browserSessionId`, `browserContextId`, `pageId`, and `leaseOwnerId` distinct. Never use the MCP connection alone as agent or lease identity.
11. Any stdio compatibility layer must remain a stateless proxy to the shared Streamable HTTP gateway and must never import, launch, stop, or own Chrome/CDP.
