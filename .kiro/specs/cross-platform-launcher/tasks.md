# Tasks -- Cross-platform gateway launcher

Implementation plan for another agent. Each task is self-contained and checkable. Do them
in order; each references the requirements it satisfies. Do NOT change gateway logic, tools,
or the security model -- this is launcher + config + docs + CI only.

Repo: the project root (git remote: `TheJesper/browsergator`).
Gotcha already known: some Windows dev machines use nvm4w (`<nvm>\nodejs\node.exe`); the old
`run-gateway.ps1` hardcodes `C:\Program Files\nodejs\node.exe` which does NOT exist there.

---

- [ ] 1. Add the portable Node launcher
  - Create `scripts/run-gateway.mjs` per the design sketch.
  - Use `process.execPath` as the interpreter; `spawn` with an argv array; `stdio: 'inherit'`;
    no `shell: true`.
  - Missing `dist/index.js` -> print "build first" message, exit non-zero.
  - Ensure `.data` exists before spawning.
  - Forward SIGINT/SIGTERM to the child; exit with the child's code.
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 3.1_

- [ ] 2. Add optional .env loading
  - Add a guarded dynamic `dotenv/config` import at the very TOP of `src/index.ts` (before
    anything reads `process.env` / `loadConfig`). Must be non-fatal if dotenv is absent.
  - Choose ONE: add `dotenv` to `devDependencies` in `package.json`, OR implement the ~15-line
    inline `.env` reader in `run-gateway.mjs` (set `process.env[k] ??= v`). Do not ship both.
  - Confirm dotenv default semantics: existing env vars are NOT overridden.
  - _Requirements: 2.1, 2.2, 2.3, 2.5_

- [ ] 3. Verify .env is gitignored and .env.example is complete
  - Confirm `.gitignore` ignores `.env` (it already does -- verify).
  - Ensure `.env.example` lists TOKEN (with ">=24 chars" note), HOST, PORT, BROWSER_URL, and a
    commented DATA_DIR. Update if missing.
  - _Requirements: 2.4, 2.1_

- [ ] 4. Wire npm scripts
  - Add `"serve": "node scripts/run-gateway.mjs"` and `"serve:dev": "node scripts/run-gateway.mjs --dev"`.
  - Leave `build`, `test`, `lint`, `typecheck`, `dev`, `start*` unchanged.
  - _Requirements: 3.1, 3.2, 3.3_

- [ ] 5. De-hardcode the PowerShell launcher (keep Windows compatibility)
  - Rewrite `scripts/run-gateway.ps1` to delegate: resolve nothing by absolute path; call
    `node "$PSScriptRoot/run-gateway.mjs" @args`. Remove the hardcoded `C:\Program Files\nodejs\node.exe`
    and the `Test-Path` guard on it. Keep it working on nvm4w.
  - _Requirements: 6.1, 6.2_

- [ ] 6. Launcher tests
  - Add `test/run-gateway.test.ts` (vitest): (a) spawning the launcher against a temp root with
    no `dist/index.js` exits non-zero and prints the build hint; (b) `.data` is created.
  - Keep it Chrome-free and fast (do not require a real debug port).
  - _Requirements: 1.4, 1.5_

- [ ] 7. dotenv tests
  - Add a test proving a `.env` value lands in `process.env` after the import, AND that a
    pre-set `process.env` value is NOT overridden by `.env`.
  - _Requirements: 2.1, 2.3_

- [ ] 8. Rewrite README setup per-OS
  - Token generation: PowerShell + bash/zsh + portable Node one-liner (design has all three).
  - Start instructions: `npm run serve` on all OSes; note Ctrl+C stops it.
  - Replace any hardcoded `node.exe` with `node`.
  - _Requirements: 4.1, 4.2_

- [ ] 9. Rewrite docs/CLIENT-COMPATIBILITY.md per-OS
  - All client-config `command` -> `"node"` (PATH), forward-slash/placeholder paths.
  - Health checks: provide both `curl` and `Invoke-RestMethod`.
  - Add macOS launchd + Linux systemd --user recipes next to the Windows Task Scheduler section.
  - _Requirements: 4.2, 4.3, 4.4_

- [ ] 10. Add CI OS matrix
  - Edit `.github/workflows/ci.yml`: matrix `[ubuntu-latest, windows-latest, macos-latest]`,
    `runs-on: ${{ matrix.os }}`, run build + typecheck + test on each. Keep live/Chrome smoke
    tests out of the matrix.
  - _Requirements: 5.1, 5.2_

- [ ] 11. (Optional) Unify singleton lock under config.dataDir
  - Currently `index.ts` builds the lock via `fileURLToPath(new URL('../.data/gateway.lock', import.meta.url))`
    -- relative to the compiled module, not `config.dataDir`. Decide whether to base it on
    `config.dataDir` so a custom `BROWSER_GATEWAY_DATA_DIR` keeps lock + audit together.
  - If changed: keep backward compatible (fall back to old location if a lock exists there),
    and add/adjust a singleton-lock test.
  - _Requirements: open question in requirements.md_

- [ ] 12. Verify, review, cleanup, ship
  - `npm run build` + `npm run typecheck` + targeted `npm test` (the new launcher/dotenv tests
    plus the touched suites -- do NOT run the full suite without asking, per team test-safety).
  - Manual smoke on at least the local OS: `npm run serve` -> "Browser Gateway listening" on
    :8788 -> `tools/list` includes `evaluate`, `get_storage`, `classify_environment`.
  - Remove any temp files created during work (e.g. `.data/probe.mjs`, `.data/manual-start.log`,
    stale `.data/gateway.lock`), kill only PID-specific stray gateway processes.
  - Stage specific files (no `git add .`), commit with a clear message, push to `TheJesper`
    (verify active `gh` account is `TheJesper` first).
  - _Requirements: all_

---

## Definition of done

- One command (`npm run serve`) starts the gateway on Windows, macOS, and Linux with Node
  resolved from the runtime, not a hardcoded path.
- `.env` is loaded when present, never overrides real env vars, stays gitignored.
- PowerShell launcher still works (now via delegation) and no longer hardcodes node.exe.
- README + CLIENT-COMPATIBILITY have per-OS instructions and launchd/systemd recipes.
- CI passes on all three OSes.
- No gateway behaviour/tool/security change. Repo clean. Pushed to TheJesper.
