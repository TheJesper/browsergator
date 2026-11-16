# Restarting the gateway from MCP

The `restart_gateway` tool is an explicit control-plane operation for applying a new Browsergator build without touching the shared Chrome.

## Safety contract

- The call must include `confirm: true`; agents should obtain user approval immediately before calling it.
- The MCP server must be running under `scripts/run-gateway.mjs` (the supervisor). Direct `node dist/index.js` runs report restart unavailable.
- The gateway closes HTTP sessions and its CDP socket cleanly, then exits with the supervisor-only restart code.
- The supervisor respawns the same compiled entry with the same environment and configured `BROWSER_GATEWAY_BROWSER_URL`.
- Chrome, its profile, tabs, cookies, and browser contexts are not launched, closed, or replaced by the restart.

Example arguments:

```json
{
  "confirm": true,
  "reason": "activate the latest Browsergator build",
  "agentId": "my-agent",
  "taskId": "release-2026-11-03",
  "leaseOwnerId": "my-agent-release"
}
```

The caller should treat the MCP connection as transient during the restart and reconnect to `http://127.0.0.1:8788/mcp` after `/healthz` returns `200` and `/readyz` returns `200`.
