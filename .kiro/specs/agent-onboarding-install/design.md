# Design -- Agent onboarding via global install

## Overview

The agent-facing knowledge for "how to use the shared browser" is shipped IN the repo as
versioned assets. A portable installer copies those assets into the user's global agent
config, so any agent in any repo picks them up. No secrets travel; only guidance.

```
<repo>/agent-assets/skills/bg/SKILL.md      (tracked, reviewed, forked with the project)
        |  node scripts/install-agent-assets.mjs
        v
<home>/.kiro/skills/bg/SKILL.md             (per-user, global -- every agent sees it)
```

The gateway, tools, and security model are untouched. This is pure distribution/onboarding.

## Design decisions

### D1. Assets live in the repo, not only in ~/.kiro
- **Decision:** author the `/bg` skill under `agent-assets/skills/bg/SKILL.md` in the repo.
- **Why:** it is versioned, PR-reviewed, and forked with Browsergator. The knowledge travels
  with the project (constitution: "clone -> install -> the agent just knows").

### D2. Installer copies into the home-derived global dir
- **Decision:** `scripts/install-agent-assets.mjs` copies `agent-assets/skills/*` into
  `<home>/.kiro/skills/*`. Target root overridable via `BROWSERGATOR_KIRO_HOME` (for tests).
- **Why portable:** the target is derived from `os.homedir()` at runtime -- no hardcoded user
  or path, works on every OS (Requirement 2.4).

### D3. Idempotent, scoped, reversible
- **Decision:** for each skill, remove only that skill's target directory then copy fresh, so
  a re-run converges and never duplicates. `--uninstall` removes only the skills Browsergator
  ships. Sibling skills the user authored are never touched.
- **Why:** safe re-runs and clean uninstall without collateral damage (Requirements 3.1, 3.2, 2.2).

### D4. Dry-run first-class
- **Decision:** `--dry-run` prints the copy plan and writes nothing.
- **Why:** users (and cautious agents) can preview before mutating global config (2.5).

### D5. No secrets, ever
- **Decision:** the installer copies ONLY `agent-assets/` (guidance). It never reads `.env`,
  the token, or the Chrome profile.
- **Why:** the repo is cloned/forked by many; assets must be safe to distribute (Req 1.2, 5).

### D6. `/bg` trigger + connection guidance
- **Decision:** the skill's frontmatter defines triggers (`/bg`, "use the shared browser",
  "connect to browsergator"); its body documents the endpoint, the token ENV VAR NAME (not the
  value), `list_tabs`-first, `pageId` discipline, and per-tab coordination/leases.
- **Why:** a fresh agent activates it by name and immediately knows the safe usage pattern.

## Component / file changes

| File | Change | Requirement |
|------|--------|-------------|
| `agent-assets/skills/bg/SKILL.md` | NEW -- the shared-browser usage skill | R1, R4 |
| `scripts/install-agent-assets.mjs` | NEW -- portable installer (install/dry-run/uninstall) | R2, R3 |
| `package.json` | ADD `install:agent` script | R2 |
| `test/install-agent-assets.test.ts` | NEW -- copy/idempotent/scoped/uninstall/dry-run | R2, R3 |
| `README.md` | ADD "Install for agents" section | R2, R4 |

## Installer sketch

```js
const kiroHome = process.env.BROWSERGATOR_KIRO_HOME ?? join(homedir(), '.kiro');
const targetSkills = join(kiroHome, 'skills');
for (const skill of listSkillDirs(sourceSkills)) {
  const to = join(targetSkills, skill);
  rmSync(to, { recursive: true, force: true });   // scoped to our own dir
  cpSync(join(sourceSkills, skill), to, { recursive: true });
}
// --dry-run: log the plan, write nothing. --uninstall: rm only our skill dirs.
```

## How a user triggers it

- Manual: `npm run install:agent` (or `node scripts/install-agent-assets.mjs`).
- Conversational: "install browsergator globally" -> the agent runs the installer, then a
  fresh agent says `/bg` and has the guidance.

## Alternatives considered

- **Publish an npm global bin (`browsergator install`):** nice-to-have, more moving parts and
  a publish step. A `node scripts/install-agent-assets.mjs` entry meets the requirement now;
  a bin can wrap it later.
- **Symlink instead of copy:** rejected -- brittle across OSes and permission models; a copy is
  simple and predictable, and re-install refreshes it.
- **Bake guidance only into README:** rejected -- a README is not loaded into an agent's
  context automatically; a skill with triggers is.

## Testing strategy

- **Unit/integration (`install-agent-assets.test.ts`):** against a temp `BROWSERGATOR_KIRO_HOME`:
  copies bg skill, idempotent on re-run, leaves unrelated sibling skills intact, `--uninstall`
  removes only bg, `--dry-run` writes nothing.
- **Manual:** run with a temp target and inspect; verified the bg skill lands and uninstall is
  scoped.
