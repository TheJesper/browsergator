// Logging goes to standard error only: standard output belongs to the stdio MCP protocol and to commands
// whose output is meant to be piped. Everything passes through `redact` first.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SECRET_PATTERNS: RegExp[] = [
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(sk|pk|rk|xi|or|ghp|gho|ghu|ghs|ghr|github_pat|glpat|AIza)[-_][A-Za-z0-9_-]{12,}/g,
  /\bsk-[A-Za-z0-9_-]{12,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g,
  /\b[A-Fa-f0-9]{40,}\b/g
];

const SECRET_KEYS = /(authorization|cookie|token|secret|password|api[-_]?key|credential)/i;

/** Removes anything that looks like a credential from a string. */
export function redact(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '[redacted]');
  return out;
}

function clean(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redact(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth > 3) return '[…]';
  if (Array.isArray(value)) return value.slice(0, 20).map((entry) => clean(entry, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEYS.test(key) ? '[redacted]' : clean(entry, depth + 1);
  }
  return out;
}

let threshold: LogLevel = (process.env['TOKENGATOR_LOG'] as LogLevel | undefined) ?? 'info';
if (!(threshold in LEVELS)) threshold = 'info';

export function setLogLevel(level: LogLevel): void {
  threshold = level;
}

export function log(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
  if (LEVELS[level] < LEVELS[threshold]) return;
  const line = {
    time: new Date().toISOString(),
    level,
    message: redact(message),
    ...(fields ? (clean(fields) as Record<string, unknown>) : {})
  };
  process.stderr.write(`${JSON.stringify(line)}\n`);
}
