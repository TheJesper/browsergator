# Requirements -- Always-on shared agent browser

## Introduction

Browsergator is a long-lived, client-neutral MCP gateway that lets many agents share
one dedicated browser over CDP. This spec formalizes the operational layer that makes
that promise real on a developer workstation: a single shared Chrome and a single gateway
that both start at logon, survive individual agents connecting and disconnecting, need no
manual profile setup, and produce no console-window flicker or log spam.

The mental model this must satisfy:

> One always-on Chrome that dozens of agents work against -- same tabs or different tabs --
> and it keeps running regardless of agents starting or stopping. Agents are ephemeral
> clients; the browser and the gateway are the durable, shared parts.

### What already exists (built, verified)

- Portable Node launcher (`scripts/run-gateway.mjs`) and `.env` loading (see the
  `cross-platform-launcher` spec).
- Gateway holds tab state (explicit `pageId`), per-tab FIFO mutation queues, leases and
  protected-tab policy, a portable singleton lock, and reconnects to Chrome automatically.
- The gateway connects to Chrome over CDP and NEVER launches or stops a browser itself
  (AGENTS.md rule 1; spec non-goal "no auto-launching of Chrome").

### The gap this spec closes

1. Nothing keeps a shared Chrome alive; the operator had to start it by hand, and the gateway
   logged `CDP driver error: fetch failed` every ~10s while waiting.
2. Console-window flicker at logon when a scheduled task runs a console binary (`node.exe`).
3. No documented, reproducible "install the shared setup" story per OS.
4. Chrome 136+ (2025-03) refuses `--remote-debugging-port` on the default profile, so a
   dedicated, isolated profile is mandatory -- and it must be created without manual steps.

### Non-goals

- No change to gateway tool behaviour, the security model, or the CDP driver's protocol logic.
- The gateway still MUST NOT launch or kill a browser. Chrome lifecycle is owned by a
  SEPARATE launcher/service, keeping AGENTS.md rule 1 intact.
- Not attaching to the user's normal/default Chrome profile (Chrome 136+ forbids it and it
  would mix private browsing with agent automation).

---

## Requirement 1 -- One shared, long-lived Chrome

**User story:** As an operator, I want a single dedicated Chrome that all agents share,
running continuously, so agents can work on the same or different tabs without me managing it.

#### Acceptance criteria
1. WHEN the workstation session is active THEN exactly one dedicated Chrome SHALL listen for
   CDP on a loopback debug port (default `127.0.0.1:9222`).
2. WHEN an agent connects, does work, and disconnects THEN the Chrome instance and its tabs
   SHALL remain running and unchanged (agents are ephemeral; the browser is durable).
3. WHEN a second launch is attempted while Chrome is already listening on the debug port THEN
   the launcher SHALL detect the live port and NOT start a second Chrome (idempotent).
4. WHERE the debug port is exposed THEN it SHALL be bound to loopback only.

## Requirement 2 -- Zero manual profile setup, persistent session

**User story:** As an operator, I don't want to create a Chrome profile by hand, and I want
logins/sessions to persist across restarts so agents work against an authenticated browser.

#### Acceptance criteria
1. WHEN Chrome is launched for the first time THEN the launcher SHALL create the dedicated
   profile directory automatically (no manual "create profile" step).
2. WHERE the profile path is chosen THEN it SHALL be derived at runtime from the current
   user's home directory (e.g. `<home>/.cache/browsergator/chrome-profile`), NOT hardcoded to
   any username, so the same script works on any machine.
3. WHEN Chrome restarts THEN the profile SHALL persist cookies, logins, and local/session data
   from the previous run (the profile is NOT wiped on start).
4. WHERE the profile is stored THEN it SHALL live OUTSIDE any git repository so it is never
   committed, cloned, or forked (it may contain cookies/session tokens).
5. WHEN an operator needs an authenticated service THEN they SHALL be able to log in once in
   the visible shared Chrome and have it persist -- no per-agent login.

## Requirement 3 -- Both gateway and Chrome auto-start at logon

**User story:** As an operator, I want the shared browser and the gateway to come up on their
own at login so I never start them manually.

#### Acceptance criteria
1. WHEN the user logs on THEN both the gateway (`:8788`) and the dedicated Chrome (`:9222`)
   SHALL start automatically.
2. IF the gateway process exits unexpectedly THEN it SHALL be restarted automatically.
3. WHEN both are up THEN the gateway status SHALL report `browserConnected: true`.
4. WHERE only one gateway may own the port THEN the singleton lock SHALL prevent a second
   gateway instance.

## Requirement 4 -- No console-window flicker

**User story:** As a Windows user, I never want a terminal/console window to flash on screen
when these background services start.

#### Acceptance criteria
1. WHEN the auto-start runs at logon on Windows THEN NO console window SHALL become visible for
   the gateway or the Chrome launcher (no `node.exe`/`wscript.exe` window).
2. WHERE Chrome itself is a visible application window THEN that is acceptable and expected;
   the requirement covers the launcher/service plumbing, not the browser UI.
3. WHEN the equivalent service runs on macOS/Linux THEN it SHALL run in the background with no
   attached terminal (launchd/systemd handle this natively).

## Requirement 5 -- Quiet, meaningful logs while waiting for Chrome

**User story:** As an operator watching the gateway log, I don't want it spammed every few
seconds when Chrome is not yet up.

#### Acceptance criteria
1. WHEN the gateway cannot reach Chrome THEN it SHALL log a single human-readable notice
   (level `info`) that it is waiting, with a hint on how to start Chrome -- NOT one line per
   retry.
2. WHILE reconnecting on a backoff THEN per-attempt failures SHALL be logged at `debug` only
   (hidden by default).
3. WHEN the gateway connects to Chrome THEN it SHALL log a single `info` line confirming the
   connection (browser version, page count).
4. WHERE a genuinely unexpected (non-"browser absent") error occurs THEN it SHALL still be
   surfaced at `warn`.
5. WHERE deeper diagnostics are needed THEN setting `BROWSER_GATEWAY_LOG_LEVEL=debug` (or
   `BROWSER_GATEWAY_DEBUG=1`) SHALL re-enable the per-attempt detail.

## Requirement 6 -- Reproducible per-OS install, no secrets in the repo

**User story:** As a maintainer, I want a documented, repeatable way to install this shared
setup on each OS, and I must never leak secrets into the public repo.

#### Acceptance criteria
1. WHEN a user follows the docs THEN Windows (Task Scheduler), macOS (launchd), and Linux
   (systemd --user) recipes SHALL each start gateway + Chrome at logon.
2. WHERE the token or profile is referenced THEN neither SHALL be committed; `.env` and the
   profile directory remain outside version control.
3. WHEN the repo is cloned/forked THEN it SHALL contain only placeholders and test fixtures --
   no real tokens, cookies, or profile data.

---

## Out of scope / notes for the implementer

- Auto-launching Chrome FROM the gateway is explicitly rejected (would break AGENTS.md rule 1).
  Chrome is owned by a separate launcher + OS service.
- The singleton lock currently lives at a module-relative `../.data/gateway.lock` rather than
  under `config.dataDir` (carried over from the launcher spec's open question). Not required
  here, but note it if unifying data locations.
