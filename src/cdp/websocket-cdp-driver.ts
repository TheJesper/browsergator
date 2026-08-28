import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

import WebSocket, { type RawData } from 'ws';

import { GatewayError } from '../errors.js';
import type {
  AccessibilitySnapshot,
  BrowserConnectionStatus,
  BrowserDriver,
  BrowserEvent,
  BrowserVersion,
  DriverTab,
  NavigationOptions,
  NavigationResult,
  ResponseBodyResult,
  ScreenshotResult
} from '../types.js';
import { log } from '../core/logger.js';

interface CdpTargetInfo {
  targetId: string;
  browserContextId?: string;
  type: string;
  title: string;
  url: string;
  attached?: boolean;
}

interface PendingCommand {
  resolve: (value: Record<string, any>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, any>;
  result?: Record<string, any>;
  error?: { code: number; message: string; data?: unknown };
  sessionId?: string;
}

export class WebSocketCdpDriver implements BrowserDriver {
  private socket?: WebSocket;
  private connectPromise?: Promise<void>;
  private reconnectTimer?: NodeJS.Timeout;
  private stopping = false;
  private nextId = 1;
  private reconnectAttempts = 0;
  private browserSessionId?: string;
  private connectedAt?: string;
  private lastDisconnectedAt?: string;
  private lastError?: string;
  private version?: BrowserVersion;
  private readonly pending = new Map<number, PendingCommand>();
  private readonly targets = new Map<string, CdpTargetInfo>();
  private readonly sessionByPage = new Map<string, string>();
  private readonly pageBySession = new Map<string, string>();
  private readonly attaching = new Map<string, Promise<void>>();
  private readonly activeRequests = new Map<string, Set<string>>();
  private readonly dialogs = new Set<string>();
  private readonly events = new EventEmitter();

  constructor(
    private readonly browserUrl: string,
    private readonly commandTimeoutMs = 15_000
  ) {}

  async start(): Promise<void> {
    this.stopping = false;
    try {
      await this.connect();
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      log('warn', 'Initial CDP connection failed; reconnect scheduled', { error: this.lastError });
      this.scheduleReconnect();
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.rejectPending(new GatewayError('BROWSER_DISCONNECTED', 'CDP driver stopped'));
    const socket = this.socket;
    this.socket = undefined;
    this.browserSessionId = undefined;
    if (socket && socket.readyState < WebSocket.CLOSING) {
      await new Promise<void>((resolve) => {
        socket.once('close', () => resolve());
        socket.close(1000, 'gateway shutdown');
        setTimeout(resolve, 1_000).unref();
      });
    }
  }

  status(): BrowserConnectionStatus {
    return {
      connected: this.isConnected(),
      ...(this.browserSessionId ? { browserSessionId: this.browserSessionId } : {}),
      reconnectAttempts: this.reconnectAttempts,
      ...(this.connectedAt ? { connectedAt: this.connectedAt } : {}),
      ...(this.lastDisconnectedAt ? { lastDisconnectedAt: this.lastDisconnectedAt } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
      ...(this.version ? { version: { ...this.version } } : {})
    };
  }

  onEvent(listener: (event: BrowserEvent) => void): () => void {
    this.events.on('browser-event', listener);
    return () => this.events.off('browser-event', listener);
  }

  async listTabs(): Promise<DriverTab[]> {
    this.assertConnected();
    return [...this.targets.values()]
      .filter((target) => target.type === 'page')
      .map((target) => ({
        pageId: target.targetId,
        browserContextId: target.browserContextId ?? 'default',
        type: target.type,
        title: target.title,
        url: target.url,
        attached: this.sessionByPage.has(target.targetId)
      }));
  }

  async openTab(url: string): Promise<DriverTab> {
    this.assertConnected();
    const result = await this.send('Target.createTarget', { url });
    const pageId = String(result['targetId']);
    const target: CdpTargetInfo = {
      targetId: pageId,
      browserContextId: 'default',
      type: 'page',
      title: '',
      url
    };
    this.targets.set(pageId, target);
    await this.ensureAttached(target);
    const inspected = await this.inspectPage(pageId).catch(() => ({ url, title: '' }));
    return {
      pageId,
      browserContextId: this.targets.get(pageId)?.browserContextId ?? 'default',
      type: 'page',
      ...inspected,
      attached: true
    };
  }

  async closeTab(pageId: string): Promise<void> {
    this.requireTab(pageId);
    await this.send('Target.closeTarget', { targetId: pageId });
  }

  async navigate(
    pageId: string,
    url: string,
    options: NavigationOptions
  ): Promise<NavigationResult> {
    const sessionId = this.requireSession(pageId);
    if (this.dialogs.has(pageId)) {
      throw new GatewayError('NEEDS_HUMAN', 'A JavaScript dialog requires human attention', { pageId });
    }
    const result = await this.send('Page.navigate', { url }, sessionId);
    if (result['errorText']) {
      throw new Error(`Navigation failed: ${String(result['errorText'])}`);
    }
    if (options.waitUntil !== 'none') {
      await this.waitForNavigation(pageId, options);
    }
    const inspected = await this.inspectPage(pageId);
    return { pageId, ...inspected };
  }

  async snapshot(pageId: string, maxNodes: number): Promise<AccessibilitySnapshot> {
    const sessionId = this.requireSession(pageId);
    const result = await this.send('Accessibility.getFullAXTree', {}, sessionId);
    const allNodes = Array.isArray(result['nodes']) ? result['nodes'] : [];
    const nodes = allNodes.slice(0, maxNodes).map((node: Record<string, any>) => ({
      nodeId: node['nodeId'],
      ...(node['backendDOMNodeId'] ? { backendDOMNodeId: node['backendDOMNodeId'] } : {}),
      ignored: Boolean(node['ignored']),
      role: axValue(node['role']),
      name: axValue(node['name']),
      value: axValue(node['value']),
      description: axValue(node['description']),
      childIds: node['childIds'] ?? []
    }));
    return { pageId, nodes, truncated: allNodes.length > nodes.length };
  }

  async screenshot(
    pageId: string,
    format: 'png' | 'jpeg',
    quality?: number
  ): Promise<ScreenshotResult> {
    const sessionId = this.requireSession(pageId);
    const params: Record<string, unknown> = { format, fromSurface: true, captureBeyondViewport: true };
    if (format === 'jpeg' && quality !== undefined) params['quality'] = quality;
    const result = await this.send('Page.captureScreenshot', params, sessionId);
    return {
      pageId,
      mimeType: format === 'png' ? 'image/png' : 'image/jpeg',
      data: String(result['data'])
    };
  }

  async getResponseBody(pageId: string, requestId: string): Promise<ResponseBodyResult> {
    const sessionId = this.requireSession(pageId);
    try {
      const result = await this.send('Network.getResponseBody', { requestId }, sessionId);
      return { body: String(result['body'] ?? ''), base64Encoded: Boolean(result['base64Encoded']) };
    } catch (error) {
      throw new GatewayError('RESPONSE_BODY_UNAVAILABLE', 'Chrome no longer has this response body', {
        pageId,
        requestId,
        reason: error instanceof Error ? error.message : String(error)
      });
    }
  }

  async inspectPage(pageId: string): Promise<{ url: string; title: string }> {
    const sessionId = this.requireSession(pageId);
    const result = await this.send(
      'Runtime.evaluate',
      {
        expression: '({url: location.href, title: document.title})',
        returnByValue: true,
        awaitPromise: true
      },
      sessionId
    );
    const value = result['result']?.value as { url?: unknown; title?: unknown } | undefined;
    return { url: String(value?.url ?? ''), title: String(value?.title ?? '') };
  }

  private async connect(): Promise<void> {
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.connectOnce().finally(() => {
      this.connectPromise = undefined;
    });
    return this.connectPromise;
  }

  private async connectOnce(): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.commandTimeoutMs);
    let metadata: { webSocketDebuggerUrl?: string };
    try {
      const endpoint = new URL('/json/version', ensureTrailingSlash(this.browserUrl));
      const response = await fetch(endpoint, { signal: controller.signal });
      if (!response.ok) throw new Error(`CDP metadata returned HTTP ${response.status}`);
      metadata = (await response.json()) as { webSocketDebuggerUrl?: string };
    } finally {
      clearTimeout(timeout);
    }
    if (!metadata.webSocketDebuggerUrl) throw new Error('CDP metadata omitted webSocketDebuggerUrl');
    assertLoopbackWebSocket(metadata.webSocketDebuggerUrl);

    const socket = new WebSocket(metadata.webSocketDebuggerUrl, { perMessageDeflate: false });
    this.socket = socket;
    socket.on('message', (data) => this.handleMessage(data));
    socket.on('close', (_code, reason) => this.handleDisconnect(reason.toString() || 'socket closed'));
    socket.on('error', (error) => {
      this.lastError = error.message;
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });

    this.reconnectAttempts = 0;
    this.browserSessionId = randomUUID();
    this.connectedAt = new Date().toISOString();
    this.lastError = undefined;
    const versionResult = await this.send('Browser.getVersion');
    this.version = {
      browser: String(versionResult['product'] ?? 'unknown'),
      protocolVersion: String(versionResult['protocolVersion'] ?? 'unknown'),
      ...(versionResult['userAgent'] ? { userAgent: String(versionResult['userAgent']) } : {})
    };

    await this.send('Target.setDiscoverTargets', { discover: true });
    const targets = await this.send('Target.getTargets');
    const infos = Array.isArray(targets['targetInfos']) ? targets['targetInfos'] : [];
    for (const raw of infos) this.upsertTarget(raw as CdpTargetInfo);
    await Promise.all(
      [...this.targets.values()].filter((target) => target.type === 'page').map((target) => this.ensureAttached(target))
    );
    this.emitEvent('lifecycle', 'Browser.connected', undefined, {
      browserSessionId: this.browserSessionId,
      version: this.version
    });
  }

  private handleMessage(raw: RawData): void {
    let message: CdpMessage;
    try {
      message = JSON.parse(raw.toString()) as CdpMessage;
    } catch {
      return;
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(`CDP ${message.error.code}: ${message.error.message}`));
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }
    if (message.method) this.handleEvent(message.method, message.params ?? {}, message.sessionId);
  }

  private handleEvent(method: string, params: Record<string, any>, sessionId?: string): void {
    if (method === 'Target.targetCreated' || method === 'Target.targetInfoChanged') {
      const target = this.upsertTarget(params['targetInfo'] as CdpTargetInfo);
      if (target?.type === 'page') void this.ensureAttached(target).catch((error) => this.recordError(error));
      return;
    }
    if (method === 'Target.targetDestroyed') {
      const pageId = String(params['targetId']);
      const existingSession = this.sessionByPage.get(pageId);
      if (existingSession) this.pageBySession.delete(existingSession);
      this.sessionByPage.delete(pageId);
      this.targets.delete(pageId);
      this.activeRequests.delete(pageId);
      this.dialogs.delete(pageId);
      this.emitEvent('lifecycle', method, pageId, params);
      return;
    }
    if (method === 'Target.detachedFromTarget') {
      const detachedSession = String(params['sessionId']);
      const pageId = this.pageBySession.get(detachedSession);
      if (pageId) this.sessionByPage.delete(pageId);
      this.pageBySession.delete(detachedSession);
      if (pageId) this.emitEvent('lifecycle', method, pageId, params);
      return;
    }

    const pageId = sessionId ? this.pageBySession.get(sessionId) : undefined;
    if (!pageId) return;

    if (method === 'Network.requestWillBeSent') {
      const requests = this.activeRequests.get(pageId) ?? new Set<string>();
      requests.add(String(params['requestId']));
      this.activeRequests.set(pageId, requests);
    } else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
      this.activeRequests.get(pageId)?.delete(String(params['requestId']));
    } else if (method === 'Page.javascriptDialogOpening') {
      this.dialogs.add(pageId);
    } else if (method === 'Page.javascriptDialogClosed') {
      this.dialogs.delete(pageId);
    }

    const kind = eventKind(method);
    if (kind) this.emitEvent(kind, method, pageId, params);
  }

  private upsertTarget(raw: CdpTargetInfo | undefined): CdpTargetInfo | undefined {
    if (!raw?.targetId) return undefined;
    const target: CdpTargetInfo = {
      targetId: String(raw.targetId),
      ...(raw.browserContextId ? { browserContextId: String(raw.browserContextId) } : {}),
      type: String(raw.type ?? ''),
      title: String(raw.title ?? ''),
      url: String(raw.url ?? ''),
      attached: Boolean(raw.attached)
    };
    this.targets.set(target.targetId, target);
    return target;
  }

  private ensureAttached(target: CdpTargetInfo): Promise<void> {
    if (this.sessionByPage.has(target.targetId)) return Promise.resolve();
    const current = this.attaching.get(target.targetId);
    if (current) return current;
    const attaching = this.attach(target).finally(() => this.attaching.delete(target.targetId));
    this.attaching.set(target.targetId, attaching);
    return attaching;
  }

  private async attach(target: CdpTargetInfo): Promise<void> {
    const result = await this.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    const sessionId = String(result['sessionId']);
    this.sessionByPage.set(target.targetId, sessionId);
    this.pageBySession.set(sessionId, target.targetId);
    this.activeRequests.set(target.targetId, new Set());
    await Promise.all([
      this.send('Page.enable', {}, sessionId),
      this.send('Page.setLifecycleEventsEnabled', { enabled: true }, sessionId),
      this.send('Runtime.enable', {}, sessionId),
      this.send('Log.enable', {}, sessionId),
      this.send(
        'Network.enable',
        { maxTotalBufferSize: 10_000_000, maxResourceBufferSize: 2_000_000 },
        sessionId
      ),
      this.send('Accessibility.enable', {}, sessionId)
    ]);
    this.emitEvent('lifecycle', 'Target.attached', target.targetId, { title: target.title, url: target.url });
  }

  private send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string
  ): Promise<Record<string, any>> {
    this.assertConnected();
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) });
    return new Promise<Record<string, any>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, this.commandTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket!.send(payload, (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  private async waitForNavigation(pageId: string, options: NavigationOptions): Promise<void> {
    const deadline = Date.now() + options.timeoutMs;
    let idleSince: number | undefined;
    while (Date.now() < deadline) {
      const sessionId = this.requireSession(pageId);
      const result = await this.send(
        'Runtime.evaluate',
        { expression: 'document.readyState', returnByValue: true },
        sessionId
      );
      const state = String(result['result']?.value ?? '');
      const ready =
        options.waitUntil === 'domcontentloaded'
          ? state === 'interactive' || state === 'complete'
          : state === 'complete';
      if (ready && options.waitUntil !== 'networkidle') return;
      if (ready && (this.activeRequests.get(pageId)?.size ?? 0) === 0) {
        idleSince ??= Date.now();
        if (Date.now() - idleSince >= 500) return;
      } else {
        idleSince = undefined;
      }
      await delay(50);
    }
    throw new Error(`Navigation wait timed out after ${options.timeoutMs}ms`);
  }

  private requireTab(pageId: string): CdpTargetInfo {
    this.assertConnected();
    const tab = this.targets.get(pageId);
    if (!tab || tab.type !== 'page') {
      throw new GatewayError('TAB_NOT_FOUND', 'No page target exists for pageId', { pageId });
    }
    return tab;
  }

  private requireSession(pageId: string): string {
    this.requireTab(pageId);
    const sessionId = this.sessionByPage.get(pageId);
    if (!sessionId) throw new GatewayError('TAB_NOT_FOUND', 'The page target is not attached', { pageId });
    return sessionId;
  }

  private isConnected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  private assertConnected(): void {
    if (!this.isConnected()) {
      throw new GatewayError('BROWSER_DISCONNECTED', 'The gateway is not connected to agent Chrome');
    }
  }

  private handleDisconnect(reason: string): void {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    this.socket = undefined;
    this.browserSessionId = undefined;
    this.connectedAt = undefined;
    this.lastDisconnectedAt = new Date().toISOString();
    this.lastError = reason;
    this.targets.clear();
    this.sessionByPage.clear();
    this.pageBySession.clear();
    this.activeRequests.clear();
    this.dialogs.clear();
    this.rejectPending(new GatewayError('BROWSER_DISCONNECTED', 'Chrome CDP connection closed'));
    this.emitEvent('lifecycle', 'Browser.disconnected', undefined, { reason });
    if (!this.stopping) this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopping || this.reconnectTimer) return;
    this.reconnectAttempts += 1;
    const delayMs = Math.min(10_000, 250 * 2 ** Math.min(this.reconnectAttempts - 1, 6));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect().catch((error) => {
        this.recordError(error);
        this.scheduleReconnect();
      });
    }, delayMs);
    this.reconnectTimer.unref();
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private recordError(error: unknown): void {
    this.lastError = error instanceof Error ? error.message : String(error);
    log('warn', 'CDP driver error', { error: this.lastError });
  }

  private emitEvent(
    kind: BrowserEvent['kind'],
    method: string,
    pageId: string | undefined,
    data: Record<string, unknown>
  ): void {
    const event: BrowserEvent = {
      timestamp: new Date().toISOString(),
      kind,
      method,
      ...(pageId ? { pageId } : {}),
      data
    };
    this.events.emit('browser-event', event);
  }
}

function eventKind(method: string): BrowserEvent['kind'] | undefined {
  if (method.startsWith('Network.')) return 'network';
  if (method.startsWith('Runtime.') || method.startsWith('Log.')) return 'console';
  if (method.startsWith('Page.') || method.startsWith('Target.')) return 'lifecycle';
  return undefined;
}

function axValue(value: unknown): unknown {
  if (!value || typeof value !== 'object') return undefined;
  return (value as { value?: unknown }).value;
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

function assertLoopbackWebSocket(value: string): void {
  const hostname = new URL(value).hostname.toLowerCase();
  if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(hostname)) {
    throw new Error('Chrome advertised a non-loopback CDP WebSocket');
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
