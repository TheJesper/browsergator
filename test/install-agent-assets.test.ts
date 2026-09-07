import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const installer = resolve(process.cwd(), 'scripts', 'install-agent-assets.mjs');
const tempDirs: string[] = [];

// The canonical skill plus the alias stubs the installer writes alongside it.
const INSTALLED_SKILLS = ['bg', 'browse', 'browser', 'browsergator'];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bg-install-'));
  tempDirs.push(dir);
  return dir;
}

/**
 * Run the installer against a throwaway kiro home. `--only=kiro` is essential: without it
 * the installer would also detect and write into the real user's other agent clients.
 */
function run(kiroHome: string, args: string[] = []): string {
  return execFileSync(process.execPath, [installer, '--only=kiro', ...args], {
    env: { ...process.env, BROWSERGATOR_KIRO_HOME: kiroHome },
    encoding: 'utf8'
  });
}

/** Run against a fully fake home directory, so every client target is inside the temp dir. */
function runFakeHome(home: string, args: string[] = []): string {
  return execFileSync(process.execPath, [installer, ...args], {
    env: { ...process.env, BROWSERGATOR_HOME: home, BROWSERGATOR_KIRO_HOME: '' },
    encoding: 'utf8'
  });
}

describe('install-agent-assets', () => {
  it('should copy the bg skill into <kiroHome>/skills', () => {
    const home = tempHome();
    run(home);
    expect(existsSync(join(home, 'skills', 'bg', 'SKILL.md'))).toBe(true);
  });

  it('should install alias skills that point at bg', () => {
    const home = tempHome();
    run(home);
    for (const alias of ['browse', 'browser', 'browsergator']) {
      const content = readFileSync(join(home, 'skills', alias, 'SKILL.md'), 'utf8');
      expect(content).toContain(`name: ${alias}`);
      expect(content).toContain('bg');
    }
  });

  it('should be idempotent when run twice', () => {
    const home = tempHome();
    run(home);
    run(home);
    expect(readdirSync(join(home, 'skills')).sort()).toEqual(INSTALLED_SKILLS);
  });

  it('should not touch unrelated skills already present', () => {
    const home = tempHome();
    const otherSkill = join(home, 'skills', 'my-own-skill');
    mkdirSync(otherSkill, { recursive: true });
    writeFileSync(join(otherSkill, 'SKILL.md'), 'mine', 'utf8');

    run(home);

    expect(existsSync(join(otherSkill, 'SKILL.md'))).toBe(true);
    expect(existsSync(join(home, 'skills', 'bg', 'SKILL.md'))).toBe(true);
  });

  it('should remove only its own assets on --uninstall', () => {
    const home = tempHome();
    const otherSkill = join(home, 'skills', 'my-own-skill');
    mkdirSync(otherSkill, { recursive: true });
    writeFileSync(join(otherSkill, 'SKILL.md'), 'mine', 'utf8');
    run(home);

    run(home, ['--uninstall']);

    for (const skill of INSTALLED_SKILLS) {
      expect(existsSync(join(home, 'skills', skill))).toBe(false);
    }
    expect(existsSync(join(otherSkill, 'SKILL.md'))).toBe(true);
  });

  it('should not write anything in --dry-run', () => {
    const home = tempHome();
    const out = run(home, ['--dry-run']);
    expect(out).toContain('would copy');
    expect(existsSync(join(home, 'skills', 'bg'))).toBe(false);
  });

  it('should install into every detected client under a fake home', () => {
    const home = tempHome();
    // Presence of the client's config root is what marks it as "installed" on this machine.
    for (const dir of ['.claude', '.codex', '.gemini', '.copilot']) {
      mkdirSync(join(home, dir), { recursive: true });
    }

    runFakeHome(home);

    expect(existsSync(join(home, '.claude', 'skills', 'bg', 'SKILL.md'))).toBe(true);
    expect(readFileSync(join(home, '.codex', 'AGENTS.md'), 'utf8')).toContain('Browsergator');
    expect(readFileSync(join(home, '.gemini', 'GEMINI.md'), 'utf8')).toContain('browser-gateway');
    expect(readFileSync(join(home, '.copilot', 'copilot-instructions.md'), 'utf8')).toContain('list_tabs');
  });

  it('should preserve user content in an instruction file and replace only its own block', () => {
    const home = tempHome();
    mkdirSync(join(home, '.codex'), { recursive: true });
    const file = join(home, '.codex', 'AGENTS.md');
    writeFileSync(file, '# My rules\n\nKeep this line.\n', 'utf8');

    runFakeHome(home, ['--only=codex']);
    runFakeHome(home, ['--only=codex']);

    const content = readFileSync(file, 'utf8');
    expect(content).toContain('Keep this line.');
    // Exactly one managed block survives repeated installs.
    expect(content.split('BEGIN BROWSERGATOR').length - 1).toBe(1);

    runFakeHome(home, ['--only=codex', '--uninstall']);
    const after = readFileSync(file, 'utf8');
    expect(after).toContain('Keep this line.');
    expect(after).not.toContain('BEGIN BROWSERGATOR');
  });
});
