import { describe, expect, it } from 'vitest';

import { IdempotencyStore } from '../src/core/idempotency-store.js';
import { ProtectedTabPolicy } from '../src/core/policy.js';
import { redact, REDACTED } from '../src/core/redaction.js';
import { RingBuffer } from '../src/core/ring-buffer.js';

describe('security and bounded state', () => {
  it('redacts headers, secrets, and bodies recursively', () => {
    const clean = redact({
      headers: { Authorization: 'Bearer abc', Cookie: 'sid=1', Accept: 'text/html' },
      api_key: 'abc',
      nested: { password: 'p', responseBody: 'private', safe: 3 }
    });
    expect(clean.headers.Authorization).toBe(REDACTED);
    expect(clean.headers.Cookie).toBe(REDACTED);
    expect(clean.headers.Accept).toBe('text/html');
    expect(clean.api_key).toBe(REDACTED);
    expect(clean.nested.password).toBe(REDACTED);
    expect(clean.nested.responseBody).toBe('[OMITTED]');
    expect(redact({ sessionId: 'mcp-session-secret' }).sessionId).toBe(REDACTED);
    expect(redact('Authorization: Bearer abc.def')).toBe('Authorization:[REDACTED]');
  });

  it('blocks protected URLs unless the agent is allowlisted', () => {
    const policy = new ProtectedTabPolicy(['bank.example/*'], new Set(['trusted']));
    expect(() => policy.assertMutationAllowed('https://bank.example/overview', 'other')).toThrowError(
      expect.objectContaining({ code: 'TAB_PROTECTED' })
    );
    expect(() => policy.assertMutationAllowed('https://bank.example/overview', 'trusted')).not.toThrow();
  });

  it('bounds ring buffers', () => {
    const ring = new RingBuffer<number>(2);
    ring.push(1);
    ring.push(2);
    ring.push(3);
    expect(ring.values()).toEqual([2, 3]);
  });

  it('replays identical idempotent work and rejects conflicting reuse', async () => {
    const store = new IdempotencyStore();
    let calls = 0;
    const first = await store.run('scope', 'key', 'fingerprint', async () => ++calls);
    const replay = await store.run('scope', 'key', 'fingerprint', async () => ++calls);
    expect([first, replay, calls]).toEqual([1, 1, 1]);
    await expect(store.run('scope', 'key', 'different', async () => 2)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT'
    });
  });
});
