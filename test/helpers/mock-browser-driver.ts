import { EventEmitter } from 'node:events';

import { GatewayError } from '../../src/errors.js';
import type {
  AccessibilitySnapshot,
  BrowserConnectionStatus,
  BrowserDriver,
  BrowserEvent,
  DriverTab,
  NavigationOptions,
  NavigationResult,
  ResponseBodyResult,
  ScreenshotResult
} from '../../src/types.js';

export class MockBrowserDriver implements BrowserDriver {
  readonly tabs = new Map<string, DriverTab>();
  readonly navigationOrder: string[] = [];
  readonly activeByPage = new Map<string, number>();
  readonly maxActiveByPage = new Map<string, number>();
  readonly responseBodies = new Map<string, ResponseBodyResult>();
  activeGlobal = 0;
  maxActiveGlobal = 0;
  navigationDelayMs = 0;
  snapshotDelayMs = 0;
  private connected = true;
  private browserSessionCounter = 1;
  private nextPage = 1;
  private readonly events = new EventEmitter();

  constructor(tabs: DriverTab[] = []) {
    for (const tab of tabs) this.tabs.set(tab.pageId, { ...tab });
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {
    this.connected = false;
  }

  status(): BrowserConnectionStatus {
    return {
      connected: this.connected,
      ...(this.connected ? { browserSessionId: `mock-browser-session-${this.browserSessionCounter}` } : {}),
      reconnectAttempts: 0
    };
  }

  onEvent(listener: (event: BrowserEvent) => void): () => void {
    this.events.on('event', listener);
    return () => this.events.off('event', listener);
  }

  async listTabs(): Promise<DriverTab[]> {
    this.assertConnected();
    return [...this.tabs.values()].map((tab) => ({ ...tab }));
  }

  async openTab(url: string): Promise<DriverTab> {
    this.assertConnected();
    const tab: DriverTab = {
      pageId: `page-${this.nextPage++}`,
      browserContextId: 'default',
      type: 'page',
      title: titleFor(url),
      url,
      attached: true
    };
    this.tabs.set(tab.pageId, tab);
    return { ...tab };
  }

  async closeTab(pageId: string): Promise<void> {
    this.requireTab(pageId);
    this.tabs.delete(pageId);
  }

  async navigate(
    pageId: string,
    url: string,
    _options: NavigationOptions
  ): Promise<NavigationResult> {
    const tab = this.requireTab(pageId);
    this.navigationOrder.push(`${pageId}:start:${url}`);
    this.enter(pageId);
    const requestId = `request-${this.navigationOrder.length}`;
    this.emit({
      timestamp: new Date().toISOString(),
      kind: 'network',
      method: 'Network.requestWillBeSent',
      pageId,
      data: { requestId, request: { url, headers: { Authorization: 'Bearer secret' } } }
    });
    try {
      await delay(this.navigationDelayMs);
      tab.url = url;
      tab.title = titleFor(url);
      this.responseBodies.set(requestId, { body: `<html>${url}</html>`, base64Encoded: false });
      this.emit({
        timestamp: new Date().toISOString(),
        kind: 'network',
        method: 'Network.loadingFinished',
        pageId,
        data: { requestId }
      });
      return { pageId, url, title: tab.title };
    } finally {
      this.navigationOrder.push(`${pageId}:end:${url}`);
      this.leave(pageId);
    }
  }

  async snapshot(pageId: string, _maxNodes: number): Promise<AccessibilitySnapshot> {
    this.requireTab(pageId);
    await delay(this.snapshotDelayMs);
    return { pageId, nodes: [{ role: 'document' }], truncated: false };
  }

  async screenshot(pageId: string, format: 'png' | 'jpeg'): Promise<ScreenshotResult> {
    this.requireTab(pageId);
    return {
      pageId,
      mimeType: format === 'png' ? 'image/png' : 'image/jpeg',
      data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII='
    };
  }

  async getResponseBody(pageId: string, requestId: string): Promise<ResponseBodyResult> {
    this.requireTab(pageId);
    const body = this.responseBodies.get(requestId);
    if (!body) throw new GatewayError('RESPONSE_BODY_UNAVAILABLE', 'Mock body unavailable');
    return body;
  }

  async inspectPage(pageId: string): Promise<{ url: string; title: string }> {
    const tab = this.requireTab(pageId);
    return { url: tab.url, title: tab.title };
  }

  disconnect(): void {
    this.connected = false;
    this.emit({
      timestamp: new Date().toISOString(),
      kind: 'lifecycle',
      method: 'Browser.disconnected',
      data: { reason: 'mock disconnect' }
    });
  }

  reconnect(): void {
    this.connected = true;
    this.browserSessionCounter += 1;
    this.emit({
      timestamp: new Date().toISOString(),
      kind: 'lifecycle',
      method: 'Browser.connected',
      data: {}
    });
  }

  emit(event: BrowserEvent): void {
    this.events.emit('event', event);
  }

  private requireTab(pageId: string): DriverTab {
    this.assertConnected();
    const tab = this.tabs.get(pageId);
    if (!tab) throw new GatewayError('TAB_NOT_FOUND', 'Mock tab not found', { pageId });
    return tab;
  }

  private assertConnected(): void {
    if (!this.connected) throw new GatewayError('BROWSER_DISCONNECTED', 'Mock browser disconnected');
  }

  private enter(pageId: string): void {
    const active = (this.activeByPage.get(pageId) ?? 0) + 1;
    this.activeByPage.set(pageId, active);
    this.maxActiveByPage.set(pageId, Math.max(active, this.maxActiveByPage.get(pageId) ?? 0));
    this.activeGlobal += 1;
    this.maxActiveGlobal = Math.max(this.maxActiveGlobal, this.activeGlobal);
  }

  private leave(pageId: string): void {
    this.activeByPage.set(pageId, (this.activeByPage.get(pageId) ?? 1) - 1);
    this.activeGlobal -= 1;
  }
}

export function mockTab(pageId: string, url = `https://${pageId}.example/`): DriverTab {
  return { pageId, browserContextId: 'default', type: 'page', title: pageId, url, attached: true };
}

function titleFor(url: string): string {
  return new URL(url).hostname;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
