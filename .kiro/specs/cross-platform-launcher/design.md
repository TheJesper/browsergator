# Design -- Cross-platform gateway launcher

## Overview

The fix is small and concentrated: replace the one Windows-locked launcher with a portable
Node launcher, add optional `.env` loading, make npm scripts the single entry point, and
rewrite the two docs per-OS. No runtime/gateway logic changes.

```
Before:  user -> run-gateway.ps1 (Windows only, hardcoded node.exe, User-scope env) -> dist/index.js
After:   user -> npm run serve -> scripts/run-gateway.mjs (any OS, PATH node, .env) -> dist/index.js
         (Windows users may still use a fixed run-gateway.ps1 that resolves node from PATH)
```

The gateway keeps: singleton lock, CDP-over-WebSocket, signal handling, security gates,
and the stdio-adapter -- all already portable.

## Design decisions

### D1. Portable launcher = a Node script, not per-OS shell scripts
- **Decision:** add `scripts/run-gateway.mjs` (ESM Node). It runs on every OS Node runs on,
  reads `process.env`, ensures `.data`, and `spawn`s `dist/index.js` with an argv array.
- **Why over `.sh` + `.ps1`:** one file, no duplication, no shell-injection surface, no EOL
  concerns. Node is already a hard dependency.
- **Node resolution:** use `process.execPath` (the Node that runs the launcher) as the child
  interpreter -- guaranteed present, no PATH lookup ambiguity.
- **Detach/keep-alive:** the launcher runs the gateway in the FOREGROUND (inherit stdio) so
  the process lives as long as the terminal. Persistent/background running is a deployment
  concern handled by launchd/systemd/Task Scheduler (docs), not the launcher.

### D2. Optional dotenv, non-overriding
- **Decision:** at the very top of `src/index.ts`, dynamically import dotenv guarded by
  try/catch, with `override: false` semantics (dotenv's default -- existing env wins).
- **Why dynamic + guarded:** if `dotenv` isn't installed, the gateway must still start
  (Requirement 2.2). Matches the pattern already used in the present-deck chat backend
  (`try { await import('dotenv/config'); } catch {}`).
- **Dependency choice:** add `dotenv` to `devDependencies` (it's a dev/run convenience, not a
  library concern -- Browsergator ships `dist/` consumed via stdio, not as an imported lib
  that must pull dotenv). If the maintainer prefers zero new deps, the launcher (`run-gateway.mjs`)
  can parse `.env` with a ~15-line reader instead; see Alternatives.
- **Load site:** must run BEFORE `loadConfig()` reads `process.env`. Putting it at the top of
  `index.ts` covers both `npm run serve` and direct `node dist/index.js`.

### D3. npm scripts as the single entry point
- Add `"serve": "node scripts/run-gateway.mjs"` and `"serve:dev": "tsx scripts/run-gateway.mjs"`
  (dev variant runs `src/index.ts` via tsx -- see launcher `ENTRY` switch).
- Keep all existing scripts unchanged (already portable).

### D4. Keep PowerShell launcher but de-hardcode it
- Rewrite `scripts/run-gateway.ps1` so it does NOT hardcode the node path. Simplest: replace
  its body with a delegation to the Node launcher: `node "$PSScriptRoot/run-gateway.mjs"`.
  This preserves the muscle-memory command for Windows users AND fixes the nvm4w breakage.
- Alternatively resolve node via `Get-Command node`. Delegation is preferred (single source
  of truth in the .mjs).

### D5. Docs get per-OS tabs
- README + CLIENT-COMPATIBILITY: every PowerShell-only block gains a bash/zsh sibling; node
  path examples become `"command": "node"`; add launchd + systemd recipes.

## Component / file changes

| File | Change | Requirement |
|------|--------|-------------|
| `scripts/run-gateway.mjs` | NEW -- portable Node launcher | R1, R3 |
| `scripts/run-gateway.ps1` | REWRITE -- delegate to .mjs (no hardcoded path) | R6.1 |
| `src/index.ts` | ADD guarded dotenv import at top | R2 |
| `package.json` | ADD `serve`/`serve:dev` scripts; ADD `dotenv` devDep (if chosen) | R2, R3 |
| `.env.example` | VERIFY keys documented (already exists) | R2 |
| `.gitignore` | VERIFY `.env` ignored (already is) | R2.4 |
| `README.md` | REWRITE setup with per-OS token gen + `node` command | R4 |
| `docs/CLIENT-COMPATIBILITY.md` | REWRITE per-OS; add launchd/systemd | R4 |
| `.github/workflows/ci.yml` | ADD OS matrix (ubuntu/windows/macos) | R5 |
| `src/index.ts` (lock path) | OPTIONAL -- unify lock under config.dataDir | open question |

## Launcher sketch (`scripts/run-gateway.mjs`)

```js
#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

// dev mode runs TS via tsx; prod runs compiled dist
const dev = process.argv.includes('--dev') || process.env.BG_DEV === '1';
const entry = dev ? join(root, 'src', 'index.ts') : join(root, 'dist', 'index.js');

if (!dev && !existsSync(entry)) {
  console.error(`[run-gateway] Missing ${entry}. Build first: npm run build`);
  process.exit(1);
}

// ensure data dir (config default is <cwd>/.data; keep parity)
mkdirSync(join(root, '.data'), { recursive: true });

// interpreter: the Node running this launcher (portable, no PATH guessing)
const nodeBin = process.execPath;
const args = dev ? ['--import', 'tsx', entry] : [entry];

const child = spawn(nodeBin, args, {
  cwd: root,
  stdio: 'inherit',       // foreground; lives with the terminal
  env: process.env        // .env already loaded by index.ts
});

const forward = (sig) => { if (!child.killed) child.kill(sig); };
process.on('SIGINT', () => forward('SIGINT'));
process.on('SIGTERM', () => forward('SIGTERM'));
child.on('exit', (code) => process.exit(code ?? 0));
```

Notes for implementer:
- `stdio: 'inherit'` means the gateway's logs stream to the terminal and Ctrl+C stops it
  cleanly -- the gateway's own SIGINT handler + SingletonLock release then run.
- Do NOT use `shell: true`. Do NOT build a command string.
- For `--dev`, prefer `['--import','tsx', entry]` (Node 22+) over spawning `tsx` binary, so
  it works without a globally installed tsx.

## dotenv sketch (`src/index.ts`, very top, before other imports run config)

```ts
// Load .env if present (optional; existing env vars win). Must run before loadConfig().
try { await import('dotenv/config'); } catch { /* dotenv not installed -- fine */ }
```

If avoiding the dep, put a tiny loader in `run-gateway.mjs` instead (reads `.env`, sets
`process.env[k] ??= v`). Only one of the two approaches should ship.

## .env.example (verify it lists)

```
BROWSER_GATEWAY_TOKEN=replace-with-a-long-random-token   # >= 24 chars
BROWSER_GATEWAY_HOST=127.0.0.1
BROWSER_GATEWAY_PORT=8788
BROWSER_GATEWAY_BROWSER_URL=http://127.0.0.1:9222
# BROWSER_GATEWAY_DATA_DIR=./.data
```

## Docs: per-OS token generation (for README)

```
# bash/zsh
export BROWSER_GATEWAY_TOKEN=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")
# or: openssl rand -base64 32

# PowerShell
$env:BROWSER_GATEWAY_TOKEN = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))

# portable (writes .env)
node -e "const c=require('crypto');require('fs').writeFileSync('.env','BROWSER_GATEWAY_TOKEN='+c.randomBytes(32).toString('base64url')+'\n')"
```

## Deployment recipes to add (docs)

- **Linux systemd --user:** `~/.config/systemd/user/browsergator.service` running
  `ExecStart=/usr/bin/node <root>/scripts/run-gateway.mjs`, `Environment=` or `EnvironmentFile=<root>/.env`.
- **macOS launchd:** `~/Library/LaunchAgents/com.browsergator.gateway.plist` with
  `ProgramArguments` = node + launcher, `RunAtLoad`, `KeepAlive`.
- **Windows:** keep existing Task Scheduler section; point it at `run-gateway.ps1` (now
  delegating to .mjs) or `node scripts\run-gateway.mjs`.

## CI matrix sketch (`.github/workflows/ci.yml`)

```yaml
strategy:
  matrix:
    os: [ubuntu-latest, windows-latest, macos-latest]
runs-on: ${{ matrix.os }}
steps:
  - uses: actions/checkout@v4
  - uses: actions/setup-node@v4
    with: { node-version: '22' }
  - run: npm ci
  - run: npm run build
  - run: npm run typecheck
  - run: npm test
```
(Live smoke tests that need a real Chrome debug port stay out of the matrix -- unit tests
use the mock driver and are OS-neutral.)

## Alternatives considered

- **Two shell scripts (`.sh` + `.ps1`):** rejected -- duplication, EOL/quoting pitfalls,
  injection surface. Node launcher is strictly better.
- **Hardcode-fix only (`.ps1` reads `Get-Command node`):** solves Windows-nvm but not
  macOS/Linux. Insufficient alone.
- **dotenv as prod dependency:** unnecessary; gateway is consumed via stdio, not imported.
  devDep or the inline loader keeps the dependency surface honest.

## Testing strategy (for the TEST task)

- **Unit (OS-neutral, mock driver):** existing vitest suite must stay green on all matrix OSes.
- **Launcher behaviour:** a focused test that (a) missing `dist/index.js` -> non-zero exit +
  message, (b) `.data` created. Can be a small vitest spawning the launcher with a temp root,
  asserting exit code -- keep it fast and mock-free of Chrome.
- **dotenv:** test that a `.env` value appears in `process.env` after import and that a
  pre-set env var is NOT overridden.
- **Manual smoke (documented, not CI):** on each OS: `npm run build`, `npm run serve`, confirm
  "Browser Gateway listening" on `:8788`, then `tools/list` includes `evaluate`, `get_storage`,
  `classify_environment`.
```
