#!/usr/bin/env node
// Install Browsergator's agent-facing assets machine-wide, so ANY agent in ANY client
// (Claude Code, Kiro, Codex, Gemini CLI, GitHub Copilot CLI, Cursor, Windsurf, ...)
// learns how to use the one shared browser as soon as it is asked to browse.
//
// Two install shapes, because agent clients differ:
//
//   1. Skill-directory clients (Claude Code, Kiro)
//      <repo>/agent-assets/skills/bg  ->  <home>/<client>/skills/bg
//      plus thin alias skills (browse, browser, browsergator) that point at `bg`.
//
//   2. Instruction-file clients (Codex, Gemini, Copilot, Cursor, Windsurf)
//      A managed block is written into the client's global instruction file
//      (AGENTS.md / GEMINI.md / copilot-instructions.md / rules file). The block is
//      delimited by markers so re-running replaces only our block and never touches
//      the user's own text.
//
// Properties: portable (paths derived from homedir at runtime), idempotent (re-running
// converges), safe (only versioned guidance is copied -- never secrets or tokens).
//
// Usage:
//   node scripts/install-agent-assets.mjs             install into every detected client
//   node scripts/install-agent-assets.mjs --dry-run   show what would change, write nothing
//   node scripts/install-agent-assets.mjs --uninstall remove only what we installed
//   node scripts/install-agent-assets.mjs --all       also install into clients not present yet
//   node scripts/install-agent-assets.mjs --only=claude,codex   limit to named clients
//
// Env overrides (used by tests):
//   BROWSERGATOR_HOME       fake home directory root
//   BROWSERGATOR_KIRO_HOME  legacy override -- still honoured, forces the kiro target root

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const sourceSkills = join(repoRoot, 'agent-assets', 'skills');

const home = process.env.BROWSERGATOR_HOME ?? homedir();

const dryRun = process.argv.includes('--dry-run');
const uninstall = process.argv.includes('--uninstall');
const installAll = process.argv.includes('--all');
const onlyArg = process.argv.find((a) => a.startsWith('--only='));
const only = onlyArg ? onlyArg.slice('--only='.length).split(',').map((s) => s.trim()) : null;

const BEGIN = '<!-- BEGIN BROWSERGATOR (managed by install-agent-assets.mjs) -->';
const END = '<!-- END BROWSERGATOR -->';

// Alias skills. Each is a stub that defers to the canonical `bg` skill, so the guidance
// lives in exactly one place and aliases never drift.
const ALIASES = {
  browse: 'Primary Browsergator alias. Use the shared browser gateway for safe multi-agent browser work.',
  browser: 'Shared-browser access for multiple agents via the Browsergator gateway.',
  browsergator: 'Explicit Browsergator alias for the shared multi-agent browser gateway.'
};

// Client registry. `kind: skills` gets real skill directories; `kind: instructions`
// gets a managed markdown block in the client's global instruction file.
const CLIENTS = [
  { id: 'claude', kind: 'skills', root: join(home, '.claude'), skillsDir: join(home, '.claude', 'skills') },
  { id: 'kiro', kind: 'skills', root: join(home, '.kiro'), skillsDir: join(home, '.kiro', 'skills') },
  { id: 'codex', kind: 'instructions', root: join(home, '.codex'), file: join(home, '.codex', 'AGENTS.md') },
  { id: 'gemini', kind: 'instructions', root: join(home, '.gemini'), file: join(home, '.gemini', 'GEMINI.md') },
  { id: 'copilot', kind: 'instructions', root: join(home, '.copilot'), file: join(home, '.copilot', 'copilot-instructions.md') },
  { id: 'cursor', kind: 'instructions', root: join(home, '.cursor'), file: join(home, '.cursor', 'rules', 'browsergator.md') },
  { id: 'windsurf', kind: 'instructions', root: join(home, '.windsurf'), file: join(home, '.windsurf', 'rules', 'browsergator.md') },
  { id: 'opencode', kind: 'instructions', root: join(home, '.config', 'opencode'), file: join(home, '.config', 'opencode', 'AGENTS.md') }
];

// The legacy env override pinned the kiro root; keep honouring it for existing callers.
if (process.env.BROWSERGATOR_KIRO_HOME) {
  const kiro = CLIENTS.find((c) => c.id === 'kiro');
  kiro.root = process.env.BROWSERGATOR_KIRO_HOME;
  kiro.skillsDir = join(process.env.BROWSERGATOR_KIRO_HOME, 'skills');
}

function selectedClients() {
  return CLIENTS.filter((c) => {
    if (only && !only.includes(c.id)) return false;
    return installAll || existsSync(c.root);
  });
}

function listSkillDirs() {
  if (!existsSync(sourceSkills)) return [];
  return readdirSync(sourceSkills).filter((name) => {
    try {
      return statSync(join(sourceSkills, name)).isDirectory();
    } catch {
      return false;
    }
  });
}

/** Short stub skill whose only job is to route the agent into the canonical `bg` skill. */
function aliasSkill(name, description) {
  return `---
name: ${name}
description: "${description}"
triggers:
  - "/${name}"
  - "${name}"
---

# /${name} -- Browsergator (alias)

This is an alias. Follow the full shared-browser rules in the \`bg\` skill
(\`<agent-home>/skills/bg/SKILL.md\`): connect to the gateway at
\`http://127.0.0.1:8788/mcp\`, call \`list_tabs\` first, and drive tabs by explicit
\`pageId\` while passing your own \`agentId\`, \`taskId\` and \`leaseOwnerId\`.

Never launch your own browser. The shared Chrome is already running.
`;
}

/** The managed block written into instruction-file clients. Mirrors the `bg` skill, condensed. */
function instructionBlock() {
  return `${BEGIN}
## Shared browser (Browsergator)

A single always-on Chrome is shared by every agent on this machine, fronted by the
**browser-gateway** MCP server. Whenever you need to open, read, or drive a web page:

- **Use the \`browser-gateway\` MCP tools. Never launch your own browser** (no Playwright
  install, no headless Chrome, no \`chrome-devtools-mcp\` plugin) -- a second browser breaks
  the shared session and the coordination guarantees.
- Endpoint \`http://127.0.0.1:8788/mcp\`, auth \`Authorization: Bearer $BROWSER_GATEWAY_TOKEN\`.
  If the tools are missing, the gateway is not registered in this client -- see
  \`docs/CLIENT-COMPATIBILITY.md\` in the Browsergator repo.
- **Always \`list_tabs\` first.** Never assume a "current tab": every page-scoped call takes
  an explicit \`pageId\`.
- **Pass your identity on every call:** \`agentId\` (stable name), \`taskId\` (unit of work),
  \`leaseOwnerId\` (ownership key for this attempt). MCP session ids are not identities.
- **Coordinate before mutating.** Use \`run_atomic\` for short mutations; take a lease with
  \`claim_tab\` for longer sequences and \`release_tab\` promptly when done.
- **Clean up:** close only tabs you opened. Other agents are using the rest.
- **Safety:** never purchase, trade, submit sensitive forms, handle BankID, or solve CAPTCHA.
  A mutating \`evaluate\` on a non-local site requires explicit user confirmation.

Health check: \`curl http://127.0.0.1:8788/healthz\`. If it fails, start the service with
\`npm run chrome\` and \`npm run serve\` in the Browsergator repo.
${END}`;
}

function writeFile(path, content, label) {
  if (dryRun) {
    console.log(`[dry-run] would write ${path}  (${label})`);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
  console.log(`  ${label}: ${path}`);
}

function installSkills(client) {
  const skills = listSkillDirs();
  if (skills.length === 0) {
    console.error(`[install-agent-assets] No skills found under ${sourceSkills}`);
    process.exit(1);
  }
  if (!dryRun) mkdirSync(client.skillsDir, { recursive: true });

  for (const skill of skills) {
    const from = join(sourceSkills, skill);
    const to = join(client.skillsDir, skill);
    if (dryRun) {
      console.log(`[dry-run] would copy ${from}  ->  ${to}`);
      continue;
    }
    // Replace only OUR skill directory; leaves sibling skills untouched.
    rmSync(to, { recursive: true, force: true });
    cpSync(from, to, { recursive: true });
    console.log(`  skill: ${to}`);
  }

  for (const [name, description] of Object.entries(ALIASES)) {
    writeFile(join(client.skillsDir, name, 'SKILL.md'), aliasSkill(name, description), 'alias');
  }
}

/** Replace an existing managed block, or append one, leaving all other content intact. */
function upsertBlock(existing, block) {
  const start = existing.indexOf(BEGIN);
  const end = existing.indexOf(END);
  if (start !== -1 && end !== -1 && end > start) {
    return existing.slice(0, start) + block + existing.slice(end + END.length);
  }
  const separator = existing === '' || existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
  return existing + separator + block + '\n';
}

function installInstructions(client) {
  const existing = existsSync(client.file) ? readFileSync(client.file, 'utf8') : '';
  const next = upsertBlock(existing, instructionBlock());
  if (next === existing) {
    console.log(`  unchanged: ${client.file}`);
    return;
  }
  writeFile(client.file, next, existing === '' ? 'created' : 'updated');
}

function uninstallSkills(client) {
  const names = [...listSkillDirs(), ...Object.keys(ALIASES)];
  for (const name of names) {
    const to = join(client.skillsDir, name);
    if (!existsSync(to)) continue;
    if (dryRun) {
      console.log(`[dry-run] would remove ${to}`);
      continue;
    }
    rmSync(to, { recursive: true, force: true });
    console.log(`  removed: ${to}`);
  }
}

function uninstallInstructions(client) {
  if (!existsSync(client.file)) return;
  const existing = readFileSync(client.file, 'utf8');
  const start = existing.indexOf(BEGIN);
  const end = existing.indexOf(END);
  if (start === -1 || end === -1 || end < start) return;
  const next = (existing.slice(0, start) + existing.slice(end + END.length)).replace(/\n{3,}$/, '\n');
  writeFile(client.file, next, 'block removed');
}

const clients = selectedClients();
if (clients.length === 0) {
  console.error('[install-agent-assets] No agent clients detected. Use --all to install anyway.');
  process.exit(1);
}

for (const client of clients) {
  console.log(`\n[${client.id}] ${client.kind === 'skills' ? client.skillsDir : client.file}`);
  if (uninstall) {
    if (client.kind === 'skills') uninstallSkills(client);
    else uninstallInstructions(client);
  } else if (client.kind === 'skills') {
    installSkills(client);
  } else {
    installInstructions(client);
  }
}

if (dryRun) {
  console.log('\nDry run only -- nothing was written.');
} else if (uninstall) {
  console.log('\nUninstall complete. Only Browsergator assets were removed.');
} else {
  console.log(`\nDone. ${clients.length} client(s) configured. Any agent can now use the shared browser.`);
  console.log('Next: ensure the gateway + Chrome are running (npm run serve / npm run chrome),');
  console.log('then in your agent say "/bg" or "use the shared browser".');
}
