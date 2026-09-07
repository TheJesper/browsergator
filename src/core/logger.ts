import { redact } from './redaction.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function resolveMinLevel(): LogLevel {
  const raw = (process.env['BROWSER_GATEWAY_LOG_LEVEL'] ?? '').toLowerCase();
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') return raw;
  // Back-compat: BROWSER_GATEWAY_DEBUG=1 flips on debug output.
  if (process.env['BROWSER_GATEWAY_DEBUG'] === '1') return 'debug';
  return 'info';
}

// Resolved once at import; the process is long-lived and level is set at launch.
const minLevel = resolveMinLevel();

export function log(level: LogLevel, message: string, data?: unknown): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
  const entry = redact({ timestamp: new Date().toISOString(), level, message, ...(data ? { data } : {}) });
  process.stderr.write(`${JSON.stringify(entry)}\n`);
}
