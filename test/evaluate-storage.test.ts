import { beforeEach, describe, expect, it } from 'vitest';

import { BrowserGateway } from '../src/gateway.js';
import { MemoryAuditLog } from '../src/core/audit-log.js';
import { EnvironmentPolicy } from '../src/core/environment.js';
import { MockBrowserDriver, mockTab } from './helpers/mock-browser-driver.js';
import { testConfig } from './helpers/config.js';

const ctx = (agentId = 'a') => ({
  context: { agentId, taskId: '1', leaseOwnerId: `owner-${agentId}`, clientSessionId: 's1' }
});

describe('EnvironmentPolicy classification', () => {
  const env = new EnvironmentPolicy();

  it('should classify loopback hosts as local with no confirm needed', () => {
    for (const url of ['http://localhost:1337/x', 'http://127.0.0.1:9000/y']) {
      const d = env.classify(url);
      expect(d.tier).toBe('local');
      expect(d.writeNeedsConfirm).toBe(false);
    }
  });

  it('should classify shared test hosts as test with confirm needed', () => {
    for (const url of ['https://ci.example.net/', 'https://app-qa-1.example.net/', 'https://iot1.example.net/']) {
      const d = env.classify(url);
      expect(d.tier).toBe('test');
      expect(d.writeNeedsConfirm).toBe(true);
    }
  });

  it('should classify production hosts as prod with confirm needed', () => {
    const d = env.classify('https://prod.example.net/');
    expect(d.tier).toBe('prod');
    expect(d.writeNeedsConfirm).toBe(true);
  });

  it('should not false-match a token embedded in a larger word', () => {
    // "reproduce" contains "prod" but not as a token boundary
    const d = env.classify('https://reproduce.example.net/');
    expect(d.tier).toBe('remote');
  });
});

describe('BrowserGateway evaluate + storage gating', () => {
  let driver: MockBrowserDriver;
  let gateway: BrowserGateway;

  beforeEach(async () => {
    driver = new MockBrowserDriver([
      mockTab('local', 'http://localhost:1337/positioning'),
      mockTab('prod', 'https://prod.example.net/app')
    ]);
    gateway = new BrowserGateway(testConfig(), driver, new MemoryAuditLog());
    await gateway.start();
  });

  it('should allow read-only evaluate on any environment without confirm', async () => {
    driver.defaultEvaluateResult = 42;
    const res = await gateway.evaluate('prod', '1+1', { write: false, confirm: false }, ctx());
    expect(res.value).toBe(42);
    expect(res.environment.tier).toBe('prod');
  });

  it('should allow write evaluate on local without confirm', async () => {
    driver.defaultEvaluateResult = 'ok';
    const res = await gateway.evaluate('local', 'document.title="x"', { write: true, confirm: false }, ctx());
    expect(res.value).toBe('ok');
    expect(res.environment.tier).toBe('local');
  });

  it('should block write evaluate on prod without confirm', async () => {
    await expect(
      gateway.evaluate('prod', 'document.title="x"', { write: true, confirm: false }, ctx())
    ).rejects.toMatchObject({ code: 'WRITE_CONFIRM_REQUIRED' });
  });

  it('should allow write evaluate on prod with confirm=true', async () => {
    driver.defaultEvaluateResult = 'done';
    const res = await gateway.evaluate('prod', 'document.title="x"', { write: true, confirm: true }, ctx());
    expect(res.value).toBe('done');
  });

  it('should redact secrets in evaluate output', async () => {
    driver.defaultEvaluateResult = { token: 'super-secret-value', keep: 'visible' };
    const res = await gateway.evaluate('local', 'x', { write: false, confirm: false }, ctx());
    expect(res.value).toMatchObject({ token: '[REDACTED]', keep: 'visible' });
  });

  it('should read storage and omit cookies unless requested', async () => {
    driver.storage = { local: { a: '1' }, session: { b: '2' }, cookies: 'sid=abc' };

    const withoutCookies = await gateway.readStorage('local', { cookies: false });
    expect(withoutCookies.local).toEqual({ a: '1' });
    expect(withoutCookies.cookies).toBe('[OMITTED]');

    const withCookies = await gateway.readStorage('local', { cookies: true });
    // cookie string goes through redaction (matches sensitive "cookie"/"sid" -> string redactor leaves plain value,
    // but the key-based omission only applies to object keys; the raw string is returned)
    expect(withCookies.cookies).toContain('sid=');
  });
});
