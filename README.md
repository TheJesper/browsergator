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

## Shared agent browser

Browsergator is designed as one always-on browser that many agents share. The gateway never
launches Chrome itself -- a dedicated Chrome runs alongside it and the gateway connects over CDP.

Start the dedicated Chrome (idempotent -- does nothing if it is already up):

```text
npm run chrome
```

This launches a separate Chrome with an isolated, persistent profile at
`<home>/.cache/browsergator/chrome-profile` (created automatically, never committed) and a
loopback debug port on `127.0.0.1:9222`. It is NOT your everyday Chrome -- Chrome 136+ no longer
allows remote debugging on the default profile, so a dedicated profile is required. Log in to
any service once in this browser; the session persists across restarts, so every agent works
against an authenticated browser without per-agent login.

Then start the gateway (`npm run serve`). When both are up, the gateway logs `Connected to
agent Chrome` once and reports `browserConnected: true`. Agents can connect and disconnect
freely; the browser and gateway stay running. For always-on setup at logon, see the per-OS
service recipes in the client compatibility guide.

Logs are quiet by default: while Chrome is not yet up the gateway prints a single "waiting for
agent Chrome" notice, not one line per retry. Set `BROWSER_GATEWAY_LOG_LEVEL=debug` (or
`BROWSER_GATEWAY_DEBUG=1`) to see per-attempt detail.

### If the browser is down -- one command, any agent

The shared Chrome and gateway are meant to be always-on and self-healing. If the browser was
closed, **any agent or user restarts it with one idempotent command** -- never hand-roll a
`chrome --remote-debugging-port` line, and never point it at a different `--user-data-dir`
(that creates a second, conflicting profile):

```text
npm run chrome     # safe to run anytime; does nothing if Chrome is already up
```

The launcher owns the correct profile (`<home>/.cache/browsergator/chrome-profile`) and starts
Chrome detached + windowless. The gateway then reconnects on its own within a few seconds --
you do NOT restart the gateway to recover from a browser outage. Confirm with:

```text
curl http://127.0.0.1:9222/json/version     # Chrome debug port up
curl http://127.0.0.1:8788/healthz          # gateway up (then a tool call shows browserConnected: true)
```

At logon both are started automatically by the OS services (see the client compatibility
guide), so in normal use you never start anything by hand.

## Install for agents (machine-wide)

Browsergator ships agent-facing guidance that teaches any agent how to connect to and drive
the shared browser. One command installs it into **every agent client on the machine**, so
any agent -- in any client, in any repo -- knows to use the shared browser as soon as it is
asked to browse:

```text
npm run install:agent                    # install into every detected client
npm run install:agent -- --dry-run       # preview only, writes nothing
npm run install:agent -- --uninstall     # remove only what this installed
npm run install:agent -- --all           # also install into clients not present yet
npm run install:agent -- --only=claude,codex   # limit to named clients
```

Two install shapes, because agent clients differ:

| Client | Target | Shape |
|---|---|---|
| Claude Code | `~/.claude/skills/` | `bg` skill + `browse` / `browser` / `browsergator` aliases |
| Kiro | `~/.kiro/skills/` | same |
| Codex | `~/.codex/AGENTS.md` | managed markdown block |
| Gemini CLI | `~/.gemini/GEMINI.md` | managed markdown block |
| GitHub Copilot CLI | `~/.copilot/copilot-instructions.md` | managed markdown block |
| Cursor | `~/.cursor/rules/browsergator.md` | managed markdown block |
| Windsurf | `~/.windsurf/rules/browsergator.md` | managed markdown block |

Instruction-file clients get a block delimited by `BEGIN/END BROWSERGATOR` markers, so
re-running replaces only that block and never touches your own content. Skill clients get
their own directories only; sibling skills are left alone.

This copies **no secrets** -- only versioned guidance. After installing, ensure the gateway
and Chrome are running, then in any agent say `/bg` (or "use the shared browser") and it will
know to `list_tabs` first and drive tabs by explicit `pageId`. Per-client MCP registration
(the endpoint + bearer token) is still done per client -- see the client compatibility guide.

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
