import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Minimal, dependency-free `.env` loader.
 *
 * Semantics match dotenv's defaults: values from `.env` populate `process.env`
 * only for keys that are not already set, so a pre-existing (real) environment
 * variable always wins. Missing or unreadable `.env` is non-fatal.
 */
export function loadDotenv(
  path: string = resolve(process.cwd(), '.env'),
  env: NodeJS.ProcessEnv = process.env
): void {
  let contents: string;
  try {
    contents = readFileSync(path, 'utf8');
  } catch {
    // No .env file (or unreadable) -- fine, start with ambient env.
    return;
  }

  for (const [key, value] of parseDotenv(contents)) {
    // Existing env wins: never override an already-set variable.
    if (env[key] === undefined) {
      env[key] = value;
    }
  }
}

/**
 * Parse `.env` text into key/value pairs. Supports `KEY=value`, `export KEY=value`,
 * `#` comments, blank lines, and single/double-quoted values. Returns entries in
 * file order; later duplicates are ignored by the caller via the `??=` semantics.
 */
export function parseDotenv(contents: string): ReadonlyArray<readonly [string, string]> {
  const entries: Array<readonly [string, string]> = [];

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    const withoutExport = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
    const eq = withoutExport.indexOf('=');
    if (eq === -1) continue;

    const key = withoutExport.slice(0, eq).trim();
    if (key === '') continue;

    let value = withoutExport.slice(eq + 1).trim();
    value = stripQuotes(value);
    entries.push([key, value] as const);
  }

  return entries;
}

function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}
