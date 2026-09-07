# Browsergator client compatibility and configuration

All clients connect to the same gateway process at `http://127.0.0.1:8788/mcp`. Set `BROWSER_GATEWAY_TOKEN` in the environment that starts both the gateway and each client. Do not place the token in a committed file.

## Transport matrix

| Client | Streamable HTTP | Recommended path | Verified basis |
|---|---:|---|---|
| Codex CLI / Codex desktop / IDE | Yes | Direct HTTP | Codex CLI 0.150.1 end-to-end call and OpenAI Docs |
| Claude Code and subagents | Yes | Direct HTTP | Claude Code 2.1.198 help and Anthropic docs |
| Gemini CLI | Yes | Direct HTTP | Gemini CLI 0.57.0 end-to-end call and Google Gemini CLI docs |
| GitHub Copilot CLI | Advertised, but unreliable in the installed client | Stateless stdio adapter | Copilot CLI 1.0.80 end-to-end call through the adapter; direct HTTP did not expose tools |
| Local Forge/TeamRoom agents | Yes through Claude Code | Claude user-scope HTTP config | Local TeamRoom spawner starts Claude Code and copies `~/.claude.json` into isolated agent homes |
| Any MCP client with Streamable HTTP | Yes | Direct HTTP | Standard endpoint plus bearer header |
| Stdio-only MCP clients | Via adapter | `dist/stdio-adapter.js` | Automated end-to-end adapter test |

The stdio adapter is only a transport bridge. It opens one upstream MCP client session to the shared gateway, forwards `tools/list` and `tools/call`, keeps no browser coordination state, imports no CDP driver, and never starts or owns Chrome.

## Shared prerequisite

Set the token in the parent environment before starting clients, or place it in a project-root `.env` file (see `.env.example`).

```bash
# bash / zsh
export BROWSER_GATEWAY_TOKEN='<same-long-token-used-by-the-gateway>'
```

```powershell
# PowerShell
$env:BROWSER_GATEWAY_TOKEN = '<same-long-token-used-by-the-gateway>'
```

The token is connection authentication only. It is not an agent identity.

## Codex CLI, desktop app, and IDE extension

Preferred CLI setup:

```powershell
codex mcp add browser-gateway `
  --url http://127.0.0.1:8788/mcp `
  --bearer-token-env-var BROWSER_GATEWAY_TOKEN
codex mcp list
```

Equivalent `~/.codex/config.toml`:

```toml
[mcp_servers.browser-gateway]
url = "http://127.0.0.1:8788/mcp"
bearer_token_env_var = "BROWSER_GATEWAY_TOKEN"
required = true
```

Codex desktop, CLI, and IDE share this host configuration. In the desktop or IDE UI, choose **Streamable HTTP**, enter the URL above, and configure bearer authentication from `BROWSER_GATEWAY_TOKEN`.

## Claude Code and Claude subagents

Use user scope so TeamRoom's isolated Claude homes inherit the entry when they copy `~/.claude.json`. `add-json` avoids the CLI's variadic `--header` parsing and preserves the `${...}` expression for Claude Code to expand at load time:

```powershell
$config = @{
  type = 'http'
  url = 'http://127.0.0.1:8788/mcp'
  headers = @{ Authorization = 'Bearer ${BROWSER_GATEWAY_TOKEN}' }
} | ConvertTo-Json -Compress
claude mcp add-json --scope user browser-gateway $config
claude mcp list
```

Equivalent project `.mcp.json` when user scope is not wanted:

```json
{
  "mcpServers": {
    "browser-gateway": {
      "type": "http",
      "url": "http://127.0.0.1:8788/mcp",
      "headers": {
        "Authorization": "Bearer ${BROWSER_GATEWAY_TOKEN}"
      }
    }
  }
}
```

Claude Code may host several subagents behind one MCP client connection. Each subagent must still send its own `agentId`, `taskId`, and `leaseOwnerId` in tool calls.

### Avoid Claude's separate Chrome DevTools plugin

Claude's optional `chrome-devtools-mcp@claude-plugins-official` plugin is a different MCP server. It can start its own browser integration and create per-session Chrome tab groups; Browsergator does not create tab groups. When Browsergator is the intended browser service, disable that plugin in `C:\\Users\\<user>\\.claude\\settings.json` and leave only `browser-gateway` as the browser MCP entry. Restart Claude Code after changing the setting.

## Gemini CLI

Preferred user-scope setup. As with Claude, the single quotes preserve environment expansion for Gemini's settings loader:

```powershell
gemini mcp add --transport http --scope user `
  --header 'Authorization: Bearer ${BROWSER_GATEWAY_TOKEN}' `
  browser-gateway http://127.0.0.1:8788/mcp
gemini mcp list
```

Equivalent `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "browser-gateway": {
      "url": "http://127.0.0.1:8788/mcp",
      "headers": {
        "Authorization": "Bearer ${BROWSER_GATEWAY_TOKEN}"
      },
      "timeout": 60000
    }
  }
}
```

The installed CLI writes `url` for an HTTP transport and accepts `--transport http`. On this host Gemini uses `security.auth.selectedType = "gemini-api-key"`, because the older personal Code Assist OAuth client is no longer eligible; the existing user-level `GEMINI_API_KEY` supplies model authentication. This is separate from the gateway bearer token.

## GitHub Copilot CLI

Copilot CLI documents remote HTTP MCP servers, but version 1.0.80 did not expose the gateway tools to an actual agent run when configured directly. The installed global configuration therefore uses the tested stateless adapter:

```powershell
copilot mcp add `
  --env BROWSER_GATEWAY_URL=http://127.0.0.1:8788/mcp `
  --env BROWSER_GATEWAY_TOKEN='<injected-secret>' `
  --tools '*' --timeout 60000 `
  browser-gateway -- `
  node `
  '<repo-root>/dist/stdio-adapter.js'
copilot mcp get browser-gateway
```

The entry is stored in `~/.copilot/mcp-config.json`. Do not commit or print that file because Copilot's JSON inspection mode can reveal environment values even when the normal display masks them. The adapter never connects to CDP and never launches Chrome.

## Forge and TeamRoom in this environment

The inspected TeamRoom implementation launches Claude Code processes. In sandbox mode it copies the user's `.claude.json` and credentials into the sandbox and inherits the parent environment. Therefore the Claude **user-scope** command above is the canonical setup for both ordinary Claude Code and TeamRoom/Forge sessions that use that spawner. No gateway or Chrome process is started per agent.

If a Forge runner is changed to a client that only accepts stdio, use the adapter configuration below instead. No standalone `forge` executable or separate Forge MCP configuration format was present on this host, so no unverified Forge-specific HTTP syntax is claimed.

## Stdio-only clients

Build once:

```text
cd <repo-root>
npm run build
```

Use this standard MCP server entry in the client's stdio configuration. `command` is `node` (resolved from PATH) with a forward-slash path that works on every OS:

```json
{
  "mcpServers": {
    "browser-gateway": {
      "command": "node",
      "args": ["<repo-root>/dist/stdio-adapter.js"],
      "env": {
        "BROWSER_GATEWAY_URL": "http://127.0.0.1:8788/mcp",
        "BROWSER_GATEWAY_TOKEN": "${BROWSER_GATEWAY_TOKEN}"
      }
    }
  }
}
```

If the client does not expand environment references inside `env`, inject the token through its secret/environment facility rather than committing it. Starting ten adapters is safe: they are stateless transport shims, while all leases, queues, events, browser sessions, contexts, and CDP state remain in the one HTTP gateway.

## Required logical identity on tool calls

For every coordinated or audited operation, the caller supplies:

- `agentId`: stable logical agent or subagent name.
- `taskId`: the concrete unit of work.
- `leaseOwnerId`: unique ownership key for the current task attempt, stable across MCP reconnects.
- `correlationId`: optional workflow/trace correlation.
- `idempotencyKey`: unique retry key where supported or required.

Suggested convention: `agentId=claude:<project>:<agent>`, `taskId=<orchestrator-task-or-uuid>`, and `leaseOwnerId=<taskId>:<attempt-uuid>`. Never derive these solely from the MCP client session ID.

## Connection checks

Health and readiness endpoints (POSIX `curl` and PowerShell `Invoke-RestMethod`):

```bash
# bash / zsh
curl http://127.0.0.1:8788/healthz
curl http://127.0.0.1:8788/readyz
```

```powershell
# PowerShell
Invoke-RestMethod http://127.0.0.1:8788/healthz
Invoke-RestMethod http://127.0.0.1:8788/readyz
```

Per-client listings:

```text
codex mcp list
claude mcp list
gemini mcp list
copilot mcp get browser-gateway
```

Only one gateway service should listen on port 8788. Client and adapter process counts may be greater than one.

## Persistent service (per OS)

The gateway runs in the foreground under `npm run serve` (or `node scripts/run-gateway.mjs`). For a long-lived service, use the native supervisor for your OS. All three point at the same portable launcher and read the token from the environment or a `.env` file.

For the full "always-on shared browser", register TWO services on each OS -- one for the dedicated Chrome (`scripts/launch-chrome.mjs`) and one for the gateway (`scripts/run-gateway.mjs`). The Chrome launcher is idempotent and creates its isolated profile automatically under `<home>/.cache/browsergator/chrome-profile`.

### Windows -- Task Scheduler (windowless)

Run both launchers at logon. To avoid a console window flashing (Task Scheduler runs `node.exe`, a console app), route through `wscript.exe` + `scripts/hidden-launch.vbs`, which starts `node <launcher>` with a hidden window. Set the tasks `-Hidden` as well.

```powershell
$wscript   = "$env:SystemRoot\System32\wscript.exe"
$vbs       = "<repo>\scripts\hidden-launch.vbs"
$trigger   = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

# Dedicated Chrome
Register-ScheduledTask -TaskName 'BrowsergatorChrome' -Force `
  -Action (New-ScheduledTaskAction -Execute $wscript -Argument "`"$vbs`" `"<repo>\scripts\launch-chrome.mjs`"" -WorkingDirectory '<repo>') `
  -Trigger $trigger -Principal $principal `
  -Settings (New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -Hidden -ExecutionTimeLimit (New-TimeSpan -Minutes 2))

# Gateway (restart on failure)
Register-ScheduledTask -TaskName 'BrowsergatorGateway' -Force `
  -Action (New-ScheduledTaskAction -Execute $wscript -Argument "`"$vbs`" `"<repo>\scripts\run-gateway.mjs`"" -WorkingDirectory '<repo>') `
  -Trigger $trigger -Principal $principal `
  -Settings (New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -Hidden -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero))
```

Both tasks ignore duplicate starts; the gateway's singleton lock prevents a second live instance.

### macOS -- launchd (user agent)

Create `~/Library/LaunchAgents/com.browsergator.gateway.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key><string>com.browsergator.gateway</string>
    <key>ProgramArguments</key>
    <array>
      <string>/usr/bin/env</string>
      <string>node</string>
      <string><repo-root>/scripts/run-gateway.mjs</string>
    </array>
    <key>WorkingDirectory</key><string><repo-root></string>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>StandardOutPath</key><string><repo-root>/.data/service.stdout.log</string>
    <key>StandardErrorPath</key><string><repo-root>/.data/service.stderr.log</string>
  </dict>
</plist>
```

Load and start it:

```bash
launchctl load ~/Library/LaunchAgents/com.browsergator.gateway.plist
launchctl start com.browsergator.gateway
```

The token comes from a project-root `.env` file (loaded by the gateway). launchd does not read your login shell profile, so do not rely on an exported shell variable here.

For the shared browser, add a second agent `com.browsergator.chrome` with `ProgramArguments = [/usr/bin/env, node, <repo>/scripts/launch-chrome.mjs]`, `RunAtLoad`, `KeepAlive`. It creates its isolated profile under `~/.cache/browsergator/chrome-profile` on first run.

### Linux -- systemd (user service)

Create `~/.config/systemd/user/browsergator.service`:

```ini
[Unit]
Description=Browsergator MCP gateway
After=network.target

[Service]
Type=simple
WorkingDirectory=<repo-root>
EnvironmentFile=<repo-root>/.env
ExecStart=/usr/bin/node <repo-root>/scripts/run-gateway.mjs
Restart=on-failure

[Install]
WantedBy=default.target
```

Enable and start it:

```bash
systemctl --user daemon-reload
systemctl --user enable --now browsergator.service
systemctl --user status browsergator.service
```

Adjust the `node` path to match your install (e.g. an nvm/fnm shim). The gateway's singleton lock still guarantees one live instance.

For the shared browser, add a second unit `browsergator-chrome.service` with
`ExecStart=/usr/bin/node <repo>/scripts/launch-chrome.mjs` and `Restart=on-failure`. It creates
its isolated profile under `~/.cache/browsergator/chrome-profile` on first run and is idempotent.


## Verification record

The four installed clients were each verified with a real read-only `list_tabs` tool call on 2026-08-28. Codex, Claude, and Gemini used direct Streamable HTTP; Copilot used the stateless adapter.
