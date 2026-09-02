import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadDotenv, parseDotenv } from '../src/core/dotenv.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function writeEnvFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'bg-dotenv-'));
  tempDirs.push(dir);
  const path = join(dir, '.env');
  writeFileSync(path, contents, 'utf8');
  return path;
}

describe('loadDotenv', () => {
  it('should load a .env value into the target env when the key is unset', () => {
    const path = writeEnvFile('BROWSER_GATEWAY_TOKEN=from-dotenv-value\n');
    const env: NodeJS.ProcessEnv = {};

    loadDotenv(path, env);

    expect(env['BROWSER_GATEWAY_TOKEN']).toBe('from-dotenv-value');
  });

  it('should NOT override a pre-existing env var with a .env entry', () => {
    const path = writeEnvFile('BROWSER_GATEWAY_TOKEN=from-dotenv-value\n');
    const env: NodeJS.ProcessEnv = { BROWSER_GATEWAY_TOKEN: 'already-set-real-value' };

    loadDotenv(path, env);

    expect(env['BROWSER_GATEWAY_TOKEN']).toBe('already-set-real-value');
  });

  it('should be non-fatal when the .env file is absent', () => {
    const env: NodeJS.ProcessEnv = {};

    expect(() => loadDotenv(join(tmpdir(), 'does-not-exist-bg', '.env'), env)).not.toThrow();
    expect(Object.keys(env)).toHaveLength(0);
  });
});

describe('parseDotenv', () => {
  it('should ignore comments and blank lines and strip quotes and export prefixes', () => {
    const entries = parseDotenv(
      ['# comment', '', 'export FOO=bar', 'QUOTED="with spaces"', "SINGLE='q'", 'noEquals'].join('\n')
    );

    expect(entries).toEqual([
      ['FOO', 'bar'],
      ['QUOTED', 'with spaces'],
      ['SINGLE', 'q']
    ]);
  });
});
