import { afterEach, describe, expect, it, vi } from 'vitest';

import { log } from '../src/core/logger.js';

function captureStderr(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    lines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
    return true;
  });
  return { lines, restore: () => spy.mockRestore() };
}

describe('log level gating', () => {
  afterEach(() => vi.restoreAllMocks());

  it('should suppress debug output at the default (info) level', () => {
    const { lines, restore } = captureStderr();
    try {
      log('debug', 'quiet detail');
    } finally {
      restore();
    }
    expect(lines).toHaveLength(0);
  });

  it('should emit info and warn at the default level', () => {
    const { lines, restore } = captureStderr();
    try {
      log('info', 'visible info');
      log('warn', 'visible warn');
    } finally {
      restore();
    }
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('visible info');
    expect(lines[1]).toContain('visible warn');
  });

  it('should still redact sensitive fields when emitting', () => {
    const { lines, restore } = captureStderr();
    try {
      log('warn', 'auth attempt', { token: 'super-secret-value' });
    } finally {
      restore();
    }
    expect(lines[0]).toContain('[REDACTED]');
    expect(lines[0]).not.toContain('super-secret-value');
  });
});
