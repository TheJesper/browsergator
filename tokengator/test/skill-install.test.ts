import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { packageRoot } from '../src/server/app.js';
import {
  BLOCK_BEGIN,
  BLOCK_END,
  NOTE_NOT_INSTALLED,
  NOTE_NOT_SET_UP,
  SKILL_CLIENT_IDS,
  installSkill,
  managedBlock,
  skillBody,
  type SkillAction
} from '../src/server/skill-install.js';

const SKILL = ['---', 'name: tokengator', 'description: "A draft skill used by the installer tests."', '---', '', '# tokengator', '', 'Check what resets soon.', ''].join('\n');
const BODY = '# tokengator\n\nCheck what resets soon.';
const BLOCK = `${BLOCK_BEGIN}\n${BODY}\n${BLOCK_END}`;
const USER_TEXT = '# My rules\n\nBe kind.\n';

let root: string;
let home: string;
let pkg: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tokengator-skill-'));
  home = join(root, 'home');
  pkg = join(root, 'package');
  mkdirSync(home, { recursive: true });
  mkdirSync(join(pkg, 'skill'), { recursive: true });
  writeFileSync(join(pkg, 'skill', 'SKILL.md'), SKILL);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const run = (options: Partial<Parameters<typeof installSkill>[0]> = {}): SkillAction[] => installSkill({ home, packageRoot: pkg, ...options }).actions;
const byClient = (actions: SkillAction[]): Record<string, SkillAction['action']> => Object.fromEntries(actions.map((entry) => [entry.client, entry.action]));
const text = (...parts: string[]): string => readFileSync(join(home, ...parts), 'utf8');

/** Every file under the fake home with its content, to prove that a run changed nothing. */
function snapshot(dir: string = home): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name);
      // Forward slashes on every platform, so the keys can be written out in the tests.
      const key = relative(dir, path).split(sep).join('/');
      if (statSync(path).isDirectory()) {
        out[`${key}/`] = '';
        walk(path);
      } else {
        out[key] = readFileSync(path, 'utf8');
      }
    }
  };
  walk(dir);
  return out;
}

/** A home with one client of each shape, one of them holding the person's own instructions. */
function setUpClients(): void {
  mkdirSync(join(home, '.claude', 'skills', 'other-skill'), { recursive: true });
  writeFileSync(join(home, '.claude', 'skills', 'other-skill', 'SKILL.md'), 'someone else\n');
  mkdirSync(join(home, '.codex'));
  writeFileSync(join(home, '.codex', 'AGENTS.md'), USER_TEXT);
  mkdirSync(join(home, '.cursor'));
}

describe('skill text', () => {
  it('drops the YAML front matter for instruction files and keeps the rest', () => {
    expect(skillBody(SKILL)).toBe(BODY);
    expect(skillBody(SKILL.replace(/\n/g, '\r\n'))).toBe(BODY);
    expect(skillBody('# no front matter\n')).toBe('# no front matter');
    expect(managedBlock(SKILL)).toBe(BLOCK);
  });

  it('uses the markers the specification names', () => {
    expect(BLOCK_BEGIN).toBe('<!-- BEGIN TOKENGATOR (managed by tokengator skill install) -->');
    expect(BLOCK_END).toBe('<!-- END TOKENGATOR -->');
  });

  it('turns the shipped skill into a block without front matter', () => {
    const shipped = readFileSync(join(packageRoot(), 'skill', 'SKILL.md'), 'utf8');
    const body = skillBody(shipped);
    expect(shipped.startsWith('---')).toBe(true);
    expect(body.startsWith('---')).toBe(false);
    expect(body.length).toBeGreaterThan(200);
    expect(body).not.toContain(BLOCK_BEGIN);
    expect(body).not.toContain(BLOCK_END);
  });
});

describe('install', () => {
  it('touches only clients that are set up on the machine', () => {
    const actions = run();
    expect(actions.map((entry) => entry.client)).toEqual(SKILL_CLIENT_IDS);
    expect(actions.every((entry) => entry.action === 'skip' && entry.note === NOTE_NOT_SET_UP)).toBe(true);
    expect(snapshot()).toEqual({});
  });

  it('copies the skill for skill-directory clients and writes a block for instruction-file clients', () => {
    setUpClients();
    const actions = run();
    expect(byClient(actions)).toEqual({ claude: 'write', agents: 'skip', antigravity: 'skip', kiro: 'skip', codex: 'update', gemini: 'skip', copilot: 'skip', cursor: 'write', windsurf: 'skip', opencode: 'skip' });

    // The skill directory gets the file exactly as shipped, front matter included.
    expect(text('.claude', 'skills', 'tokengator', 'SKILL.md')).toBe(SKILL);
    expect(actions.find((entry) => entry.client === 'claude')?.path).toBe(join(home, '.claude', 'skills', 'tokengator', 'SKILL.md'));
    // The person's instructions come first, untouched, then one blank line, then the block.
    expect(text('.codex', 'AGENTS.md')).toBe(`${USER_TEXT}\n${BLOCK}\n`);
    // A client with no instruction file yet gets one that holds only the block.
    expect(text('.cursor', 'rules', 'tokengator.md')).toBe(`${BLOCK}\n`);
    // Somebody else's skill is not ours to touch.
    expect(text('.claude', 'skills', 'other-skill', 'SKILL.md')).toBe('someone else\n');
  });

  it('reports everything as unchanged on a second run and changes nothing (scenario: Install twice)', () => {
    setUpClients();
    run();
    const before = snapshot();
    const second = run();
    expect(second.filter((entry) => entry.action !== 'skip').map((entry) => entry.action)).toEqual(['unchanged', 'unchanged', 'unchanged']);
    expect(second.some((entry) => entry.action === 'write' || entry.action === 'update' || entry.action === 'remove')).toBe(false);
    expect(snapshot()).toEqual(before);
  });

  it('replaces only its own block when the skill text changes, wherever the block sits', () => {
    setUpClients();
    run();
    const file = join(home, '.codex', 'AGENTS.md');
    writeFileSync(file, `${readFileSync(file, 'utf8')}\n## Added later\n\nStill mine.\n`);
    writeFileSync(join(pkg, 'skill', 'SKILL.md'), SKILL.replace('Check what resets soon.', 'Check what resets soon, then say so.'));

    expect(byClient(run())).toMatchObject({ claude: 'update', codex: 'update', cursor: 'update' });
    const updated = text('.codex', 'AGENTS.md');
    expect(updated).toBe(`${USER_TEXT}\n${BLOCK_BEGIN}\n# tokengator\n\nCheck what resets soon, then say so.\n${BLOCK_END}\n\n## Added later\n\nStill mine.\n`);
    expect(updated.split(BLOCK_BEGIN)).toHaveLength(2);
    expect(text('.claude', 'skills', 'tokengator', 'SKILL.md')).toContain('then say so');
  });

  it('separates the block from text that does not end in a newline', () => {
    mkdirSync(join(home, '.gemini'));
    writeFileSync(join(home, '.gemini', 'GEMINI.md'), 'no newline at the end');
    run();
    expect(text('.gemini', 'GEMINI.md')).toBe(`no newline at the end\n\n${BLOCK}\n`);
  });

  it('keeps Windows line endings in the surrounding text', () => {
    mkdirSync(join(home, '.codex'));
    const original = '# Rules\r\n\r\nUse tabs.\r\n';
    writeFileSync(join(home, '.codex', 'AGENTS.md'), original);
    run();
    expect(text('.codex', 'AGENTS.md').startsWith(original)).toBe(true);
    expect(byClient(run())['codex']).toBe('unchanged');
    run({ uninstall: true });
    expect(text('.codex', 'AGENTS.md')).toBe(original);
  });

  it('writes nothing in a dry run, and says what it would do', () => {
    setUpClients();
    const before = snapshot();
    expect(byClient(run({ dryRun: true }))).toMatchObject({ claude: 'write', codex: 'update', cursor: 'write' });
    expect(snapshot()).toEqual(before);
    expect(existsSync(join(home, '.claude', 'skills', 'tokengator'))).toBe(false);
  });

  it('installs for every supported client with all, creating what is missing', () => {
    const actions = run({ all: true });
    expect(actions.map((entry) => entry.action)).toEqual(SKILL_CLIENT_IDS.map(() => 'write'));
    expect(text('.kiro', 'skills', 'tokengator', 'SKILL.md')).toBe(SKILL);
    for (const parts of [
      ['.codex', 'AGENTS.md'],
      ['.gemini', 'GEMINI.md'],
      ['.copilot', 'copilot-instructions.md'],
      ['.cursor', 'rules', 'tokengator.md'],
      ['.windsurf', 'rules', 'tokengator.md'],
      ['.config', 'opencode', 'AGENTS.md']
    ]) {
      expect(text(...parts)).toBe(`${BLOCK}\n`);
    }
    expect(run({ all: true }).every((entry) => entry.action === 'unchanged')).toBe(true);
  });

  it('limits the run to the clients named in only, and says so about a name it does not know', () => {
    setUpClients();
    const actions = run({ only: ['Codex', ' nope '] });
    expect(actions.map((entry) => [entry.client, entry.action])).toEqual([
      ['nope', 'skip'],
      ['codex', 'update']
    ]);
    expect(actions[0]?.note).toContain('Unknown client');
    expect(existsSync(join(home, '.claude', 'skills', 'tokengator'))).toBe(false);
    expect(existsSync(join(home, '.cursor', 'rules'))).toBe(false);
  });

  it('leaves a file with a damaged block alone instead of guessing where it ends', () => {
    mkdirSync(join(home, '.codex'));
    const damaged = `${USER_TEXT}\n${BLOCK_BEGIN}\nhalf a block, the end marker is gone\n\n## My own section\n`;
    writeFileSync(join(home, '.codex', 'AGENTS.md'), damaged);
    for (const options of [{}, { uninstall: true }]) {
      const action = run(options).find((entry) => entry.client === 'codex');
      expect(action?.action).toBe('skip');
      expect(action?.note).toContain('end marker');
      expect(text('.codex', 'AGENTS.md')).toBe(damaged);
    }
  });

  it('carries on with the other clients when one cannot be written', () => {
    setUpClients();
    // A directory where the instruction file should be.
    mkdirSync(join(home, '.cursor', 'rules', 'tokengator.md'), { recursive: true });
    const actions = run();
    expect(byClient(actions)).toMatchObject({ claude: 'write', codex: 'update', cursor: 'skip' });
    expect(actions.find((entry) => entry.client === 'cursor')?.note).toContain('Could not be changed');
  });

  it('fails clearly when the package has no skill file', () => {
    expect(() => installSkill({ home, packageRoot: join(root, 'nowhere') })).toThrow(/skill file is missing/);
  });
});

describe('shared skill directories', () => {
  it('copies the skill into ~/.agents/skills and the Antigravity skills directory when those clients are set up', () => {
    mkdirSync(join(home, '.agents'), { recursive: true });
    mkdirSync(join(home, '.gemini', 'config'), { recursive: true });
    const actions = run();
    expect(byClient(actions)).toMatchObject({ agents: 'write', antigravity: 'write' });
    const shipped = readFileSync(join(pkg, 'skill', 'SKILL.md'), 'utf8');
    expect(readFileSync(join(home, '.agents', 'skills', 'tokengator', 'SKILL.md'), 'utf8')).toBe(shipped);
    expect(readFileSync(join(home, '.gemini', 'config', 'skills', 'tokengator', 'SKILL.md'), 'utf8')).toBe(shipped);
    expect(byClient(run())).toMatchObject({ agents: 'unchanged', antigravity: 'unchanged' });
    expect(byClient(run({ uninstall: true }))).toMatchObject({ agents: 'remove', antigravity: 'remove' });
    expect(existsSync(join(home, '.agents', 'skills', 'tokengator'))).toBe(false);
  });
});

describe('uninstall', () => {
  it('removes only what was installed and gives the instruction file back as it was (scenario: Uninstall)', () => {
    setUpClients();
    const before = snapshot();
    run();
    const actions = run({ uninstall: true });
    expect(byClient(actions)).toEqual({ claude: 'remove', agents: 'skip', antigravity: 'skip', kiro: 'skip', codex: 'remove', gemini: 'skip', copilot: 'skip', cursor: 'remove', windsurf: 'skip', opencode: 'skip' });
    expect(actions.filter((entry) => entry.action === 'skip').every((entry) => entry.note === NOTE_NOT_INSTALLED)).toBe(true);

    expect(text('.codex', 'AGENTS.md')).toBe(USER_TEXT);
    expect(existsSync(join(home, '.claude', 'skills', 'tokengator'))).toBe(false);
    expect(text('.claude', 'skills', 'other-skill', 'SKILL.md')).toBe('someone else\n');
    // The cursor rules file held nothing but the block, so it was ours and is gone.
    expect(existsSync(join(home, '.cursor', 'rules', 'tokengator.md'))).toBe(false);

    // Apart from the empty directory the installer had to create, the home is as it was found.
    const after = snapshot();
    delete after['.cursor/rules/'];
    expect(after).toEqual(before);
  });

  it('keeps text the person wrote before and after the block', () => {
    mkdirSync(join(home, '.codex'));
    const file = join(home, '.codex', 'AGENTS.md');
    writeFileSync(file, USER_TEXT);
    run();
    writeFileSync(file, `${readFileSync(file, 'utf8')}\n## Added later\n\nStill mine.\n`);
    expect(byClient(run({ uninstall: true }))['codex']).toBe('remove');
    expect(text('.codex', 'AGENTS.md')).toBe(`${USER_TEXT}\n## Added later\n\nStill mine.\n`);
  });

  it('keeps a file that has anything else in it, however little', () => {
    mkdirSync(join(home, '.cursor', 'rules'), { recursive: true });
    writeFileSync(join(home, '.cursor', 'rules', 'tokengator.md'), `${BLOCK}\nmine\n`);
    run({ uninstall: true });
    expect(text('.cursor', 'rules', 'tokengator.md')).toBe('mine\n');
  });

  it('removes nothing in a dry run', () => {
    setUpClients();
    run();
    const installed = snapshot();
    expect(byClient(run({ uninstall: true, dryRun: true }))).toMatchObject({ claude: 'remove', codex: 'remove', cursor: 'remove' });
    expect(snapshot()).toEqual(installed);
  });

  it('has nothing to do on a machine where nothing was installed, and is safe to repeat', () => {
    setUpClients();
    const before = snapshot();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(run({ uninstall: true }).every((entry) => entry.action === 'skip')).toBe(true);
    }
    expect(snapshot()).toEqual(before);
    // Uninstalling does not need the skill file either.
    expect(() => installSkill({ home, packageRoot: join(root, 'nowhere'), uninstall: true })).not.toThrow();
  });
});
