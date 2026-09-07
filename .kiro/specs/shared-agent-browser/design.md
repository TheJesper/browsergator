# Design -- Always-on shared agent browser

## Overview

Three durable pieces on the workstation, plus ephemeral agents:

```
                      logon
                        |
        +---------------+----------------+
        v                                v
  BrowsergatorChrome              BrowsergatorGateway
  (OS service)                    (OS service)
        |                                |
  launch-chrome.mjs                run-gateway.mjs
        |                                |
  dedicated Chrome  <--- CDP :9222 --- gateway :8788  <--- MCP --- agents (come/go)
  (isolated profile,                   (tab state, FIFO,
   persistent, loopback)                leases, singleton lock)
```

- **Chrome** and **gateway** are long-lived, started by OS services at logon, kept alive.
- **Agents** connect over MCP, do work, disconnect. Browser + gateway state survive them.
- The gateway NEVER launches/kills Chrome. Chrome lifecycle is owned by its own launcher +
  service. This keeps AGENTS.md rule 1 intact while still giving "one always-on browser".

No gateway tool/protocol/security change. The work is: a Chrome launcher, quiet logging,
windowless OS-service wiring, and per-OS install docs.

## Design decisions

### D1. Chrome is owned by a separate launcher, not the gateway
- **Decision:** `scripts/launch-chrome.mjs` (portable Node) starts the dedicated Chrome; the
  gateway only ever connects.
- **Why:** AGENTS.md rule 1 and the product non-goal forbid the gateway from touching a
  browser. Separation keeps the security rule true and lets Chrome and gateway restart
  independently.

### D2. Dedicated, auto-created, persistent, isolated profile
- **Decision:** launch Chrome with `--user-data-dir=<home>/.cache/browsergator/chrome-profile`.
  The launcher `mkdir -p`s it; Chrome initializes an empty profile on first run. Never wiped.
- **Why zero manual setup:** an empty dir + `--user-data-dir` makes Chrome create the profile
  itself -- no "create profile" dialog, no manual step (Requirement 2.1).
- **Why derived from home, not hardcoded:** same script on every machine/user (2.2).
- **Why outside the repo:** the profile holds cookies/sessions; keeping it under `~/.cache`
  guarantees it is never committed/cloned (2.4, 6.2).
- **Why persistent:** agents need to work against a logged-in browser; the operator logs in
  once in the visible shared Chrome and it sticks (2.3, 2.5). So NO `--incognito`, NO
  session-state wiping.
- **Chrome 136+ (2025-03):** `--remote-debugging-port` is ignored on the default profile; an
  isolated `--user-data-dir` is mandatory. This decision is therefore also a correctness
  requirement, not just hygiene.

### D3. Idempotent, loopback-only launch
- **Decision:** before launching, GET `http://127.0.0.1:9222/json/version`; if it answers,
  exit without starting a second Chrome. Launch flags include
  `--remote-debugging-address=127.0.0.1` and `about:blank`.
- **Why:** many triggers (logon task, manual `npm run chrome`, restart) must not spawn
  duplicate Chromes (1.3). Loopback binding keeps the control port private (1.4).

### D4. Windowless OS-service wiring (Windows)
- **Problem:** Task Scheduler running `node.exe` (a console app) can flash a black window at
  logon even with the task Hidden flag.
- **Decision:** route the task through `wscript.exe` + `scripts/hidden-launch.vbs`, which runs
  `node <launcher>` with a truly hidden window (`shell.Run cmd, 0, False`). Set the task
  `-Hidden` as well.
- **Why VBS:** it is the reliable, dependency-free Windows way to get a windowless console
  process. `wscript` ships with Windows.
- **macOS/Linux:** launchd/systemd run background processes with no terminal natively; no
  wrapper needed there.

### D5. Quiet logging with a level gate
- **Decision:** add a `debug` level to `logger.ts`, gated by `BROWSER_GATEWAY_LOG_LEVEL`
  (default `info`; `BROWSER_GATEWAY_DEBUG=1` also enables debug). In the CDP driver, classify
  errors: "browser absent" (ECONNREFUSED/fetch failed/abort/etc.) logs a single `info`
  "waiting for agent Chrome" notice on first outage and `debug` for every subsequent retry;
  it logs a single `info` "Connected to agent Chrome" on success; genuinely unexpected errors
  stay `warn`.
- **Why:** removes the every-10s `CDP driver error: fetch failed` spam while keeping the one
  actionable message and full detail on demand (Requirement 5).

### D6. Two OS services, per platform
- Windows: two Scheduled Tasks -- `BrowsergatorChrome`, `BrowsergatorGateway` -- AtLogOn,
  Hidden, via the VBS wrapper; gateway task restarts on failure.
- macOS: two launchd user agents (`com.browsergator.chrome`, `com.browsergator.gateway`),
  `RunAtLoad`, `KeepAlive`.
- Linux: two systemd --user units, `Restart=on-failure`, `WantedBy=default.target`.

## Component / file changes

| File | Change | Requirement |
|------|--------|-------------|
| `scripts/launch-chrome.mjs` | NEW -- portable dedicated-Chrome launcher (idempotent, isolated profile) | R1, R2, R3 |
| `scripts/hidden-launch.vbs` | NEW (Windows) -- windowless wrapper for a node launcher | R4 |
| `src/core/logger.ts` | ADD `debug` level + env-driven level gate | R5 |
| `src/cdp/websocket-cdp-driver.ts` | ADD absent-vs-real error classify; one-shot waiting/connected logs | R5 |
| `package.json` | ADD `chrome` script (`node scripts/launch-chrome.mjs`) | R1 |
| `README.md` / `docs/CLIENT-COMPATIBILITY.md` | ADD shared-browser setup + per-OS service recipes | R6 |
| Scheduled Tasks / launchd / systemd | Register gateway + chrome, windowless, at logon | R3, R4, R6 |
| `test/logger.test.ts` | NEW -- level gating + redaction still applies | R5 |

## Launcher sketch (`scripts/launch-chrome.mjs`)

Key points (full file in repo):
- `profileDir = env.BROWSERGATOR_CHROME_PROFILE ?? join(homedir(), '.cache', 'browsergator', 'chrome-profile')`
- `debugPortAlive()` -> GET `/json/version` with a short timeout; if ok, log and return.
- `resolveChrome()` -> env override, else per-OS candidate list (Chrome/Chromium/Edge).
- `spawn(chrome, [ '--remote-debugging-port=9222', '--remote-debugging-address=127.0.0.1',
  '--user-data-dir='+profileDir, '--no-first-run', '--no-default-browser-check',
  '--hide-crash-restore-bubble', 'about:blank' ], { detached: true, stdio: 'ignore',
  windowsHide: true })` then `child.unref()`.
- Poll the debug port up to ~15s to confirm it opened; report success/failure.

## Hidden wrapper sketch (`scripts/hidden-launch.vbs`)

```vbscript
' args(0) = absolute path to a .mjs launcher; args(1..) pass through to node.
Set shell = CreateObject("WScript.Shell")
cmd = """node"""
For i = 0 To WScript.Arguments.Count - 1 : cmd = cmd & " """ & WScript.Arguments(i) & """" : Next
shell.Run cmd, 0, False   ' 0 = hidden window, False = don't wait
```
Task action: `wscript.exe "<repo>\scripts\hidden-launch.vbs" "<repo>\scripts\run-gateway.mjs"`.

## Logger sketch (`src/core/logger.ts`)

```ts
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const ORDER = { debug:10, info:20, warn:30, error:40 };
const minLevel = /* BROWSER_GATEWAY_LOG_LEVEL, else BROWSER_GATEWAY_DEBUG=1 -> debug, else info */;
export function log(level, message, data?) {
  if (ORDER[level] < ORDER[minLevel]) return;
  process.stderr.write(JSON.stringify(redact({ timestamp, level, message, ...(data && { data }) })) + '\n');
}
```

## CDP driver logging (`websocket-cdp-driver.ts`)

- New `waitingLogged` flag; reset to false on successful connect.
- `isBrowserAbsentError(error)`: walks `error.cause` chain for ECONNREFUSED/ECONNRESET/
  ENOTFOUND/EHOSTUNREACH/ETIMEDOUT/ABORT_ERR, `AbortError`, or a message containing
  "fetch failed"/"connect".
- `noteBrowserUnavailable(message, error)`: first outage -> `info` once; repeats -> `debug`;
  non-absent error -> `warn` once.
- On connect: `log('info', 'Connected to agent Chrome', { browser, pages })`.

## Windows service registration (PowerShell, one-time)

```powershell
$wscript = "$env:SystemRoot\System32\wscript.exe"
$vbs = "<repo>\scripts\hidden-launch.vbs"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
# Chrome
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

## macOS launchd / Linux systemd

- launchd: two plists in `~/Library/LaunchAgents`, `ProgramArguments = [node, <launcher>]`,
  `RunAtLoad`, `KeepAlive`. Token via `.env` (launchd ignores login shell profile).
- systemd --user: two units, `ExecStart=/usr/bin/node <launcher>`, `EnvironmentFile=<repo>/.env`,
  `Restart=on-failure`, `WantedBy=default.target`.

## Alternatives considered

- **Gateway auto-launches Chrome:** rejected -- breaks AGENTS.md rule 1; couples two lifecycles;
  platform-specific spawn logic inside the gateway. Separate launcher is cleaner and safe.
- **Attach to the user's normal Chrome:** rejected -- Chrome 136+ blocks it on the default
  profile, and it mixes private browsing with automation.
- **Ephemeral/incognito profile per start:** rejected -- would drop logins between restarts;
  the operator wants a persistent authenticated shared browser.
- **Task Hidden flag alone (no VBS):** insufficient -- console apps can still flash; the VBS
  `wscript` wrapper is the reliable windowless path.

## Testing strategy

- **Unit:** `logger.test.ts` -- debug suppressed at default level, info/warn emitted, redaction
  still applies.
- **Launcher (manual/live):** `npm run chrome` twice -> second run detects the live port and
  does not start a second Chrome; profile dir auto-created under `~/.cache/browsergator`.
- **Quiet logging (live):** start the gateway with no Chrome and a throwaway port -> exactly one
  `info` "waiting" notice, no per-retry `warn` spam; start Chrome -> single `info` "Connected".
- **End-to-end (live):** both services up at logon -> gateway `browserConnected: true`, MCP
  `tools/list` = full toolset, `list_tabs` succeeds, no console window for node/wscript.
- **Regression:** existing vitest suites stay green (driver exercised via gateway integration).
