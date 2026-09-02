# Browsergator

<p align="center">
  <img src="assets/brand/browsergator-mascot-256.png" alt="Browsergator pixel-art mascot" width="192">
</p>

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

`list_tabs`, `open_tab`, `close_tab`, `navigate`, `click`, `fill`, `wait_for`, `press_key`, `type_text`, `hover`, `click_at`, `drag`, `fill_form`, `handle_dialog`, `snapshot`, `screenshot`, `console_list`, `network_list`, `network_get_response_body`, `claim_tab`, `release_tab`, and `run_atomic`.

## Requirements

- Node.js 22.12 or newer
- A dedicated Chrome already listening on a loopback CDP URL
- A long random bearer token

The gateway never launches or stops Chrome.

## Install and run

```text
cd <repo-root>
npm install
npm run build
npm run serve
```

`npm run serve` starts the gateway in the foreground on every OS (Windows, macOS, Linux) using the Node runtime that runs npm -- no hardcoded interpreter path. Press Ctrl+C to stop it. Use `npm run serve:dev` to run the TypeScript source directly via tsx.

### Provide the token

The gateway reads `BROWSER_GATEWAY_TOKEN` (>= 24 chars) from the environment. Set it in your shell, or put it in a project-root `.env` file (see `.env.example`; `.env` is gitignored). A real environment variable always wins over `.env`.

Generate a token:

```bash
# bash / zsh
export BROWSER_GATEWAY_TOKEN=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")
# or: openssl rand -base64 32
```

```powershell
# PowerShell
$env:BROWSER_GATEWAY_TOKEN = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
```

```bash
# portable -- writes a .env file (any OS with Node)
node -e "const c=require('crypto');require('fs').writeFileSync('.env','BROWSER_GATEWAY_TOKEN='+c.randomBytes(32).toString('base64url')+'\n')"
```

On Windows you may still use `scripts/run-gateway.ps1`, which now resolves Node from PATH (works with nvm4w, fnm, winget, Scoop) and delegates to the portable launcher. For a persistent service, see the deployment recipes (Windows Task Scheduler, macOS launchd, Linux systemd) in the client compatibility guide.

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

```text
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
