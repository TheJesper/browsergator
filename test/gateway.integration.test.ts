import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BrowserGateway } from '../src/gateway.js';
import { MemoryAuditLog } from '../src/core/audit-log.js';
import { MockBrowserDriver, mockTab } from './helpers/mock-browser-driver.js';
import { testConfig } from './helpers/config.js';

function emitDocument(driver: MockBrowserDriver, pageId: string, url: string,
  { frameId = 'main', loaderId = 'loader', requestId = 'document', parentId, status = 200 }:
  { frameId?: string; loaderId?: string; requestId?: string; parentId?: string; status?: number } = {}) {
  const documentUrl = new URL(url);
  documentUrl.hash = '';
  driver.emit({ timestamp: new Date().toISOString(), kind: 'lifecycle', method: 'Page.frameNavigated', pageId,
    data: { frame: { id: frameId, loaderId, url, ...(parentId ? { parentId } : {}) } } });
  driver.emit({ timestamp: new Date().toISOString(), kind: 'network', method: 'Network.requestWillBeSent', pageId,
    data: { type: 'Document', frameId, loaderId, requestId, request: { url: documentUrl.href } } });
  driver.emit({ timestamp: new Date().toISOString(), kind: 'network', method: 'Network.responseReceived', pageId,
    data: { type: 'Document', frameId, loaderId, requestId,
      response: { url: documentUrl.href, status, mimeType: 'text/html', headers: { 'content-type': 'text/html; charset=utf-8' } } } });
}

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

  it('serializes click and fill mutations through the per-tab lease', async () => {
    const context = {
      context: { agentId: 'a', taskId: 'interaction', leaseOwnerId: 'owner-a', clientSessionId: 's1' }
    };
    await expect(gateway.click('p1', { selector: 'a', text: 'Köp' }, context)).resolves.toMatchObject({
      action: 'click',
      pageId: 'p1'
    });
    await expect(gateway.fill('p1', { selector: '#amount' }, '500', context)).resolves.toMatchObject({
      action: 'fill',
      pageId: 'p1'
    });
  });

  it('supports the interaction primitives through the shared gateway', async () => {
    const metadata = {
      context: { agentId: 'a', taskId: 'interaction-2', leaseOwnerId: 'owner-a', clientSessionId: 's1' }
    };
    await expect(gateway.waitFor('p1', { selector: '#ready', timeoutMs: 100 })).resolves.toMatchObject({ pageId: 'p1' });
    await expect(gateway.pressKey('p1', 'Enter', metadata)).resolves.toMatchObject({ key: 'Enter' });
    await expect(gateway.typeText('p1', 'hello', metadata)).resolves.toMatchObject({ textLength: 5 });
    await expect(gateway.hover('p1', { selector: '#menu' }, metadata)).resolves.toMatchObject({ action: 'hover' });
    await expect(gateway.clickAt('p1', 10, 20, metadata)).resolves.toMatchObject({ x: 10, y: 20 });
    await expect(gateway.drag('p1', { selector: '#from' }, { selector: '#to' }, metadata)).resolves.toMatchObject({ action: 'drag' });
    await expect(gateway.handleDialog('p1', true, undefined, metadata)).resolves.toMatchObject({ accepted: true });
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

  it('fetches a rendered document through one owned temporary page and receipts its content', async () => {
    const html = '<html><body><main>Rendered menu</main></body></html>';
    driver.evaluateResults.set('({url:location.href,readyState:document.readyState})', {
      url: 'https://menu.example/lunch', readyState: 'complete'
    });
    driver.defaultEvaluateResult = {
      url: 'https://menu.example/lunch',
      title: 'Lunch',
      html
    };
    const navigate = driver.navigate.bind(driver);
    driver.navigate = async (pageId, url, options) => {
      const result = await navigate(pageId, url, options);
      emitDocument(driver, pageId, url);
      return result;
    };
    const before = (await gateway.listTabs()).map((tab) => tab.pageId);
    const result = await gateway.fetchRenderedPage(
      'https://menu.example/lunch',
      { timeoutMs: 1_000, maxBytes: 1_024 },
      { context: { agentId: 'fetcher', taskId: 'fetch-1', leaseOwnerId: 'owner-1', clientSessionId: 's1' } }
    );
    expect(result).toMatchObject({
      requestedUrl: 'https://menu.example/lunch',
      finalUrl: 'https://menu.example/lunch',
      title: 'Lunch',
      html,
      contentBytes: Buffer.byteLength(html),
      statusCode: 200,
      contentType: 'text/html; charset=utf-8'
    });
    expect(result.contentSha256).toMatch(/^[a-f0-9]{64}$/);
    expect((await gateway.listTabs()).map((tab) => tab.pageId)).toEqual(before);
    expect(gateway.leases.get('page-1')).toBeUndefined();
  });

  it('opens only a blank target, awaits settled navigation once, then captures the SPA', async () => {
    const requested = 'https://menu.example/#/store-listing';
    const html = '<html><body><main>Hydrated menu</main></body></html>';
    const opened: string[] = [];
    const open = driver.openTab.bind(driver);
    driver.openTab = async (url) => { opened.push(url); return open(url); };
    const navigate = driver.navigate.bind(driver);
    const navigations: Array<{ waitUntil: string; timeoutMs: number }> = [];
    driver.navigate = async (pageId, url, options) => {
      expect(gateway.leases.get(pageId)).toBeDefined();
      navigations.push(options);
      const result = await navigate(pageId, url, options);
      driver.defaultEvaluateResult = { url, title: 'Menu', html };
      emitDocument(driver, pageId, url);
      // Same-URL subframe response must not override the main document.
      emitDocument(driver, pageId, url, { frameId: 'child', parentId: 'main', loaderId: 'child-load', requestId: 'child-doc', status: 451 });
      return result;
    };
    const result = await gateway.fetchRenderedPage(requested, { timeoutMs: 1_000, maxBytes: 1_024 },
      { context: { agentId: 'fetcher', taskId: 'spa', leaseOwnerId: 'owner-spa', clientSessionId: 's1' } });
    expect(opened).toEqual(['about:blank']);
    expect(navigations).toHaveLength(1);
    expect(navigations[0]).toMatchObject({ waitUntil: 'networkidle' });
    expect(navigations[0]!.timeoutMs).toBeLessThanOrEqual(1_000);
    expect(result).toMatchObject({ requestedUrl: requested, finalUrl: requested, html, statusCode: 200 });
    expect((await gateway.listTabs()).map((tab) => tab.pageId)).toEqual(['p1', 'p2']);
  });

  it('does not infer main-document metadata from only a same-URL subframe', async () => {
    const url = 'https://menu.example/lunch';
    driver.defaultEvaluateResult = { url, title: 'Menu', html: '<html><body>Menu</body></html>' };
    const navigate = driver.navigate.bind(driver);
    driver.navigate = async (pageId, target, options) => {
      const result = await navigate(pageId, target, options);
      emitDocument(driver, pageId, url, { frameId: 'child', parentId: 'main' });
      return result;
    };
    const result = await gateway.fetchRenderedPage(url, { timeoutMs: 1_000, maxBytes: 1_024 },
      { context: { agentId: 'fetcher', taskId: 'child-only', leaseOwnerId: 'owner-child', clientSessionId: 's1' } });
    expect(result.statusCode).toBeNull();
    expect(result.contentType).toBeNull();
  });

  it('does not restart the original timeout after opening or accept a late settled result', async () => {
    let now = 1_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const open = driver.openTab.bind(driver);
    driver.openTab = async (url) => { now += 40; return open(url); };
    const navigate = driver.navigate.bind(driver);
    driver.navigate = async (pageId, url, options) => {
      expect(options.timeoutMs).toBe(60);
      const result = await navigate(pageId, url, options);
      now += 61;
      return result;
    };
    try {
      await expect(gateway.fetchRenderedPage('https://menu.example/lunch', { timeoutMs: 100, maxBytes: 1_024 },
        { context: { agentId: 'fetcher', taskId: 'deadline', leaseOwnerId: 'owner-time', clientSessionId: 's1' } }
      )).rejects.toMatchObject({ code: 'WAIT_TIMEOUT' });
      expect(driver.navigationOrder.filter((entry) => entry.includes(':start:'))).toHaveLength(1);
      expect((await gateway.listTabs()).map((tab) => tab.pageId)).toEqual(['p1', 'p2']);
    } finally {
      clock.mockRestore();
    }
  });

  it('waits past an initial blank document and accepts a committed redirect', async () => {
    const html = '<html><body><main>Redirected menu</main></body></html>';
    const readinessExpression = '({url:location.href,readyState:document.readyState})';
    let readinessReads = 0;
    const evaluate = driver.evaluate.bind(driver);
    driver.evaluate = async (pageId, expression) => {
      if (expression === readinessExpression) {
        readinessReads += 1;
        if (readinessReads === 1) return { url: 'about:blank', readyState: 'complete' };
        const tab = driver.tabs.get(pageId)!;
        tab.url = 'https://menu.example/current-week';
        tab.title = 'Current week';
        return { url: tab.url, readyState: 'interactive' };
      }
      if (expression.includes('document.documentElement.outerHTML')) {
        return { url: 'https://menu.example/current-week', title: 'Current week', html };
      }
      return evaluate(pageId, expression);
    };
    const result = await gateway.fetchRenderedPage(
      'https://menu.example/lunch',
      { timeoutMs: 1_000, maxBytes: 1_024 },
      { context: { agentId: 'fetcher', taskId: 'fetch-redirect', leaseOwnerId: 'owner-redirect', clientSessionId: 's1' } }
    );
    expect(readinessReads).toBe(2);
    expect(result.finalUrl).toBe('https://menu.example/current-week');
    expect(result.html).toBe(html);
  });

  it('reports unknown cleanup when an allowed request redirects to a protected URL', async () => {
    const protectedDriver = new MockBrowserDriver([mockTab('p1'), mockTab('p2')]);
    const audit = new MemoryAuditLog();
    const protectedGateway = new BrowserGateway(
      testConfig({ protectedPatterns: ['*/secure*'] }), protectedDriver, audit
    );
    await protectedGateway.start();
    const finalUrl = 'https://menu.example/secure/redirect-target';
    const html = '<html><body>Redirected content</body></html>';
    protectedDriver.defaultEvaluateResult = { url: finalUrl, title: 'Redirected', html };
    const navigate = protectedDriver.navigate.bind(protectedDriver);
    protectedDriver.navigate = async (pageId, url, options) => {
      const result = await navigate(pageId, url, options);
      protectedDriver.tabs.get(pageId)!.url = finalUrl;
      emitDocument(protectedDriver, pageId, finalUrl);
      return { ...result, url: finalUrl, title: 'Redirected' };
    };

    await expect(protectedGateway.fetchRenderedPage(
      'https://menu.example/public-menu',
      { timeoutMs: 1_000, maxBytes: 1_024 },
      { context: { agentId: 'fetcher', taskId: 'redirect-cleanup', leaseOwnerId: 'owner-cleanup', clientSessionId: 's1' } }
    )).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      details: { pageId: 'page-1', cleanup: 'unknown', closeErrorCode: 'TAB_PROTECTED' }
    });

    expect((await protectedGateway.listTabs()).map((tab) => tab.pageId).sort())
      .toEqual(['p1', 'p2', 'page-1']);
    expect(audit.events).toContainEqual(expect.objectContaining({
      action: 'fetch_rendered_page_cleanup', outcome: 'error', pageId: 'page-1', errorCode: 'INTERNAL_ERROR'
    }));
  });

  it('fails closed when the temporary target remains about:blank', async () => {
    driver.evaluateResults.set('({url:location.href,readyState:document.readyState})', {
      url: 'about:blank', readyState: 'complete'
    });
    await expect(gateway.fetchRenderedPage(
      'https://menu.example/lunch',
      { timeoutMs: 20, maxBytes: 1_024 },
      { context: { agentId: 'fetcher', taskId: 'fetch-blank-timeout', leaseOwnerId: 'owner-blank', clientSessionId: 's1' } }
    )).rejects.toMatchObject({ code: 'WAIT_TIMEOUT' });
    expect((await gateway.listTabs()).map((tab) => tab.pageId)).toEqual(['p1', 'p2']);
    expect(gateway.leases.get('page-1')).toBeUndefined();
  });

  it('rejects a final snapshot that regresses to about:blank', async () => {
    const readinessExpression = '({url:location.href,readyState:document.readyState})';
    driver.evaluateResults.set(readinessExpression, {
      url: 'https://menu.example/lunch', readyState: 'complete'
    });
    driver.defaultEvaluateResult = {
      url: 'about:blank', title: '', html: '<html><head></head><body></body></html>'
    };
    await expect(gateway.fetchRenderedPage(
      'https://menu.example/lunch',
      { timeoutMs: 1_000, maxBytes: 1_024 },
      { context: { agentId: 'fetcher', taskId: 'fetch-regressed', leaseOwnerId: 'owner-regressed', clientSessionId: 's1' } }
    )).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    expect((await gateway.listTabs()).map((tab) => tab.pageId)).toEqual(['p1', 'p2']);
  });

  it('refuses oversized rendered fetches and still closes its temporary page', async () => {
    driver.evaluateResults.set('({url:location.href,readyState:document.readyState})', {
      url: 'https://menu.example/lunch', readyState: 'complete'
    });
    driver.defaultEvaluateResult = {
      url: 'https://menu.example/lunch', title: 'Lunch', html: '<html>too large</html>'
    };
    await expect(gateway.fetchRenderedPage(
      'https://menu.example/lunch',
      { timeoutMs: 1_000, maxBytes: 4 },
      { context: { agentId: 'fetcher', taskId: 'fetch-2', leaseOwnerId: 'owner-2', clientSessionId: 's2' } }
    )).rejects.toMatchObject({ code: 'FETCH_BODY_TOO_LARGE' });
    expect((await gateway.listTabs()).map((tab) => tab.pageId)).toEqual(['p1', 'p2']);
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
