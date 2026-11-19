// The optional environment file, <home>/.env. It is where a person keeps provider keys for collectors
// without exporting them in every shell. Values are handed to whoever asks for a variable by name and
// are never logged, echoed or returned by any interface.

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { decodeText } from './files.js';

/** Anything larger is not a hand-written list of keys. */
const MAX_ENV_FILE_BYTES = 256 * 1024;
const ASSIGNMENT = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

/**
 * The file lives inside the home directory, so it cannot be allowed to say where the home directory is:
 * the state would then be read from one place and the keys from another.
 */
const NOT_FROM_FILE = new Set(['TOKENGATOR_HOME']);

export function envFilePath(home: string): string {
  return join(home, '.env');
}

function unquote(raw: string): string {
  const value = raw.trim();
  const quote = value[0];
  if (quote === '"' || quote === "'") {
    // The text between the quotes is taken as it stands, with no escape sequences: a Windows path such
    // as "C:\Users\name" would otherwise lose its backslashes. Whatever follows the closing quote is a
    // comment. Without a closing quote the text is kept as typed rather than the line being dropped.
    const close = value.indexOf(quote, 1);
    return close < 0 ? value.slice(1) : value.slice(1, close);
  }
  // Unquoted: a `#` after whitespace starts a comment; one inside a word is part of the value.
  const comment = value.search(/\s#/);
  return (comment < 0 ? value : value.slice(0, comment)).trim();
}

/** Parses `KEY=VALUE` lines. Blank lines, `#` comments and lines that are not assignments are skipped. */
export function parseEnvFile(text: string): Record<string, string> {
  const found = new Map<string, string>();
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = ASSIGNMENT.exec(trimmed);
    if (!match) continue;
    found.set(match[1] as string, unquote(match[2] ?? ''));
  }
  // fromEntries defines own properties, so a line such as `__proto__=x` cannot reach the prototype.
  return Object.fromEntries(found);
}

/** Reads <home>/.env. Never throws: a missing, unreadable or oversized file is the same as an empty one. */
export function loadEnvFile(home: string): Record<string, string> {
  try {
    const path = envFilePath(home);
    const info = statSync(path);
    if (!info.isFile() || info.size > MAX_ENV_FILE_BYTES) return {};
    return parseEnvFile(decodeText(readFileSync(path)));
  } catch {
    return {};
  }
}

/**
 * Windows treats NAME and name as one variable and process.env honours that, but the merged copy is a
 * plain object and would not. Names are therefore folded to upper case there, which is how every
 * variable Tokengator reads is spelled.
 */
function fold(name: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? name.toUpperCase() : name;
}

function merge(processEnv: NodeJS.ProcessEnv, file: Record<string, string>, platform: NodeJS.Platform): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(file)) {
    if (!NOT_FROM_FILE.has(fold(name, platform))) merged[fold(name, platform)] = value;
  }
  // A variable that is set in the real environment wins, even when it is set to nothing: that is how a
  // person switches a key off for one run.
  for (const [name, value] of Object.entries(processEnv)) {
    if (value !== undefined) merged[fold(name, platform)] = value;
  }
  return merged;
}

/** The process environment with the file's variables filled in underneath it, as of now. */
export function mergedEnv(processEnv: NodeJS.ProcessEnv, home: string, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  return merge(processEnv, loadEnvFile(home), platform);
}

function fingerprint(home: string): string {
  try {
    const info = statSync(envFilePath(home));
    return `${info.mtimeMs}:${info.size}`;
  } catch {
    return '';
  }
}

/** Own string properties only, so `env.toString` is not mistaken for a variable. */
function own(env: NodeJS.ProcessEnv, name: string | symbol): string | undefined {
  return typeof name === 'string' && Object.hasOwn(env, name) ? env[name] : undefined;
}

/**
 * Like `mergedEnv`, but every lookup sees the file as it is at that moment. A long-running service hands
 * this to its collectors, so a key added to the file works on the next run instead of after a restart.
 * The file is only read again when its size or modification time has changed.
 */
export function liveEnv(processEnv: NodeJS.ProcessEnv, home: string, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  let seen = fingerprint(home);
  let current = merge(processEnv, loadEnvFile(home), platform);
  const fresh = (): NodeJS.ProcessEnv => {
    const now = fingerprint(home);
    if (now !== seen) {
      seen = now;
      current = merge(processEnv, loadEnvFile(home), platform);
    }
    return current;
  };
  const lookup = (name: string | symbol): string | undefined => own(fresh(), typeof name === 'string' ? fold(name, platform) : name);
  return new Proxy<NodeJS.ProcessEnv>(
    {},
    {
      get: (_target, name) => lookup(name),
      has: (_target, name) => lookup(name) !== undefined,
      ownKeys: () => Object.keys(fresh()),
      getOwnPropertyDescriptor: (_target, name) => {
        const value = lookup(name);
        return value === undefined ? undefined : { value, enumerable: true, configurable: true, writable: false };
      }
    }
  );
}
