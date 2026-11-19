// A small argument parser: `--flag`, `--flag=value`, `--flag value`, single-letter aliases, positionals
// and `--` passthrough. Each command declares the flags it knows, because without that declaration
// `--port 4777` and `--json 4777` cannot be told apart.

export interface ArgSpec {
  /** Flags that take a value: `--port 4777` or `--port=4777`. */
  values?: readonly string[];
  /** Flags that are on when present and take no value. */
  switches?: readonly string[];
  /** Single-letter aliases, for example `{ h: 'help' }`. */
  short?: Readonly<Record<string, string>>;
}

export interface ParsedArgs {
  positionals: string[];
  /** Value flags by name. The last occurrence wins. */
  values: Map<string, string>;
  switches: Set<string>;
  /** Everything after a bare `--`, untouched. */
  rest: string[];
}

/** A mistake in how the command was typed, as opposed to a failure while running it. */
export class ArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArgError';
  }
}

export function parseArgs(argv: readonly string[], spec: ArgSpec = {}): ParsedArgs {
  const valueFlags = new Set(spec.values ?? []);
  const switchFlags = new Set(spec.switches ?? []);
  const parsed: ParsedArgs = { positionals: [], values: new Map(), switches: new Set(), rest: [] };

  const accept = (name: string, inline: string | undefined, written: string, index: number): number => {
    if (valueFlags.has(name)) {
      if (inline !== undefined) {
        parsed.values.set(name, inline);
        return index;
      }
      const next = argv[index + 1];
      // A following `--something` is the next flag, not this one's value. A single dash is allowed so
      // that a negative number or `-` (standard input) can be a value.
      if (next === undefined || next.startsWith('--')) throw new ArgError(`${written} needs a value.`);
      parsed.values.set(name, next);
      return index + 1;
    }
    if (switchFlags.has(name)) {
      if (inline !== undefined) throw new ArgError(`${written} does not take a value.`);
      parsed.switches.add(name);
      return index;
    }
    throw new ArgError(`Unknown option ${written}.`);
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (token === '--') {
      parsed.rest = argv.slice(index + 1);
      break;
    }
    if (token.startsWith('--')) {
      const equals = token.indexOf('=');
      const name = equals < 0 ? token.slice(2) : token.slice(2, equals);
      const inline = equals < 0 ? undefined : token.slice(equals + 1);
      index = accept(name, inline, `--${name}`, index);
      continue;
    }
    // Only a dash followed by one letter is a short flag: `-` and `-5` stay ordinary words.
    if (/^-[A-Za-z]$/.test(token)) {
      const name = spec.short?.[token.slice(1)];
      if (name === undefined) throw new ArgError(`Unknown option ${token}.`);
      index = accept(name, undefined, token, index);
      continue;
    }
    parsed.positionals.push(token);
  }
  return parsed;
}

/** A whole number within bounds from a value flag, or an ArgError that names the flag. */
export function integerFlag(parsed: ParsedArgs, name: string, min: number, max: number): number | undefined {
  const raw = parsed.values.get(name);
  if (raw === undefined) return undefined;
  const value = /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ArgError(`--${name} must be a whole number from ${min} to ${max}, got "${raw}".`);
  }
  return value;
}
