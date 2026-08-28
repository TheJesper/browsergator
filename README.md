# Browsergator

Browsergator is a long-lived, client-neutral MCP service that lets many agents coordinate work against one dedicated browser over the Chrome DevTools Protocol (CDP). The stable MCP server ID remains `browser-gateway` for compatibility.

```text
Codex ───────┐
Claude ──────┼─ Streamable HTTP /mcp ─ Browsergator ─ one CDP WebSocket ─ agent Chrome
Gemini ──────┤
Copilot ─────┼─ stateless stdio adapter ┘
stdio client ┘
```

The gateway uses explicit Chrome target IDs as `pageId`, permits parallel work on different tabs, serializes mutations per tab with FIFO queues, and protects sensitive tabs with leases and policy. Reads normally bypass the mutation queue.

Tabs are created as individual tabs. Browsergator must never create a tab group or browser context implicitly; a client must request an explicit grouping feature when one is available. If no grouping request is present, leave Chrome's tab groups unchanged.

## MVP tools

`list_tabs`, `open_tab`, `close_tab`, `navigate`, `click`, `fill`, `snapshot`, `screenshot`, `console_list`, `network_list`, `network_get_response_body`, `claim_tab`, `release_tab`, and `run_atomic`.

## Requirements

- Node.js 22.12 or newer
- A dedicated Chrome already listening on a loopback CDP URL
- A long random bearer token

The gateway never launches or stops Chrome.

## Install and run

```powershell
cd <repo-root>
npm install
$env:BROWSER_GATEWAY_TOKEN = ([Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)))
npm run build
npm start
```

For an installed Windows singleton, `scripts/run-gateway.ps1` reads a persistent user token and Task Scheduler can start it at user logon. See the client compatibility guide for global client setup.

Defaults:

- MCP: `http://127.0.0.1:8788/mcp`
- Health: `http://127.0.0.1:8788/healthz`
- Readiness: `http://127.0.0.1:8788/readyz`
- Authenticated diagnostics: `http://127.0.0.1:8788/status`
- CDP: `http://127.0.0.1:9222`

All `/mcp` and `/status` requests require `Authorization: Bearer <token>`. Native clients may omit `Origin`; supplied Origin and Host headers are restricted to loopback.

## Client configuration

Codex, Claude Code, Gemini CLI, and TeamRoom/Forge agents using Claude Code connect directly through Streamable HTTP. GitHub Copilot CLI uses the included stateless stdio adapter because direct HTTP configuration did not expose the gateway tools in the installed CLI during end-to-end verification. The adapter forwards to the same gateway and never owns Chrome. Exact commands and configuration files are in [docs/CLIENT-COMPATIBILITY.md](docs/CLIENT-COMPATIBILITY.md).

MCP client session, `agentId`, `taskId`, browser session, browser context, `pageId`, and `leaseOwnerId` are distinct concepts. A shared client connection may contain several subagents, so every coordinated call carries explicit logical identity.

## Quality gates

```powershell
npm run lint
npm run typecheck
npm test
npm run build
```

See [docs/PRODUCT-SPEC.md](docs/PRODUCT-SPEC.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), and [docs/SECURITY.md](docs/SECURITY.md).

## Responsible use and accessibility

Browsergator can help people who need an AI-assisted browser interface, including people with disabilities. The operator remains responsible for the accounts, permissions, instructions, data, and actions delegated to an agent. Use it only with authorised systems, keep humans in the loop for consequential actions, and never use it to bypass security or facilitate unlawful activity. Read the full [disclaimer and acceptable-use policy](DISCLAIMER.md).

## Contribute with us

We use our Slowgun workflow to contribute directly to the shared project instead of creating forks. Bring an idea, test a client, fix a rough edge, or improve the docs — then help make Browsergator reach the next level together.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the quality gates and contribution guidelines.

## Publish

The package is prepared for public npm distribution as `browsergator-mcp`:

```powershell
npm pack --dry-run
npm publish --access public
```

The published package contains the compiled `dist/` gateway and stdio adapter. The stable MCP server ID is intentionally still `browser-gateway`, so existing client configurations do not need to change.
