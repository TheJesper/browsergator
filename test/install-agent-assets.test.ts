import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const installer = resolve(process.cwd(), 'scripts', 'install-agent-assets.mjs');
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function tempKiroHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bg-install-'));
  tempDirs.push(dir);
  return dir;
}

function run(kiroHome: string, args: string[] = []): string {
  return execFileSync(process.execPath, [installer, ...args], {
    env: { ...process.env, BROWSERGATOR_KIRO_HOME: kiroHome },
    encoding: 'utf8'
  });
}

describe('install-agent-assets', () => {
  it('should copy the bg skill into <kiroHome>/skills', () => {
    const home = tempKiroHome();
    run(home);
    expect(existsSync(join(home, 'skills', 'bg', 'SKILL.md'))).toBe(true);
  });

  it('should be idempotent when run twice', () => {
    const home = tempKiroHome();
    run(home);
    run(home);
    expect(readdirSync(join(home, 'skills'))).toEqual(['bg']);
  });

  it('should not touch unrelated skills already present', () => {
    const home = tempKiroHome();
    const otherSkill = join(home, 'skills', 'my-own-skill');
    mkdirSync(otherSkill, { recursive: true });
    writeFileSync(join(otherSkill, 'SKILL.md'), 'mine', 'utf8');

    run(home);

    expect(existsSync(join(otherSkill, 'SKILL.md'))).toBe(true);
    expect(existsSync(join(home, 'skills', 'bg', 'SKILL.md'))).toBe(true);
  });

  it('should remove only its own assets on --uninstall', () => {
    const home = tempKiroHome();
    const otherSkill = join(home, 'skills', 'my-own-skill');
    mkdirSync(otherSkill, { recursive: true });
    writeFileSync(join(otherSkill, 'SKILL.md'), 'mine', 'utf8');
    run(home);

    run(home, ['--uninstall']);

    expect(existsSync(join(home, 'skills', 'bg'))).toBe(false);
    expect(existsSync(join(otherSkill, 'SKILL.md'))).toBe(true);
  });

  it('should not write anything in --dry-run', () => {
    const home = tempKiroHome();
    const out = run(home, ['--dry-run']);
    expect(out).toContain('would copy');
    expect(existsSync(join(home, 'skills', 'bg'))).toBe(false);
  });
});
