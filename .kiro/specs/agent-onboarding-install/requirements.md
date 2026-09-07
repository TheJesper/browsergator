# Requirements -- Agent onboarding via global install

## Introduction

Browsergator should be installable "globally for agents": a user tells their agent (or runs
one command) to install Browsergator, and the agent assets that teach ANY agent how to use
the shared browser are copied into the user's global agent config. After that, a fresh agent
in any repo knows how to connect to the shared gateway and drive tabs -- without the user
re-explaining it each time.

This is the onboarding/distribution layer on top of the running services
(`shared-agent-browser`) and the portable launcher (`cross-platform-launcher`).

### Mental model

> Clone Browsergator -> run install -> the agent "just knows" Browsergator everywhere.
> The knowledge (how to connect, list_tabs, per-tab coordination, leases) travels WITH
> Browsergator as installable assets, not as tribal knowledge.

### Non-goals

- Not shipping secrets. The install NEVER copies a token or a browser profile.
- Not changing the gateway, tools, or security model.
- Not forcing a specific agent client. Assets are client-neutral guidance; the connection is
  the standard MCP endpoint + bearer token.

---

## Requirement 1 -- Installable agent assets in the repo

**User story:** As a maintainer, I want the agent-facing knowledge to live in the repo so it
is versioned, reviewed, and forked with the project.

#### Acceptance criteria
1. WHERE agent assets exist THEN they SHALL live under a clear repo directory (e.g.
   `agent-assets/`) containing at least a skill that documents connecting to and using the
   shared browser.
2. WHEN the repo is cloned or forked THEN the assets SHALL be present (tracked in git) and
   SHALL contain NO secrets -- only the endpoint, the token ENV VAR NAME, and usage guidance.
3. WHERE the skill documents usage THEN it SHALL cover: the MCP endpoint, the bearer token env
   var, `list_tabs` first, driving a tab by `pageId`, and per-tab coordination (FIFO, leases).

## Requirement 2 -- One-command global install

**User story:** As a developer, I want to run one command (or tell my agent to) and have the
assets installed into my global agent config so every agent picks them up.

#### Acceptance criteria
1. WHEN the install command runs THEN it SHALL copy the agent assets into the user's global
   agent directory (e.g. `~/.kiro/skills/`), creating directories as needed.
2. WHERE files already exist THEN the installer SHALL either update them in place or skip with
   a clear message; it SHALL NOT silently destroy unrelated user content.
3. WHEN install completes THEN it SHALL print what was installed and the next step (how a new
   agent connects).
4. WHERE the install runs on Windows, macOS, or Linux THEN it SHALL resolve the global config
   path from the user's home directory at runtime (no hardcoded username/path).
5. IF the user only wants a preview THEN a dry-run mode SHALL list what WOULD be copied without
   writing.

## Requirement 3 -- Install is idempotent and reversible

**User story:** As a developer, I want to re-run install safely and be able to uninstall.

#### Acceptance criteria
1. WHEN install is run twice THEN the second run SHALL converge to the same result without
   errors or duplicates.
2. WHERE an uninstall path is provided THEN it SHALL remove ONLY the assets Browsergator
   installed, leaving other user config intact.

## Requirement 4 -- Discoverable trigger for agents

**User story:** As a user, I want a simple way to tell an agent "you're on the shared browser"
so it loads the guidance.

#### Acceptance criteria
1. WHERE the skill defines triggers THEN `/bg` (and natural phrases like "use the shared
   browser", "connect to browsergator") SHALL activate the guidance.
2. WHEN the guidance activates THEN the agent SHALL be instructed to run `list_tabs` first and
   to reference tabs by explicit `pageId`.

---

## Out of scope / notes

- npm global bin (`browsergator install`) is a nice-to-have; a `node scripts/install-agent-assets.mjs`
  entry satisfies the requirement without publishing a global binary.
- Client-specific MCP registration (Codex/Claude/Gemini) is documented in
  `docs/CLIENT-COMPATIBILITY.md`; the installer covers agent GUIDANCE, not per-client MCP
  registration (which each client does its own way).
