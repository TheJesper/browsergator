import { redact } from './redaction.js';

export function log(level: 'info' | 'warn' | 'error', message: string, data?: unknown): void {
  const entry = redact({ timestamp: new Date().toISOString(), level, message, ...(data ? { data } : {}) });
  process.stderr.write(`${JSON.stringify(entry)}\n`);
}
