import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { envFilePath, liveEnv, loadEnvFile, mergedEnv, parseEnvFile } from '../src/server/env.js';

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'tokengator-env-'));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('parseEnvFile', () => {
  it('reads KEY=VALUE lines and skips comments, blank lines and anything else', () => {
    const parsed = parseEnvFile(
      ['# keys for collectors', '', 'ELEVENLABS_API_KEY=abc123', '   # indented comment', 'not an assignment', '1BAD=x', 'OPENROUTER_API_KEY = spaced', '=novalue'].join('\n')
    );
    expect(parsed).toEqual({ ELEVENLABS_API_KEY: 'abc123', OPENROUTER_API_KEY: 'spaced' });
  });

  it('removes optional quotes and keeps what is inside them as it stands', () => {
    const parsed = parseEnvFile(
      [
        'DOUBLE="two words"',
        "SINGLE='it is # not a comment'",
        'HASH_IN_DOUBLE="a # b"',
        'WINDOWS="C:\\Users\\name\\.codex"',
        'TRAILING="value" # explained here',
        'EMPTY=""',
        'UNCLOSED="half'
      ].join('\n')
    );
    expect(parsed).toEqual({
      DOUBLE: 'two words',
      SINGLE: 'it is # not a comment',
      HASH_IN_DOUBLE: 'a # b',
      WINDOWS: 'C:\\Users\\name\\.codex',
      TRAILING: 'value',
      EMPTY: '',
      UNCLOSED: 'half'
    });
  });

  it('treats # as a comment only after whitespace in an unquoted value', () => {
    expect(parseEnvFile('A=value # note\nB=abc#def\nC=   padded   \nD=')).toEqual({ A: 'value', B: 'abc#def', C: 'padded', D: '' });
  });

  it('accepts an export prefix, Windows line endings and a byte order mark', () => {
    expect(parseEnvFile('\uFEFFexport FIRST=1\r\nSECOND="2"\r\n')).toEqual({ FIRST: '1', SECOND: '2' });
  });

  it('lets a later line override an earlier one', () => {
    expect(parseEnvFile('KEY=old\nKEY=new')).toEqual({ KEY: 'new' });
  });

  it('cannot be used to reach the object prototype', () => {
    const parsed = parseEnvFile('__proto__=polluted\nconstructor=x');
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    expect(Object.keys(parsed).sort()).toEqual(['__proto__', 'constructor']);
  });
});

describe('loadEnvFile', () => {
  it('returns nothing when there is no file, no directory, or a directory where the file should be', async () => {
    expect(loadEnvFile(home)).toEqual({});
    expect(loadEnvFile(join(home, 'does', 'not', 'exist'))).toEqual({});
    await mkdir(envFilePath(home));
    expect(loadEnvFile(home)).toEqual({});
  });

  it('reads <home>/.env', async () => {
    await writeFile(envFilePath(home), 'OPENAI_ADMIN_KEY="from the file"\n');
    expect(envFilePath(home)).toBe(join(home, '.env'));
    expect(loadEnvFile(home)).toEqual({ OPENAI_ADMIN_KEY: 'from the file' });
  });

  it('ignores a file far too large to be a list of keys', async () => {
    await writeFile(envFilePath(home), `KEY=${'x'.repeat(300 * 1024)}\n`);
    expect(loadEnvFile(home)).toEqual({});
  });
});

describe('mergedEnv', () => {
  it('fills in variables from the file underneath the real environment', async () => {
    await writeFile(envFilePath(home), 'FROM_FILE=file\nSHARED=file\n');
    const merged = mergedEnv({ SHARED: 'real', ONLY_REAL: 'real' }, home);
    expect(merged).toEqual({ FROM_FILE: 'file', SHARED: 'real', ONLY_REAL: 'real' });
  });

  it('lets a real variable win even when it is set to nothing', async () => {
    await writeFile(envFilePath(home), 'TOKENGATOR_TOKEN=from-the-file-0123456789\n');
    expect(mergedEnv({ TOKENGATOR_TOKEN: '' }, home)['TOKENGATOR_TOKEN']).toBe('');
    expect(mergedEnv({ TOKENGATOR_TOKEN: undefined }, home)['TOKENGATOR_TOKEN']).toBe('from-the-file-0123456789');
  });

  it('does not let the file move the home directory it was read from', async () => {
    await writeFile(envFilePath(home), 'TOKENGATOR_HOME=/somewhere/else\nTOKENGATOR_PORT=5000\n');
    expect(mergedEnv({}, home)).toEqual({ TOKENGATOR_PORT: '5000' });
    expect(mergedEnv({ TOKENGATOR_HOME: home }, home)['TOKENGATOR_HOME']).toBe(home);
  });

  it('treats names as case-insensitive on Windows, where the system does', async () => {
    await writeFile(envFilePath(home), 'elevenlabs_api_key=from-the-file\nTokengator_Home=/somewhere/else\n');
    const windows = mergedEnv({ tokengator_port: '5001', Path: 'C:\\Windows' }, home, 'win32');
    expect(windows).toEqual({ ELEVENLABS_API_KEY: 'from-the-file', TOKENGATOR_PORT: '5001', PATH: 'C:\\Windows' });
    // Elsewhere a differently spelled name is a different variable.
    expect(mergedEnv({ tokengator_port: '5001' }, home, 'linux')).toEqual({
      elevenlabs_api_key: 'from-the-file',
      Tokengator_Home: '/somewhere/else',
      tokengator_port: '5001'
    });
  });

  it('is the real environment unchanged when there is no file, and does not modify its input', () => {
    const real = { PATH: '/bin', EMPTY: '' };
    const merged = mergedEnv(real, home);
    expect(merged).toEqual(real);
    expect(merged).not.toBe(real);
  });
});

describe('liveEnv', () => {
  it('sees a key added to the file after it was created', async () => {
    const env = liveEnv({ REAL: 'real' }, home);
    expect(env['ELEVENLABS_API_KEY']).toBeUndefined();
    await writeFile(envFilePath(home), 'ELEVENLABS_API_KEY=first\n');
    expect(env['ELEVENLABS_API_KEY']).toBe('first');
    await writeFile(envFilePath(home), 'ELEVENLABS_API_KEY=second-and-longer\nREAL=file\n');
    expect(env['ELEVENLABS_API_KEY']).toBe('second-and-longer');
    expect(env['REAL']).toBe('real');
    await rm(envFilePath(home));
    expect(env['ELEVENLABS_API_KEY']).toBeUndefined();
  });

  it('behaves like a plain object of variables', async () => {
    await writeFile(envFilePath(home), 'FROM_FILE=file\n');
    const env = liveEnv({ REAL: 'real' }, home);
    expect(Object.keys(env).sort()).toEqual(['FROM_FILE', 'REAL']);
    expect({ ...env }).toEqual({ FROM_FILE: 'file', REAL: 'real' });
    expect('FROM_FILE' in env).toBe(true);
    expect('MISSING' in env).toBe(false);
    // Inherited members of Object.prototype are not variables.
    expect(env['toString']).toBeUndefined();
    expect(env['constructor']).toBeUndefined();
  });

  it('finds a variable whatever its case on Windows', async () => {
    await writeFile(envFilePath(home), 'OpenRouter_Api_Key=file\n');
    const env = liveEnv({ codex_home: 'C:\\codex' }, home, 'win32');
    expect(env['OPENROUTER_API_KEY']).toBe('file');
    expect(env['CODEX_HOME']).toBe('C:\\codex');
    expect(env['codex_home']).toBe('C:\\codex');
    expect(liveEnv({ codex_home: 'x' }, home, 'linux')['CODEX_HOME']).toBeUndefined();
  });
});
