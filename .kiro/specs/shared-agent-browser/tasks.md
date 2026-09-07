# Tasks -- Always-on shared agent browser

Implementation plan. Each task is self-contained and references the requirements it satisfies.
Do NOT change gateway tool behaviour, the CDP protocol logic, or the security model -- this is
the operational layer (Chrome launcher + logging + OS services + docs). The gateway must never
launch or kill a browser (constitution principle 4, AGENTS.md rule 1).

Status legend: [x] done and verified, [ ] not started.

---

- [x] 1. Portable dedicated-Chrome launcher
  - `scripts/launch-chrome.mjs`: idempotent (skip if debug port already answers), isolated
    profile under `<home>/.cache/browsergator/chrome-profile` (auto-created, never wiped),
    loopback debug port 9222, detached + `windowsHide`, per-OS Chrome/Chromium/Edge resolution,
    env overrides (`BROWSERGATOR_CHROME_BIN/PORT/PROFILE`). Poll the port to confirm startup.
  - _Requirements: 1.1, 1.3, 1.4, 2.1, 2.2, 2.3, 2.4_

- [x] 2. Quiet logging
  - `src/core/logger.ts`: add `debug` level + gate via `BROWSER_GATEWAY_LOG_LEVEL`
    (fallback `BROWSER_GATEWAY_DEBUG=1`); default `info`.
  - `src/cdp/websocket-cdp-driver.ts`: `isBrowserAbsentError` classifier; one-shot `info`
    "waiting for agent Chrome" on first outage, `debug` per retry, single `info`
    "Connected to agent Chrome" on success, `warn` for genuinely unexpected errors.
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_

- [x] 3. npm script + eslint globals
  - `package.json`: add `"chrome": "node scripts/launch-chrome.mjs"`.
  - `eslint.config.js`: extend the `scripts/**/*.mjs` globals (fetch, URL, AbortController,
    timers) so the launchers lint clean.
  - _Requirements: 1.1_

- [x] 4. Windowless Windows wrapper + services
  - `scripts/hidden-launch.vbs`: run `node <launcher>` via `wscript` with a hidden window.
  - Register two Scheduled Tasks (`BrowsergatorChrome`, `BrowsergatorGateway`) AtLogOn, Hidden,
    through the VBS wrapper; gateway restarts on failure; both `MultipleInstances IgnoreNew`.
  - _Requirements: 3.1, 3.2, 3.4, 4.1, 4.2_

- [x] 5. Logger unit tests
  - `test/logger.test.ts`: debug suppressed at default level; info/warn emitted; redaction
    still applies to emitted entries.
  - _Requirements: 5.1, 5.2_

- [x] 6. Live verification
  - Chrome up on :9222 (profile auto-created under `~/.cache/browsergator`, right user, outside
    repo). Gateway :8788 healthz 200, `browserConnected: true`, MCP `tools/list` full, no
    node/wscript console window. Quiet-log behaviour confirmed against a no-Chrome run.
  - _Requirements: 1.1, 2.1, 3.1, 3.3, 4.1, 5.1, 5.3_

- [x] 7. Per-OS install docs
  - README: add a "Shared agent browser" section -- `npm run chrome` + `npm run serve`, note
    logins persist in the dedicated profile, one-time login story, `BROWSER_GATEWAY_LOG_LEVEL`.
  - CLIENT-COMPATIBILITY: extend the persistent-service section with the TWO-service setup
    (Chrome + gateway) for Windows Task Scheduler (windowless via VBS), macOS launchd, and
    Linux systemd --user. Keep the profile path derived from `$HOME`/`%USERPROFILE%`.
  - _Requirements: 6.1, 6.2, 6.3_

- [x] 8. Secret-safety audit before publish
  - Confirm `.env` and the Chrome profile are gitignored and untracked; scan the staged diff
    for tokens/cookies/usernames; ensure only placeholders + fixtures ship.
  - _Requirements: 6.2, 6.3_

- [ ] 9. Optional: cross-platform service installer script
  - A small `scripts/install-service.mjs` (or per-OS snippets) that registers both services on
    the current OS, so install is one command. Nice-to-have; docs cover the manual path.
  - _Requirements: 3.1, 6.1_

---

## Definition of done

- One dedicated Chrome and one gateway start at logon, windowless, and stay up across agent
  churn; `browserConnected: true`.
- The Chrome profile is auto-created, persistent, isolated, and outside the repo -- no manual
  profile step, logins persist.
- Logs are quiet: one waiting notice, one connected notice, detail only at debug.
- Any agent can add/remove/read/drive tabs; coordination handles collisions.
- Per-OS install documented; no secrets in the repo.
- No gateway tool/protocol/security change.

## Progress note

Tasks 1-6 are implemented and verified live on this Windows workstation (nvm4w). Tasks 7-9
(docs + optional installer) remain. The already-shipped `cross-platform-launcher` spec covers
the portable launcher and `.env` groundwork this spec builds on.
