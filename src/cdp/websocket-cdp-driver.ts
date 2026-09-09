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
  ElementLocator,
  InteractionResult,
  NavigationOptions,
  NavigationResult,
  ResponseBodyResult,
  ScreenshotClip,
  ScreenshotOptions,
  ScreenshotResult,
  WaitForOptions,
  WaitResult
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
  private waitingLogged = false;
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
      this.noteBrowserUnavailable('Initial CDP connection failed; waiting for agent Chrome', error);
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

  async click(pageId: string, locator: ElementLocator): Promise<InteractionResult> {
    const sessionId = this.requireSession(pageId);
    const result = await this.evaluateInteraction(sessionId, locator, clickAction());
    return interactionResult(pageId, 'hover', result);
  }

  async fill(pageId: string, locator: ElementLocator, value: string): Promise<InteractionResult> {
    const sessionId = this.requireSession(pageId);
    const result = await this.evaluateInteraction(sessionId, locator, fillAction(value));
    return interactionResult(pageId, 'fill', result);
  }

  async waitFor(pageId: string, options: WaitForOptions): Promise<WaitResult> {
    const sessionId = this.requireSession(pageId);
    if (!options.selector && !options.text) {
      throw new GatewayError('INVALID_SELECTOR', 'wait_for requires selector or text');
    }
    const deadline = Date.now() + options.timeoutMs;
    while (Date.now() < deadline) {
      const result = await this.send(
        'Runtime.evaluate',
        { expression: waitExpression(options), returnByValue: true, awaitPromise: true },
        sessionId
      );
      const value = result['result']?.value as { matched?: unknown; value?: unknown } | undefined;
      if (value?.matched === true) {
        return {
          pageId,
          matched: options.selector ? 'selector' : 'text',
          value: String(value.value ?? options.selector ?? options.text ?? '')
        };
      }
      await delay(50);
    }
    throw new GatewayError('WAIT_TIMEOUT', `Timed out waiting after ${options.timeoutMs}ms`, {
      pageId,
      ...(options.selector ? { selector: options.selector } : {}),
      ...(options.text ? { text: options.text } : {})
    });
  }

  async pressKey(pageId: string, key: string): Promise<{ pageId: string; key: string }> {
    const sessionId = this.requireSession(pageId);
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key }, sessionId);
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key }, sessionId);
    return { pageId, key };
  }

  async typeText(pageId: string, text: string): Promise<{ pageId: string; textLength: number }> {
    const sessionId = this.requireSession(pageId);
    await this.send('Input.insertText', { text }, sessionId);
    return { pageId, textLength: text.length };
  }

  async hover(pageId: string, locator: ElementLocator): Promise<InteractionResult> {
    const sessionId = this.requireSession(pageId);
    const result = await this.evaluateInteraction(sessionId, locator, hoverAction());
    return interactionResult(pageId, 'click', result);
  }

  async clickAt(pageId: string, x: number, y: number): Promise<{ pageId: string; x: number; y: number }> {
    const sessionId = this.requireSession(pageId);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, sessionId);
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, sessionId);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, sessionId);
    return { pageId, x, y };
  }

  async drag(pageId: string, from: ElementLocator, to: ElementLocator): Promise<InteractionResult> {
    const sessionId = this.requireSession(pageId);
    const start = await this.elementCenter(sessionId, from);
    const end = await this.elementCenter(sessionId, to);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.x, y: start.y }, sessionId);
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: start.x, y: start.y, button: 'left', clickCount: 1 }, sessionId);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: end.x, y: end.y, button: 'left', buttons: 1 }, sessionId);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: end.x, y: end.y, button: 'left', clickCount: 1 }, sessionId);
    return { pageId, action: 'drag', tagName: 'DRAG', text: `${start.x},${start.y}->${end.x},${end.y}` };
  }

  async handleDialog(pageId: string, accept: boolean, promptText?: string): Promise<{ pageId: string; accepted: boolean }> {
    const sessionId = this.requireSession(pageId);
    if (!this.dialogs.has(pageId)) throw new GatewayError('DIALOG_NOT_OPEN', 'No JavaScript dialog is open', { pageId });
    await this.send('Page.handleJavaScriptDialog', { accept, ...(promptText === undefined ? {} : { promptText }) }, sessionId);
    this.dialogs.delete(pageId);
    return { pageId, accepted: accept };
  }

  async snapshot(pageId: string, maxNodes: number): Promise<AccessibilitySnapshot> {
    const sessionId = this.requireSession(pageId);
    const result = await this.send('Accessibility.getFullAXTree', {}, sessionId);
    const allNodes = Array.isArray(result['nodes']) ? result['nodes'] : [];
    const nodes = allNodes.slice(0, maxNodes).map((node: Record<string, any>) => ({
      nodeId: node['nodeId'],
      ...(node['backendDOMNodeId'] ? { uid: String(node['backendDOMNodeId']) } : {}),
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

  async screenshot(pageId: string, options: ScreenshotOptions): Promise<ScreenshotResult> {
    const sessionId = this.requireSession(pageId);
    const format = options.format ?? 'png';
    const params: Record<string, unknown> = { format, fromSurface: true, captureBeyondViewport: true };
    if (format === 'jpeg' && options.quality !== undefined) params['quality'] = options.quality;

    let clip: ScreenshotClip | undefined = options.clip;
    if (!clip && options.locator) {
      clip = await this.elementRect(sessionId, options.locator);
    }
    if (clip) {
      if (clip.width <= 0 || clip.height <= 0) {
        throw new GatewayError('INVALID_SCREENSHOT_CLIP', 'Screenshot clip must have positive width and height', {
          pageId,
          clip
        });
      }
      params['clip'] = { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: 1 };
    }

    const result = await this.send('Page.captureScreenshot', params, sessionId);
    return {
      pageId,
      mimeType: format === 'png' ? 'image/png' : 'image/jpeg',
      data: String(result['data']),
      ...(clip ? { clip } : {})
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

  async evaluate(pageId: string, expression: string): Promise<unknown> {
    const sessionId = this.requireSession(pageId);
    const result = await this.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      sessionId
    );
    const exception = result['exceptionDetails'] as
      | { exception?: { description?: string }; text?: string }
      | undefined;
    if (exception) {
      throw new GatewayError(
        'EVALUATE_FAILED',
        String(exception.exception?.description ?? exception.text ?? 'Expression evaluation failed'),
        { pageId }
      );
    }
    return result['result']?.value;
  }

  async readStorage(pageId: string): Promise<{ local: Record<string, string>; session: Record<string, string>; cookies: string }> {
    const value = (await this.evaluate(
      pageId,
      '({' +
        'local: Object.fromEntries(Object.entries(localStorage)),' +
        'session: Object.fromEntries(Object.entries(sessionStorage)),' +
        'cookies: document.cookie' +
        '})'
    )) as { local?: Record<string, string>; session?: Record<string, string>; cookies?: string } | undefined;
    return {
      local: value?.local ?? {},
      session: value?.session ?? {},
      cookies: String(value?.cookies ?? '')
    };
  }

  private async evaluateInteraction(
    sessionId: string,
    locator: ElementLocator,
    action: string
  ): Promise<Record<string, unknown>> {
    if (locator.uid !== undefined) {
      const backendDOMNodeId = Number(locator.uid);
      if (!Number.isInteger(backendDOMNodeId) || backendDOMNodeId <= 0) {
        throw new GatewayError('INVALID_SELECTOR', 'The element uid is invalid', { uid: locator.uid });
      }
      const resolved = await this.send('DOM.resolveNode', { backendNodeId: backendDOMNodeId }, sessionId);
      const objectId = resolved['object']?.['objectId'];
      if (typeof objectId !== 'string') throw new GatewayError('ELEMENT_NOT_FOUND', 'The element uid is stale');
      try {
        return this.extractEvaluation(
          await this.send(
            'Runtime.callFunctionOn',
            {
              objectId,
              functionDeclaration: `function() { ${action} }`,
              returnByValue: true,
              awaitPromise: true,
              userGesture: true
            },
            sessionId
          )
        );
      } finally {
        await this.send('Runtime.releaseObject', { objectId }, sessionId).catch(() => undefined);
      }
    }
    return this.extractEvaluation(
      await this.send(
        'Runtime.evaluate',
        { expression: elementExpression(locator, action), returnByValue: true, awaitPromise: true, userGesture: true },
        sessionId
      )
    );
  }

  private extractEvaluation(result: Record<string, any>): Record<string, unknown> {
    const exception = result['exceptionDetails'] as { text?: unknown; exception?: { description?: unknown } } | undefined;
    if (exception) {
      throw new GatewayError(
        'INVALID_SELECTOR',
        String(exception.exception?.description ?? exception.text ?? 'The element locator is invalid')
      );
    }
    const value = result['result']?.value;
    if (!value || typeof value !== 'object') {
      throw new GatewayError('ELEMENT_NOT_FOUND', 'No matching element was found');
    }
    return value as Record<string, unknown>;
  }

  private async elementCenter(
    sessionId: string,
    locator: ElementLocator
  ): Promise<{ x: number; y: number }> {
    const result = await this.evaluateInteraction(
      sessionId,
      locator,
      `const element = this; const rect = element.getBoundingClientRect(); return { ok: rect.width > 0 && rect.height > 0, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };`
    );
    if (result['ok'] !== true) throw new GatewayError('ELEMENT_NOT_INTERACTABLE', 'Element has no visible bounds');
    return { x: Number(result['x']), y: Number(result['y']) };
  }

  private async elementRect(sessionId: string, locator: ElementLocator): Promise<ScreenshotClip> {
    const result = await this.evaluateInteraction(
      sessionId,
      locator,
      `const element = this; element.scrollIntoView({ block: 'center', inline: 'center' }); const rect = element.getBoundingClientRect(); return { ok: rect.width > 0 && rect.height > 0, x: rect.left, y: rect.top, width: rect.width, height: rect.height };`
    );
    if (result['ok'] !== true) {
      throw new GatewayError('ELEMENT_NOT_FOUND', 'Element has no visible bounds to capture');
    }
    return {
      x: Number(result['x']),
      y: Number(result['y']),
      width: Number(result['width']),
      height: Number(result['height'])
    };
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
    this.waitingLogged = false;
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
    log('info', 'Connected to agent Chrome', {
      browser: this.version.browser,
      pages: [...this.targets.values()].filter((t) => t.type === 'page').length
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
        this.lastError = error instanceof Error ? error.message : String(error);
        // A reconnect attempt failing usually just means Chrome is not up yet.
        // Log the wait once at info; keep the noisy per-attempt detail at debug.
        this.noteBrowserUnavailable('Waiting for agent Chrome on the debug port', error);
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

  /**
   * Log that agent Chrome is not reachable. The first occurrence (per outage) is
   * surfaced at info so the operator knows to start Chrome; subsequent repeats
   * during the reconnect backoff are logged at debug to avoid flooding the log.
   * A genuinely unexpected error (not a plain "no browser there") is warned once.
   */
  private noteBrowserUnavailable(message: string, error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    if (isBrowserAbsentError(error)) {
      if (!this.waitingLogged) {
        this.waitingLogged = true;
        log('info', message, { browserUrl: this.browserUrl, hint: 'start agent Chrome with --remote-debugging-port' });
      } else {
        log('debug', 'CDP reconnect attempt failed (Chrome still absent)', { error: detail });
      }
      return;
    }
    // Unexpected failure shape -- surface it, but still only once per outage.
    if (!this.waitingLogged) {
      this.waitingLogged = true;
      log('warn', 'CDP connection failed', { error: detail });
    } else {
      log('debug', 'CDP reconnect attempt failed', { error: detail });
    }
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

/**
 * True when an error means "no browser is listening on the debug port yet"
 * (connection refused, DNS/host unreachable, fetch abort, socket reset) rather
 * than an unexpected protocol/logic failure. Node wraps these as a generic
 * "fetch failed" TypeError with a `cause`, so we inspect the cause code too.
 */
function isBrowserAbsentError(error: unknown): boolean {
  const absentCodes = ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EHOSTUNREACH', 'ETIMEDOUT', 'ABORT_ERR'];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error) {
      const code = (current as { code?: unknown }).code;
      if (typeof code === 'string' && absentCodes.includes(code)) return true;
      if (current.name === 'AbortError') return true;
      const message = current.message.toLowerCase();
      if (message.includes('fetch failed') || message.includes('econnrefused') || message.includes('connect')) return true;
      current = (current as { cause?: unknown }).cause;
    } else {
      break;
    }
  }
  return false;
}

function clickAction(): string {
  return `
    const element = this;
    if (!(element instanceof HTMLElement)) return { ok: false, reason: 'not-interactable' };
    element.scrollIntoView({ block: 'center', inline: 'center' });
    element.click();
    return { ok: true, tagName: element.tagName, text: (element.innerText || element.textContent || '').trim().slice(0, 500) };
  `;
}

function fillAction(value: string): string {
  return `
    const element = this;
    if (!(element instanceof HTMLElement)) return { ok: false, reason: 'not-interactable' };
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement || element.isContentEditable)) {
      return { ok: false, reason: 'not-fillable' };
    }
    element.scrollIntoView({ block: 'center', inline: 'center' });
    element.focus();
    const nextValue = ${JSON.stringify(value)};
    if (element.isContentEditable) {
      element.textContent = nextValue;
    } else {
      const prototype = Object.getPrototypeOf(element);
      const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
      if (descriptor?.set) descriptor.set.call(element, nextValue);
      else element.value = nextValue;
    }
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: nextValue }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, tagName: element.tagName, text: (element.value || element.textContent || '').trim().slice(0, 500) };
  `;
}

function hoverAction(): string {
  return `
    const element = this;
    if (!(element instanceof HTMLElement)) return { ok: false, reason: 'not-interactable' };
    element.scrollIntoView({ block: 'center', inline: 'center' });
    element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    element.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    return { ok: true, tagName: element.tagName, text: (element.innerText || element.textContent || '').trim().slice(0, 500) };
  `;
}

function elementExpression(locator: ElementLocator, action: string): string {
  const selector = JSON.stringify(locator.selector ?? null);
  const text = JSON.stringify(locator.text ?? null);
  const exactText = locator.exactText === true;
  return `(function() {
    const selector = ${selector};
    const text = ${text};
    const exactText = ${exactText};
    const query = selector || 'a,button,input,textarea,select,[role="button"],[contenteditable="true"]';
    const candidates = Array.from(document.querySelectorAll(query));
    const normalized = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const element = text === null
      ? candidates[0]
      : candidates.find((candidate) => {
          const candidateText = normalized(candidate.innerText || candidate.textContent || candidate.getAttribute('aria-label') || candidate.getAttribute('value'));
          return exactText ? candidateText === text : candidateText.includes(text);
        });
    if (!element) return { ok: false, reason: 'not-found' };
    return (function() { ${action} }).call(element);
  })()`;
}

function waitExpression(options: WaitForOptions): string {
  const selector = JSON.stringify(options.selector ?? null);
  const text = JSON.stringify(options.text ?? null);
  return `(() => {
    const selector = ${selector};
    const text = ${text};
    if (selector !== null) return { matched: Boolean(document.querySelector(selector)), value: selector };
    const bodyText = String(document.body?.innerText || document.documentElement?.innerText || '');
    return { matched: bodyText.includes(text), value: text };
  })()`;
}

function interactionResult(pageId: string, action: 'click' | 'fill' | 'hover' | 'drag', result: Record<string, unknown>): InteractionResult {
  if (result['ok'] !== true) {
    const reason = String(result['reason'] ?? 'not-found');
    if (reason === 'not-found') {
      throw new GatewayError('ELEMENT_NOT_FOUND', 'No matching element was found', { pageId });
    }
    throw new GatewayError('ELEMENT_NOT_INTERACTABLE', 'The matching element cannot be interacted with', {
      pageId,
      reason
    });
  }
  return {
    pageId,
    action,
    tagName: String(result['tagName'] ?? ''),
    text: String(result['text'] ?? '')
  };
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
