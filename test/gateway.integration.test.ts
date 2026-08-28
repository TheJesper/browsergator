import { beforeEach, describe, expect, it } from 'vitest';

import { BrowserGateway } from '../src/gateway.js';
import { MemoryAuditLog } from '../src/core/audit-log.js';
import { MockBrowserDriver, mockTab } from './helpers/mock-browser-driver.js';
import { testConfig } from './helpers/config.js';

describe('BrowserGateway integration with mock CDP', () => {
  let driver: MockBrowserDriver;
  let gateway: BrowserGateway;

  beforeEach(async () => {
    driver = new MockBrowserDriver([mockTab('p1'), mockTab('p2')]);
    gateway = new BrowserGateway(testConfig(), driver, new MemoryAuditLog());
    await gateway.start();
  });

  it('runs different tabs in parallel and same-tab mutations FIFO', async () => {
    driver.navigationDelayMs = 40;
    const a = {
      context: { agentId: 'a', taskId: '1', leaseOwnerId: 'owner-a', clientSessionId: 's1' }
    };
    const b = {
      context: { agentId: 'b', taskId: '2', leaseOwnerId: 'owner-b', clientSessionId: 's2' }
    };

    await Promise.all([
      gateway.navigate('p1', 'https://one.example/', { waitUntil: 'load', timeoutMs: 1_000 }, a),
      gateway.navigate('p2', 'https://two.example/', { waitUntil: 'load', timeoutMs: 1_000 }, b)
    ]);
    expect(driver.maxActiveGlobal).toBe(2);

    driver.maxActiveGlobal = 0;
    driver.maxActiveByPage.clear();
    await Promise.all([
      gateway.navigate('p1', 'https://first.example/', { waitUntil: 'load', timeoutMs: 1_000 }, a),
      gateway.navigate('p1', 'https://second.example/', { waitUntil: 'load', timeoutMs: 1_000 }, b)
    ]);
    expect(driver.maxActiveByPage.get('p1')).toBe(1);
    expect(driver.tabs.get('p1')?.url).toBe('https://second.example/');
  });

  it('does not hold reads behind a mutation', async () => {
    driver.navigationDelayMs = 100;
    const mutation = gateway.navigate(
      'p1',
      'https://slow.example/',
      { waitUntil: 'load', timeoutMs: 1_000 },
      { context: { agentId: 'a', taskId: '1', leaseOwnerId: 'owner-a', clientSessionId: 's1' } }
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    const before = Date.now();
    await gateway.snapshot('p1', 100);
    expect(Date.now() - before).toBeLessThan(50);
    await mutation;
  });

  it('enforces protected tabs and recovers after a mock disconnect', async () => {
    const beforeReconnect = (await gateway.listTabs())[0];
    expect(beforeReconnect).toMatchObject({
      browserSessionId: 'mock-browser-session-1',
      browserContextId: 'default'
    });
    driver.tabs.set('protected', mockTab('protected', 'https://example.com/login'));
    await expect(
      gateway.navigate(
        'protected',
        'https://example.com/',
        { waitUntil: 'load', timeoutMs: 1_000 },
        { context: { agentId: 'a', taskId: '1', leaseOwnerId: 'owner-a', clientSessionId: 's1' } }
      )
    ).rejects.toMatchObject({ code: 'TAB_PROTECTED' });
    await expect(
      gateway.navigate(
        'p1',
        'https://shop.example/checkout',
        { waitUntil: 'load', timeoutMs: 1_000 },
        { context: { agentId: 'a', taskId: '1', leaseOwnerId: 'owner-a', clientSessionId: 's1' } }
      )
    ).rejects.toMatchObject({ code: 'TAB_PROTECTED' });

    driver.disconnect();
    await expect(gateway.listTabs()).rejects.toMatchObject({ code: 'BROWSER_DISCONNECTED' });
    driver.reconnect();
    await expect(gateway.listTabs()).resolves.toHaveLength(3);
    expect((await gateway.listTabs())[0]?.browserSessionId).toBe('mock-browser-session-2');
  });

  it('releases leases when an MCP session disappears', async () => {
    const context = {
      agentId: 'a',
      taskId: '1',
      leaseOwnerId: 'owner-a',
      clientSessionId: 'gone'
    };
    const claimed = await gateway.claimTab('p1', context);
    expect(claimed).not.toHaveProperty('clientSessionId');
    expect((await gateway.listTabs('a')).find((tab) => tab.pageId === 'p1')?.lease).not.toHaveProperty(
      'clientSessionId'
    );
    expect(gateway.leases.get('p1')).toBeDefined();
    await gateway.releaseClientSession('gone');
    expect(gateway.leases.get('p1')).toBeUndefined();
  });

  it('runs an idempotent atomic navigate and verification', async () => {
    const input = {
      pageId: 'p1',
      context: {
        agentId: 'a',
        taskId: '1',
        leaseOwnerId: 'owner-a',
        clientSessionId: 's1'
      },
      idempotencyKey: 'atomic-1',
      action: {
        type: 'navigate' as const,
        url: 'https://atomic.example/path',
        waitUntil: 'load' as const,
        timeoutMs: 1_000
      },
      verify: { urlContains: 'atomic.example', titleContains: 'atomic.example' }
    };
    const first = await gateway.runAtomic(input);
    const replay = await gateway.runAtomic({
      ...input,
      context: { ...input.context, clientSessionId: 'reconnected-session' }
    });
    expect(first).toEqual(replay);
    expect(driver.navigationOrder.filter((entry) => entry.includes(':start:'))).toHaveLength(1);
    expect(gateway.leases.get('p1')).toBeUndefined();
  });

  it('redacts observed network headers and retrieves a retained response body', async () => {
    const context = {
      agentId: 'a',
      taskId: '1',
      leaseOwnerId: 'owner-a',
      clientSessionId: 's1'
    };
    await gateway.navigate(
      'p1',
      'https://body.example/',
      { waitUntil: 'load', timeoutMs: 1_000 },
      { context }
    );
    const events = gateway.networkList('p1');
    const request = events.find((event) => event.method === 'Network.requestWillBeSent');
    const requestData = request?.data['request'] as Record<string, unknown> | undefined;
    const headers = requestData?.['headers'] as Record<string, unknown> | undefined;
    expect(headers?.['Authorization']).toBe('[REDACTED]');
    const requestId = request?.data['requestId'];
    expect(typeof requestId).toBe('string');
    await expect(gateway.getResponseBody('p1', String(requestId), context)).resolves.toMatchObject({
      base64Encoded: false,
      truncated: false
    });
    await expect(gateway.getResponseBody('p1', 'unknown', context)).rejects.toMatchObject({
      code: 'RESPONSE_BODY_UNAVAILABLE'
    });
  });
});
