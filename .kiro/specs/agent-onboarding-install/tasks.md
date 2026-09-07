# Tasks -- Agent onboarding via global install

Distribution/onboarding layer. No gateway, tool, or security change. Assets must contain NO
secrets. Do tasks in order.

Status: [x] done and verified, [ ] not started.

---

- [x] 1. Author the shared-browser skill
  - `agent-assets/skills/bg/SKILL.md` with frontmatter triggers (`/bg`, "use the shared
    browser", "connect to browsergator") and a body covering: MCP endpoint, token ENV VAR
    NAME (not value), `list_tabs` first, `pageId` discipline, per-tab FIFO + leases, prod-host
    caution, and the "gateway never launches Chrome" rule.
  - _Requirements: 1.1, 1.2, 1.3, 4.1, 4.2_

- [x] 2. Portable installer
  - `scripts/install-agent-assets.mjs`: copy `agent-assets/skills/*` -> `<home>/.kiro/skills/*`
    (root overridable via `BROWSERGATOR_KIRO_HOME`). Support `--dry-run` and `--uninstall`.
    Idempotent; scoped to our own skill dirs; never reads secrets.
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 3.1, 3.2, 5_

- [x] 3. npm script + lint
  - `package.json`: add `"install:agent": "node scripts/install-agent-assets.mjs"`.
  - Ensure the new `.mjs` lints clean under the `scripts/**/*.mjs` eslint block.
  - _Requirements: 2.1_

- [x] 4. Installer tests
  - `test/install-agent-assets.test.ts`: copies bg skill; idempotent re-run; leaves unrelated
    sibling skills intact; `--uninstall` removes only bg; `--dry-run` writes nothing. Uses a
    temp `BROWSERGATOR_KIRO_HOME`.
  - _Requirements: 2.2, 2.5, 3.1, 3.2_

- [x] 5. README "Install for agents" section
  - Document `npm run install:agent` (+ `--dry-run`, `--uninstall`), what it copies, and the
    "install browsergator globally -> say /bg in any agent" flow. Note it copies no secrets.
  - _Requirements: 2.3, 4.1_

- [ ] 6. Verify + secret audit + ship
  - Build/typecheck/lint; run the installer test + touched suites (targeted). Confirm no
    secrets in `agent-assets/` or the staged diff. Stage specific files, commit, push as
    TheJesper, then switch gh profile back to jesper-wilfing_volvo.
  - _Requirements: all; constitution principle 8_

---

## Definition of done

- The `/bg` skill exists in the repo and documents safe shared-browser usage.
- One command installs it globally; re-runnable; uninstall is scoped; dry-run previews.
- No secrets in the assets or the repo.
- A fresh agent, after install, activates `/bg` and knows to `list_tabs` first and drive tabs
  by `pageId`.
- No gateway/tool/security change.
