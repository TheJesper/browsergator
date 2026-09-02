# Requirements -- Cross-platform gateway launcher

## Introduction

Browsergator's runtime (`src/`) is already cross-platform: it uses `node:path`
everywhere, never shells out (`child_process`/`spawn`/`exec` appear nowhere), connects
to Chrome purely over HTTP+WebSocket (never launches a browser binary), and uses a
portable singleton lock (`open(path,'wx')` + `process.kill(pid,0)` liveness). The
platform lock-in lives entirely in ONE launcher script and in documentation.

This feature makes starting and documenting the gateway work identically on Windows,
macOS, and Linux -- without changing gateway behaviour.

### Problems being solved (evidence from the audit)

1. `scripts/run-gateway.ps1` hardcodes `C:\Program Files\nodejs\node.exe` and `Test-Path`s
   it -- this breaks on macOS/Linux AND on Windows installs via nvm/fnm/winget/Scoop
   (e.g. nvm4w at `C:\nvm4w\nodejs\node.exe`). It is PowerShell-only and reads a
   Windows **User-scope** registry env var that has no macOS/Linux equivalent.
2. No `.env` support -- env must be exported by the parent shell, with a different
   mechanism per OS and no single documented way.
3. Docs (`README.md`, `docs/CLIENT-COMPATIBILITY.md`) hardcode the Windows node path,
   backslash args, PowerShell-only snippets, and a Task-Scheduler-only deployment story.

### Non-goals

- No change to gateway logic, tools, security model, or the CDP driver.
- No auto-launching of Chrome (the gateway must keep connecting to an existing debug port).
- Not removing PowerShell support on Windows -- Windows users may still prefer it.

---

## Requirement 1 -- Portable launcher

**User story:** As a developer on any OS, I want to start the gateway with one command
that finds Node automatically, so I never edit a hardcoded interpreter path.

#### Acceptance criteria
1. WHEN a developer runs the documented start command on Windows, macOS, or Linux THEN the
   gateway SHALL start using the Node runtime resolved from `PATH` (or the current Node's
   `process.execPath`), never a hardcoded absolute path.
2. WHEN Node is installed via nvm, fnm, winget, Scoop, Homebrew, or a system package THEN the
   launcher SHALL still find it (no dependency on `C:\Program Files\nodejs`).
3. WHEN the launcher starts the gateway THEN it SHALL pass arguments as an argv array (no
   shell string interpolation, no `shell: true`).
4. IF the compiled entrypoint (`dist/index.js`) is missing THEN the launcher SHALL fail with a
   clear message telling the user to run the build first, and exit non-zero.
5. WHEN the launcher runs THEN it SHALL ensure the data directory exists before starting.

## Requirement 2 -- Portable configuration (.env support)

**User story:** As a developer, I want one documented way to provide config/secrets that
works on every OS, so I don't rely on Windows User-scope env vars.

#### Acceptance criteria
1. WHEN a `.env` file exists in the project root THEN the gateway SHALL load it into
   `process.env` before `loadConfig()` runs.
2. IF no `.env` file exists THEN the gateway SHALL start normally using the ambient
   `process.env` (dotenv import MUST be optional and non-fatal when absent).
3. WHEN both a real env var and a `.env` entry exist for the same key THEN the pre-existing
   process env var SHALL win (dotenv MUST NOT override already-set vars).
4. WHEN `.env` is present THEN it SHALL remain gitignored (never committed).
5. WHERE the token is required, the system SHALL read `BROWSER_GATEWAY_TOKEN` from
   `process.env` (populated by shell export, `.env`, or a secrets manager) and SHALL NOT
   read any Windows User-scope registry variable.

## Requirement 3 -- Cross-platform npm scripts

**User story:** As a developer, I want npm scripts that run the same on every OS.

#### Acceptance criteria
1. WHEN a developer runs the start script THEN it SHALL invoke the portable launcher and
   behave identically on all three OSes.
2. WHERE a script sets env inline, it SHALL use a cross-platform mechanism (no `set VAR=` /
   `$env:` / `export` baked into the script string); env belongs in `.env` or the shell.
3. WHEN existing scripts (`build`, `test`, `lint`, `typecheck`, `dev`) are run THEN they
   SHALL continue to work unchanged (they are already portable).

## Requirement 4 -- Per-OS documentation

**User story:** As a new user on macOS/Linux/Windows, I want copy-pasteable setup that
works on my OS.

#### Acceptance criteria
1. WHEN a user reads the README setup THEN token generation SHALL be shown for PowerShell,
   bash/zsh, AND a portable Node one-liner.
2. WHEN a user reads client-config examples THEN `command` SHALL be `"node"` (PATH-resolved)
   with forward-slash or placeholder paths, not a hardcoded `node.exe`.
3. WHERE a health check is shown THEN both `curl` (POSIX) and `Invoke-RestMethod` (PowerShell)
   variants SHALL be provided.
4. WHEN a user wants a persistent service THEN the docs SHALL provide macOS `launchd` and
   Linux `systemd --user` recipes alongside the existing Windows Task Scheduler one.

## Requirement 5 -- CI coverage

**User story:** As a maintainer, I want CI to catch platform regressions.

#### Acceptance criteria
1. WHEN CI runs THEN it SHALL execute build + typecheck + unit tests on `ubuntu-latest`,
   `windows-latest`, and `macos-latest`.
2. IF any OS in the matrix fails build/typecheck/tests THEN the CI run SHALL fail.

## Requirement 6 -- Backward compatibility on Windows

**User story:** As an existing Windows user, I don't want my current setup to break.

#### Acceptance criteria
1. WHEN the PowerShell launcher is kept THEN it SHALL resolve Node from `PATH` instead of the
   hardcoded path (or delegate to the portable Node launcher), so it works on nvm4w.
2. WHEN a user upgrades THEN the existing MCP `stdio-adapter` wiring SHALL keep working with
   no change to `dist/stdio-adapter.js` behaviour.

---

## Out of scope / open questions (for the implementer)

- **Lock vs dataDir inconsistency (note, not a requirement):** `index.ts` builds the
  singleton lock path via `fileURLToPath(new URL('../.data/gateway.lock', import.meta.url))`
  -- relative to the compiled module, NOT `config.dataDir`. A custom
  `BROWSER_GATEWAY_DATA_DIR` therefore splits the audit log and the lock into different
  directories. Decide whether to unify the lock under `config.dataDir`. If changed, keep it
  backward compatible for existing installs.
- Whether to add `dotenv` as a real dependency vs a dynamic optional import (design covers both).
