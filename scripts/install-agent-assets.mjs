#!/usr/bin/env node
// Install Browsergator's agent-facing assets into the user's GLOBAL agent config so any
// agent, in any repo, learns how to use the shared browser.
//
// Copies  <repo>/agent-assets/skills/*  ->  <home>/.kiro/skills/*
//
// - Portable: global dir derived from the home directory at runtime (no hardcoded user).
// - Idempotent: re-running converges; existing files are overwritten only within our own
//   skill directories, never touching unrelated user content.
// - Safe: NEVER copies secrets -- only versioned guidance assets from the repo.
//
// Usage:
//   node scripts/install-agent-assets.mjs            install (copy assets)
//   node scripts/install-agent-assets.mjs --dry-run  show what would be copied
//   node scripts/install-agent-assets.mjs --uninstall remove only what we installed
//   BROWSERGATOR_KIRO_HOME=/custom/.kiro  override the target root (for tests)

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const sourceSkills = join(repoRoot, 'agent-assets', 'skills');

const kiroHome = process.env.BROWSERGATOR_KIRO_HOME ?? join(homedir(), '.kiro');
const targetSkills = join(kiroHome, 'skills');

const dryRun = process.argv.includes('--dry-run');
const uninstall = process.argv.includes('--uninstall');

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

function doInstall() {
  const skills = listSkillDirs();
  if (skills.length === 0) {
    console.error(`[install-agent-assets] No skills found under ${sourceSkills}`);
    process.exit(1);
  }
  if (!dryRun) mkdirSync(targetSkills, { recursive: true });

  for (const skill of skills) {
    const from = join(sourceSkills, skill);
    const to = join(targetSkills, skill);
    if (dryRun) {
      console.log(`[dry-run] would copy ${from}  ->  ${to}`);
      continue;
    }
    // Replace only OUR skill directory; leaves sibling skills untouched.
    rmSync(to, { recursive: true, force: true });
    cpSync(from, to, { recursive: true });
    console.log(`installed skill: ${skill}  ->  ${to}`);
  }

  if (!dryRun) {
    console.log('\nDone. A new agent can now use the shared browser.');
    console.log('Next: ensure the gateway + Chrome are running (npm run serve / npm run chrome),');
    console.log('then in your agent say "/bg" or "use the shared browser".');
  }
}

function doUninstall() {
  const skills = listSkillDirs();
  for (const skill of skills) {
    const to = join(targetSkills, skill);
    if (!existsSync(to)) continue;
    if (dryRun) {
      console.log(`[dry-run] would remove ${to}`);
      continue;
    }
    rmSync(to, { recursive: true, force: true });
    console.log(`removed skill: ${to}`);
  }
  if (!dryRun) console.log('\nUninstall complete. Only Browsergator assets were removed.');
}

if (uninstall) doUninstall();
else doInstall();
