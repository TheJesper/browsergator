import { EventEmitter } from 'node:events';

import { GatewayError } from '../../src/errors.js';
import type {
  AccessibilitySnapshot,
  BrowserConnectionStatus,
  BrowserDriver,
  BrowserEvent,
  DriverTab,
  ElementLocator,
  InteractionResult,
  NavigationOptions,
  NavigationResult,
  ResponseBodyResult,
  ScreenshotOptions,
  ScreenshotResult,
  WaitForOptions,
  WaitResult
} from '../../src/types.js';

export class MockBrowserDriver implements BrowserDriver {
  readonly tabs = new Map<string, DriverTab>();
  readonly navigationOrder: string[] = [];
  readonly activeByPage = new Map<string, number>();
  readonly maxActiveByPage = new Map<string, number>();
  readonly responseBodies = new Map<string, ResponseBodyResult>();
  readonly evaluateResults = new Map<string, unknown>();
  defaultEvaluateResult: unknown = null;
  storage: { local: Record<string, string>; session: Record<string, string>; cookies: string } = {
    local: {},
    session: {},
    cookies: ''
  };
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

  async click(pageId: string, locator: ElementLocator): Promise<InteractionResult> {
    this.requireTab(pageId);
    if (!locator.selector && !locator.text) {
      throw new GatewayError('ELEMENT_NOT_FOUND', 'Mock locator is empty');
    }
    return { pageId, action: 'click', tagName: 'BUTTON', text: locator.text ?? locator.selector ?? '' };
  }

  async fill(pageId: string, locator: ElementLocator, _value: string): Promise<InteractionResult> {
    this.requireTab(pageId);
    if (!locator.selector) throw new GatewayError('ELEMENT_NOT_FOUND', 'Mock fill selector is empty');
    return { pageId, action: 'fill', tagName: 'INPUT', text: locator.selector };
  }

  async waitFor(pageId: string, options: WaitForOptions): Promise<WaitResult> {
    this.requireTab(pageId);
    return { pageId, matched: options.selector ? 'selector' : 'text', value: options.selector ?? options.text ?? '' };
  }

  async pressKey(pageId: string, key: string): Promise<{ pageId: string; key: string }> {
    this.requireTab(pageId);
    return { pageId, key };
  }

  async typeText(pageId: string, text: string): Promise<{ pageId: string; textLength: number }> {
    this.requireTab(pageId);
    return { pageId, textLength: text.length };
  }

  async hover(pageId: string, locator: ElementLocator): Promise<InteractionResult> {
    this.requireTab(pageId);
    return { pageId, action: 'hover', tagName: 'BUTTON', text: locator.text ?? locator.selector ?? locator.uid ?? '' };
  }

  async clickAt(pageId: string, x: number, y: number): Promise<{ pageId: string; x: number; y: number }> {
    this.requireTab(pageId);
    return { pageId, x, y };
  }

  async drag(pageId: string, _from: ElementLocator, _to: ElementLocator): Promise<InteractionResult> {
    this.requireTab(pageId);
    return { pageId, action: 'drag', tagName: 'DRAG', text: 'mock' };
  }

  async handleDialog(pageId: string, accept: boolean): Promise<{ pageId: string; accepted: boolean }> {
    this.requireTab(pageId);
    return { pageId, accepted: accept };
  }

  async snapshot(pageId: string, _maxNodes: number): Promise<AccessibilitySnapshot> {
    this.requireTab(pageId);
    await delay(this.snapshotDelayMs);
    return { pageId, nodes: [{ role: 'document' }], truncated: false };
  }

  async screenshot(pageId: string, options: ScreenshotOptions): Promise<ScreenshotResult> {
    this.requireTab(pageId);
    const format = options.format ?? 'png';
    // Mock element clip: any locator resolves to a fixed rect so tests can assert it.
    const clip = options.clip ?? (options.locator ? { x: 10, y: 20, width: 100, height: 50 } : undefined);
    return {
      pageId,
      mimeType: format === 'png' ? 'image/png' : 'image/jpeg',
      data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=',
      ...(clip ? { clip } : {})
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

  async evaluate(pageId: string, expression: string): Promise<unknown> {
    this.requireTab(pageId);
    const scripted = this.evaluateResults.get(expression);
    if (scripted !== undefined) return scripted;
    return this.defaultEvaluateResult;
  }

  async readStorage(
    pageId: string
  ): Promise<{ local: Record<string, string>; session: Record<string, string>; cookies: string }> {
    this.requireTab(pageId);
    return this.storage;
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
