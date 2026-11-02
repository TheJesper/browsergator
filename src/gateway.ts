import { createHash } from 'node:crypto';

import type { GatewayConfig } from './config.js';
import { asGatewayError, GatewayError } from './errors.js';
import type {
  AgentContext,
  BrowserContext,
  BrowserDriver,
  BrowserEvent,
  DriverTab,
  ElementLocator,
  NavigationOptions,
  OpenTabOptions,
  ScreenshotOptions,
  WaitForOptions
} from './types.js';
import type { AuditEvent, AuditSink } from './core/audit-log.js';
import { IdempotencyStore } from './core/idempotency-store.js';
import { LeaseManager, type RuntimeLease } from './core/lease-manager.js';
import { PerTabFifo } from './core/per-tab-fifo.js';
import { ProtectedTabPolicy } from './core/policy.js';
import { EnvironmentPolicy, type EnvironmentDecision } from './core/environment.js';
import { redact } from './core/redaction.js';
import { RingBuffer } from './core/ring-buffer.js';

export interface TabView extends DriverTab {
  browserSessionId?: string;
  protected: boolean;
  matchedProtectedPattern?: string;
  lease?: PublicRuntimeLease;
  queueDepth: number;
}

export type PublicRuntimeLease = Omit<RuntimeLease, 'clientSessionId'>;

export interface MutationMetadata {
  context: AgentContext;
  leaseId?: string;
  idempotencyKey?: string;
}

export interface RunAtomicInput {
  pageId: string;
  context: AgentContext;
  idempotencyKey: string;
  leaseTtlMs?: number;
  action: {
    type: 'navigate';
    url: string;
    waitUntil: NavigationOptions['waitUntil'];
    timeoutMs: number;
  };
  verify?: {
    urlContains?: string;
    titleContains?: string;
  };
}

export interface RenderedFetchResult {
  requestedUrl: string;
  finalUrl: string;
  title: string;
  html: string;
  contentSha256: string;
  contentBytes: number;
  statusCode: number | null;
  contentType: string | null;
  capturedAt: string;
}

export class BrowserGateway {
  readonly leases: LeaseManager;
  readonly queue = new PerTabFifo();
  readonly policy: ProtectedTabPolicy;
  readonly environment = new EnvironmentPolicy();
  private readonly idempotency = new IdempotencyStore();
  private readonly consoleEvents = new Map<string, RingBuffer<BrowserEvent>>();
  private readonly networkEvents = new Map<string, RingBuffer<BrowserEvent>>();
  private readonly lifecycleEvents = new Map<string, RingBuffer<BrowserEvent>>();
  private readonly requestOwners = new Map<string, string>();
  private readonly requestOrder = new Map<string, RingBuffer<string>>();
  private readonly contexts = new Map<string, BrowserContext>();
  private contextCleanupTimer?: NodeJS.Timeout;
  private removeEventListener?: () => void;

  constructor(
    readonly config: GatewayConfig,
    readonly driver: BrowserDriver,
    private readonly audit: AuditSink
  ) {
    this.leases = new LeaseManager(config.leaseTtlMs, config.maxLeaseTtlMs);
    this.policy = new ProtectedTabPolicy(config.protectedPatterns, new Set(config.protectedAgents));
  }

  async start(): Promise<void> {
    this.leases.startCleanup();
    this.contextCleanupTimer = setInterval(() => void this.cleanupExpiredContexts(), this.config.contextCleanupIntervalMs);
    this.contextCleanupTimer.unref();
    this.removeEventListener = this.driver.onEvent((event) => this.observe(event));
    await this.driver.start();
  }

  async stop(): Promise<void> {
    this.removeEventListener?.();
    this.removeEventListener = undefined;
    this.leases.stopCleanup();
    if (this.contextCleanupTimer) clearInterval(this.contextCleanupTimer);
    this.contextCleanupTimer = undefined;
    await this.driver.stop();
  }

  status(): Record<string, unknown> {
    return {
      service: 'browser-gateway',
      version: '0.2.0',
      browser: this.driver.status(),
      leases: this.leases.list().length,
      observedPages: new Set([
        ...this.consoleEvents.keys(),
        ...this.networkEvents.keys(),
        ...this.lifecycleEvents.keys()
      ]).size
    };
  }

  async listTabs(agentId?: string, browserContextId?: string): Promise<TabView[]> {
    const tabs = await this.driver.listTabs();
    const browserSessionId = this.driver.status().browserSessionId;
    return tabs.filter((tab) => !browserContextId || tab.browserContextId === browserContextId).map((tab) => {
      const decision = this.policy.inspect(tab.url, agentId);
      return {
        ...tab,
        ...(browserSessionId ? { browserSessionId } : {}),
        protected: decision.protected,
        ...(decision.matchedPattern ? { matchedProtectedPattern: decision.matchedPattern } : {}),
        ...(this.leases.get(tab.pageId) ? { lease: publicLease(this.leases.get(tab.pageId)!) } : {}),
        queueDepth: this.queue.depth(tab.pageId)
      };
    });
  }

  async openTab(url: string, metadata: MutationMetadata, options: OpenTabOptions = {}): Promise<DriverTab> {
    const operation = async (): Promise<DriverTab> => {
      this.policy.assertMutationAllowed(url, metadata.context.agentId);
      this.assertContextAccess(options.browserContextId, metadata.context.agentId);
      try {
        const tab = await this.driver.openTab(url, options);
        await this.writeAudit('open_tab', 'success', metadata.context, tab.pageId, {
          destinationOrigin: safeOrigin(url),
          ...(options.browserContextId ? { browserContextId: options.browserContextId } : {}),
          ...(options.newWindow ? { newWindow: true } : {})
        });
        return tab;
      } catch (error) {
        await this.writeAuditError('open_tab', metadata.context, undefined, error, {
          destinationOrigin: safeOrigin(url)
        });
        throw error;
      }
    };
    return this.idempotent(metadata, { url, ...options }, operation);
  }

  async createBrowserContext(
    input: { owner: string; ttlMs?: number; incognito?: boolean; name?: string },
    metadata: MutationMetadata
  ): Promise<BrowserContext> {
    if (!input.owner.trim()) throw new GatewayError('CONTEXT_OWNER_MISMATCH', 'Context owner is required');
    if (input.owner !== metadata.context.agentId) {
      throw new GatewayError('CONTEXT_OWNER_MISMATCH', 'Context owner must match agentId', {
        owner: input.owner,
        agentId: metadata.context.agentId
      });
    }
    if (input.incognito === false) {
      throw new GatewayError('INVALID_CONFIG', 'Custom browser contexts are incognito-like; incognito=false is unsupported');
    }
    const ttlMs = Math.min(Math.max(100, input.ttlMs ?? 1_800_000), 86_400_000);
    const created = await this.driver.createBrowserContext();
    const now = Date.now();
    const context: BrowserContext = {
      browserContextId: created.browserContextId,
      owner: input.owner,
      incognito: true,
      ...(input.name ? { name: input.name } : {}),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttlMs).toISOString()
    };
    this.contexts.set(context.browserContextId, context);
    await this.writeAudit('create_browser_context', 'success', metadata.context, undefined, {
      browserContextId: context.browserContextId,
      owner: context.owner,
      expiresAt: context.expiresAt
    });
    return context;
  }

  async disposeBrowserContext(
    browserContextId: string,
    input: { force?: boolean },
    metadata: MutationMetadata
  ): Promise<{ disposed: true; closedPages: string[] }> {
    const context = this.contexts.get(browserContextId);
    if (!context) throw new GatewayError('CONTEXT_NOT_FOUND', 'No managed browser context exists', { browserContextId });
    if (context.owner !== metadata.context.agentId) {
      throw new GatewayError('CONTEXT_OWNER_MISMATCH', 'Only the context owner may dispose it', {
        browserContextId,
        owner: context.owner,
        agentId: metadata.context.agentId
      });
    }
    const pages = (await this.driver.listTabs()).filter((tab) => tab.browserContextId === browserContextId);
    const active = pages.map((tab) => this.leases.get(tab.pageId)).filter((lease): lease is NonNullable<typeof lease> => Boolean(lease));
    if (active.length && !input.force) {
      throw new GatewayError('CONTEXT_HAS_ACTIVE_LEASES', 'Context contains actively leased pages', {
        browserContextId,
        pageIds: active.map((lease) => lease.pageId)
      });
    }
    if (input.force) for (const lease of active) this.leases.releaseIfOwned(lease.pageId, lease.leaseId);
    await this.driver.disposeBrowserContext(browserContextId);
    this.contexts.delete(browserContextId);
    const closedPages = pages.map((page) => page.pageId);
    await this.writeAudit('dispose_browser_context', 'success', metadata.context, undefined, {
      browserContextId,
      closedPages,
      force: Boolean(input.force)
    });
    return { disposed: true, closedPages };
  }

  /**
   * Fetch one HTTP(S) page through the shared browser and return its rendered
   * DOM. Creates/closes only its own temporary page; never clicks, submits,
   * solves challenges, or reads browser storage.
   */
  async fetchRenderedPage(
    url: string,
    options: { timeoutMs: number; maxBytes: number },
    metadata: MutationMetadata
  ): Promise<RenderedFetchResult> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new GatewayError('INVALID_FETCH_URL', 'A valid HTTP(S) URL is required');
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new GatewayError('INVALID_FETCH_URL', 'Only credential-free HTTP(S) URLs are allowed');
    }
    this.policy.assertMutationAllowed(parsed.href, metadata.context.agentId);

    const deadline = Date.now() + options.timeoutMs;
    const remainingMs = (): number => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new GatewayError('WAIT_TIMEOUT', 'Rendered fetch deadline expired');
      return remaining;
    };
    let page: DriverTab | undefined;
    let leaseId: string | undefined;
    let operationErrorCode: string | undefined;
    let operationFailure: unknown;
    let cleanupFailure: GatewayError | undefined;
    let result: RenderedFetchResult | undefined;
    try {
      const existingPageIds = new Set((await this.listTabs(metadata.context.agentId)).map((tab) => tab.pageId));
      remainingMs();
      // Attach and enable observation before the one requested navigation.
      // Ordinary open_tab keeps its existing behavior.
      page = await this.openTab('about:blank', metadata);
      if (existingPageIds.has(page.pageId)) {
        page = undefined; // Never close a target that existed before this request.
        throw new GatewayError('INTERNAL_ERROR', 'Temporary fetch did not create a distinct page');
      }
      const lease = await this.claimTab(page.pageId, metadata.context,
        Math.min(remainingMs(), this.config.maxLeaseTtlMs));
      leaseId = lease.leaseId;
      await this.navigate(page.pageId, parsed.href,
        { waitUntil: 'networkidle', timeoutMs: remainingMs() }, { ...metadata, leaseId });
      remainingMs();
      await this.waitForCommittedDocument(page.pageId, deadline);
      const document = await this.driver.evaluate(
        page.pageId,
        '({url:location.href,title:document.title,html:document.documentElement.outerHTML})'
      ) as { url?: unknown; title?: unknown; html?: unknown } | null;
      if (!document || typeof document.url !== 'string' || typeof document.html !== 'string') {
        throw new GatewayError('INTERNAL_ERROR', 'Rendered document was unavailable');
      }
      const inspected = await this.driver.inspectPage(page.pageId);
      remainingMs();
      if (!isCommittedHttpUrl(document.url) || !isCommittedHttpUrl(inspected.url)
        || document.url !== inspected.url || !document.html.trim()) {
        throw new GatewayError('INTERNAL_ERROR', 'Rendered document identity or content was incomplete');
      }
      const contentBytes = Buffer.byteLength(document.html, 'utf8');
      if (contentBytes > options.maxBytes) {
        throw new GatewayError('FETCH_BODY_TOO_LARGE', 'Rendered document exceeds the requested byte limit', {
          contentBytes,
          maxBytes: options.maxBytes
        });
      }
      const withoutFragment = (value: unknown): string | undefined => {
        if (typeof value !== 'string' || !isCommittedHttpUrl(value)) return undefined;
        const observed = new URL(value);
        observed.hash = '';
        return observed.href;
      };
      const finalDocumentUrl = withoutFragment(inspected.url);
      const mainFrame = this.lifecycleList(page.pageId, this.config.eventBufferSize)
        .filter((event) => event.method === 'Page.frameNavigated')
        .map((event) => event.data['frame'] as Record<string, unknown> | undefined)
        .reverse().find((frame) => frame && frame['parentId'] === undefined);
      const frameBound = mainFrame && typeof mainFrame['id'] === 'string'
        && typeof mainFrame['loaderId'] === 'string' && mainFrame['loaderId'].length > 0
        && withoutFragment(mainFrame['url']) === finalDocumentUrl;
      const network = this.networkList(page.pageId, this.config.eventBufferSize);
      const responses = network
        .filter((event) => event.method === 'Network.responseReceived')
        .map((event) => ({
          data: event.data,
          response: event.data['response'] as Record<string, unknown> | undefined
        }))
        .filter(({ data, response }) => frameBound && data['type'] === 'Document'
          && data['frameId'] === mainFrame['id'] && data['loaderId'] === mainFrame['loaderId']
          && typeof data['requestId'] === 'string'
          && withoutFragment(response?.['url']) === finalDocumentUrl
          && network.some((event) => event.method === 'Network.requestWillBeSent'
            && event.data['type'] === 'Document' && event.data['requestId'] === data['requestId']
            && event.data['frameId'] === data['frameId'] && event.data['loaderId'] === data['loaderId']
            && withoutFragment((event.data['request'] as Record<string, unknown> | undefined)?.['url']) === finalDocumentUrl));
      const response = responses.length === 1 ? responses[0]?.response : undefined;
      const headers = response?.['headers'] as Record<string, unknown> | undefined;
      const contentTypeEntry = Object.entries(headers ?? {})
        .find(([key]) => key.toLowerCase() === 'content-type')?.[1];
      const status = response?.['status'];
      const contentType = typeof contentTypeEntry === 'string'
        ? contentTypeEntry
        : typeof response?.['mimeType'] === 'string' ? response['mimeType'] : null;
      result = {
        requestedUrl: parsed.href,
        finalUrl: inspected.url,
        title: typeof document.title === 'string' ? document.title : inspected.title,
        html: document.html,
        contentSha256: createHash('sha256').update(document.html, 'utf8').digest('hex'),
        contentBytes,
        statusCode: typeof status === 'number' && Number.isInteger(status) ? status : null,
        contentType,
        capturedAt: new Date().toISOString()
      };
      await this.writeAudit('fetch_rendered_page', 'success', metadata.context, page.pageId, {
        requestedUrl: result.requestedUrl,
        finalUrl: result.finalUrl,
        contentSha256: result.contentSha256,
        contentBytes: result.contentBytes,
        statusCode: result.statusCode
      });
    } catch (error) {
      const failure = Date.now() >= deadline
        ? new GatewayError('WAIT_TIMEOUT', 'Rendered fetch deadline expired') : error;
      operationErrorCode = asGatewayError(failure).code;
      await this.writeAuditError('fetch_rendered_page', metadata.context, page?.pageId, failure);
      operationFailure = failure;
    } finally {
      if (page && leaseId) {
        await this.releaseTab(page.pageId, leaseId, metadata.context).catch(() => undefined);
      }
      if (page) {
        try {
          await this.closeTab(page.pageId, metadata);
        } catch (error) {
          cleanupFailure = new GatewayError(
            'INTERNAL_ERROR',
            'Rendered fetch cleanup is unknown; the owned temporary page may remain open',
            {
              pageId: page.pageId,
              cleanup: 'unknown',
              closeErrorCode: asGatewayError(error).code,
              ...(operationErrorCode ? { operationErrorCode } : {})
            }
          );
          await this.writeAuditError('fetch_rendered_page_cleanup', metadata.context,
            page.pageId, cleanupFailure).catch(() => undefined);
          // Defer throwing until after finally so cleanup uncertainty cannot be
          // silently overridden by a return or an earlier operation error.
        }
      }
    }
    if (cleanupFailure) throw cleanupFailure;
    if (operationFailure) throw operationFailure;
    if (!result) throw new GatewayError('INTERNAL_ERROR', 'Rendered fetch produced no result');
    return result;
  }

  async closeTab(pageId: string, metadata: MutationMetadata): Promise<{ pageId: string; closed: true }> {
    return this.mutate(pageId, 'close_tab', metadata, {}, async () => {
      await this.driver.closeTab(pageId);
      return { pageId, closed: true as const };
    });
  }

  private async waitForCommittedDocument(pageId: string, deadline: number): Promise<void> {
    const expression = '({url:location.href,readyState:document.readyState})';
    while (Date.now() < deadline) {
      const state = await this.driver.evaluate(pageId, expression) as {
        url?: unknown;
        readyState?: unknown;
      } | null;
      if (Date.now() <= deadline && state && typeof state.url === 'string' && isCommittedHttpUrl(state.url)
        && (state.readyState === 'interactive' || state.readyState === 'complete')) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(50, Math.max(1, deadline - Date.now()))));
    }
    throw new GatewayError('WAIT_TIMEOUT', 'Timed out waiting for a committed HTTP document', { pageId });
  }

  async navigate(
    pageId: string,
    url: string,
    options: NavigationOptions,
    metadata: MutationMetadata
  ): Promise<{ pageId: string; url: string; title: string }> {
    this.policy.assertMutationAllowed(url, metadata.context.agentId);
    return this.mutate(pageId, 'navigate', metadata, { url, options }, () =>
      this.driver.navigate(pageId, url, options)
    );
  }

  async click(
    pageId: string,
    locator: ElementLocator,
    metadata: MutationMetadata
  ): Promise<ReturnType<BrowserDriver['click']>> {
    return this.mutate(pageId, 'click', metadata, { locator }, () => this.driver.click(pageId, locator));
  }

  async fill(
    pageId: string,
    locator: ElementLocator,
    value: string,
    metadata: MutationMetadata
  ): Promise<ReturnType<BrowserDriver['fill']>> {
    return this.mutate(
      pageId,
      'fill',
      metadata,
      { locator, valueLength: value.length, valueHash: hash(value) },
      () => this.driver.fill(pageId, locator, value)
    );
  }

  async waitFor(pageId: string, options: WaitForOptions): ReturnType<BrowserDriver['waitFor']> {
    await this.requireTab(pageId);
    return this.driver.waitFor(pageId, options);
  }

  async pressKey(pageId: string, key: string, metadata: MutationMetadata): ReturnType<BrowserDriver['pressKey']> {
    return this.mutate(pageId, 'press_key', metadata, { key }, () => this.driver.pressKey(pageId, key));
  }

  async typeText(pageId: string, text: string, metadata: MutationMetadata): ReturnType<BrowserDriver['typeText']> {
    return this.mutate(pageId, 'type_text', metadata, { textLength: text.length, textHash: hash(text) }, () =>
      this.driver.typeText(pageId, text)
    );
  }

  async hover(pageId: string, locator: ElementLocator, metadata: MutationMetadata): ReturnType<BrowserDriver['hover']> {
    return this.mutate(pageId, 'hover', metadata, { locator }, () => this.driver.hover(pageId, locator));
  }

  async clickAt(pageId: string, x: number, y: number, metadata: MutationMetadata): ReturnType<BrowserDriver['clickAt']> {
    return this.mutate(pageId, 'click_at', metadata, { x, y }, () => this.driver.clickAt(pageId, x, y));
  }

  async drag(pageId: string, from: ElementLocator, to: ElementLocator, metadata: MutationMetadata): ReturnType<BrowserDriver['drag']> {
    return this.mutate(pageId, 'drag', metadata, { from, to }, () => this.driver.drag(pageId, from, to));
  }

  async handleDialog(
    pageId: string,
    accept: boolean,
    promptText: string | undefined,
    metadata: MutationMetadata
  ): ReturnType<BrowserDriver['handleDialog']> {
    return this.mutate(
      pageId,
      'handle_dialog',
      metadata,
      { accept, ...(promptText === undefined ? {} : { promptTextLength: promptText.length }) },
      () => this.driver.handleDialog(pageId, accept, promptText)
    );
  }

  async snapshot(pageId: string, maxNodes: number): ReturnType<BrowserDriver['snapshot']> {
    await this.requireTab(pageId);
    return this.driver.snapshot(pageId, maxNodes);
  }

  async screenshot(
    pageId: string,
    options: ScreenshotOptions
  ): ReturnType<BrowserDriver['screenshot']> {
    await this.requireTab(pageId);
    return this.driver.screenshot(pageId, options);
  }

  /** Classify a page's environment tier (local/test/remote/prod) for write-safety gating. */
  async classifyPage(pageId: string): Promise<EnvironmentDecision> {
    const tab = await this.requireTab(pageId);
    return this.environment.classify(tab.url);
  }

  /**
   * Run JavaScript in a page. `write=true` marks the call as mutating: it passes
   * through the protected-tab policy AND the environment gate. On a non-local
   * environment a mutating evaluate requires confirm=true, otherwise it is blocked
   * with a warning the agent must relay to the user. Output is redacted.
   */
  async evaluate(
    pageId: string,
    expression: string,
    options: { write: boolean; confirm: boolean; frameUrl?: string },
    metadata: MutationMetadata
  ): Promise<{ pageId: string; value: unknown; environment: EnvironmentDecision }> {
    const tab = await this.requireTab(pageId);
    const environment = this.environment.classify(tab.url);

    if (!options.write) {
      // Read-only evaluate: no lease, no environment gate. Output redacted.
      const value = await this.driver.evaluate(pageId, expression, options.frameUrl);
      return { pageId, value: redact(value), environment };
    }

    // Mutating evaluate: protected-tab policy + environment confirm gate + lease (via mutate).
    this.policy.assertMutationAllowed(tab.url, metadata.context.agentId);
    if (environment.writeNeedsConfirm && !options.confirm) {
      throw new GatewayError('WRITE_CONFIRM_REQUIRED', environment.reason, {
        pageId,
        tier: environment.tier,
        host: environment.host,
        hint: 'This is a mutating evaluate on a non-local environment. Ask the user to approve, then retry with confirm=true.'
      });
    }
    const value = await this.mutate(
      pageId,
      'evaluate_write',
      metadata,
      { tier: environment.tier, host: environment.host, expressionHash: hash(expression) },
      () => this.driver.evaluate(pageId, expression, options.frameUrl)
    );
    return { pageId, value: redact(value), environment };
  }

  /** Read localStorage, sessionStorage and cookies. Read-only; output redacted. */
  async readStorage(
    pageId: string,
    include: { cookies: boolean }
  ): Promise<{ pageId: string; local: Record<string, string>; session: Record<string, string>; cookies: string; environment: EnvironmentDecision }> {
    const tab = await this.requireTab(pageId);
    const environment = this.environment.classify(tab.url);
    const raw = await this.driver.readStorage(pageId);
    const safe = redact({
      local: raw.local,
      session: raw.session,
      cookies: include.cookies ? raw.cookies : '[OMITTED]'
    }) as { local: Record<string, string>; session: Record<string, string>; cookies: string };
    return { pageId, ...safe, environment };
  }


  consoleList(pageId: string, limit = 100): BrowserEvent[] {
    return this.consoleEvents.get(pageId)?.values(limit) ?? [];
  }

  networkList(pageId: string, limit = 100): BrowserEvent[] {
    return this.networkEvents.get(pageId)?.values(limit) ?? [];
  }

  lifecycleList(pageId: string, limit = 100): BrowserEvent[] {
    return this.lifecycleEvents.get(pageId)?.values(limit) ?? [];
  }

  async getResponseBody(
    pageId: string,
    requestId: string,
    context: AgentContext
  ): Promise<{ body: string; base64Encoded: boolean; truncated: boolean; originalBytes: number }> {
    await this.requireTab(pageId);
    if (!this.requestOwners.has(requestKey(pageId, requestId))) {
      throw new GatewayError('RESPONSE_BODY_UNAVAILABLE', 'The request is unknown for this page', {
        pageId,
        requestId
      });
    }
    try {
      const result = await this.driver.getResponseBody(pageId, requestId);
      const bytes = result.base64Encoded
        ? Buffer.from(result.body, 'base64')
        : Buffer.from(result.body, 'utf8');
      const truncated = bytes.length > this.config.maxResponseBodyBytes;
      const output = truncated ? bytes.subarray(0, this.config.maxResponseBodyBytes) : bytes;
      await this.writeAudit('network_get_response_body', 'success', context, pageId, {
        requestId,
        originalBytes: bytes.length,
        truncated
      });
      return {
        body: result.base64Encoded ? output.toString('base64') : output.toString('utf8'),
        base64Encoded: result.base64Encoded,
        truncated,
        originalBytes: bytes.length
      };
    } catch (error) {
      await this.writeAuditError('network_get_response_body', context, pageId, error, { requestId });
      throw error;
    }
  }

  async claimTab(pageId: string, context: AgentContext, ttlMs?: number): Promise<PublicRuntimeLease> {
    const tab = await this.requireTab(pageId);
    this.policy.assertMutationAllowed(tab.url, context.agentId);
    try {
      const lease = this.leases.claim(pageId, context, ttlMs);
      await this.writeAudit('claim_tab', 'success', context, pageId, {
        leaseId: lease.leaseId,
        expiresAt: lease.expiresAt
      });
      return publicLease(lease);
    } catch (error) {
      await this.writeAuditError('claim_tab', context, pageId, error);
      throw error;
    }
  }

  async releaseTab(
    pageId: string,
    leaseId: string,
    context: AgentContext
  ): Promise<PublicRuntimeLease> {
    try {
      const lease = this.leases.release(pageId, leaseId, context);
      await this.writeAudit('release_tab', 'success', context, pageId, { leaseId });
      return publicLease(lease);
    } catch (error) {
      await this.writeAuditError('release_tab', context, pageId, error, { leaseId });
      throw error;
    }
  }

  async releaseClientSession(clientSessionId: string): Promise<void> {
    const released = this.leases.releaseClientSession(clientSessionId);
    for (const lease of released) {
      await this.audit.write({
        action: 'lease_client_session_cleanup',
        outcome: 'success',
        agentId: lease.agentId,
        taskId: lease.taskId,
        leaseOwnerId: lease.leaseOwnerId,
        pageId: lease.pageId,
        details: { leaseId: lease.leaseId }
      });
    }
  }

  async runAtomic(input: RunAtomicInput): Promise<Record<string, unknown>> {
    const fingerprint = hash({
      pageId: input.pageId,
      agentId: input.context.agentId,
      taskId: input.context.taskId,
      leaseTtlMs: input.leaseTtlMs,
      action: input.action,
      verify: input.verify
    });
    return this.idempotency.run(
      `${input.context.agentId}:${input.context.taskId}`,
      input.idempotencyKey,
      fingerprint,
      () =>
        this.queue.enqueue(input.pageId, async () => {
          const tab = await this.requireTab(input.pageId);
          this.policy.assertMutationAllowed(tab.url, input.context.agentId);
          this.policy.assertMutationAllowed(input.action.url, input.context.agentId);
          const existing = this.leases.assertCanMutate(input.pageId, input.context);
          const lease = existing ?? this.leases.claim(input.pageId, input.context, input.leaseTtlMs);
          const ephemeral = existing === undefined;
          try {
            const actionResult = await this.driver.navigate(input.pageId, input.action.url, {
              waitUntil: input.action.waitUntil,
              timeoutMs: input.action.timeoutMs
            });
            const inspected = await this.driver.inspectPage(input.pageId);
            const verification = {
              urlMatches:
                input.verify?.urlContains === undefined || inspected.url.includes(input.verify.urlContains),
              titleMatches:
                input.verify?.titleContains === undefined || inspected.title.includes(input.verify.titleContains)
            };
            if (!verification.urlMatches || !verification.titleMatches) {
              throw new Error('Atomic verification failed');
            }
            const result = {
              pageId: input.pageId,
              leaseId: lease.leaseId,
              leaseReleased: ephemeral,
              actionResult,
              verification
            };
            await this.writeAudit('run_atomic', 'success', input.context, input.pageId, {
              action: input.action.type,
              verification
            });
            return result;
          } catch (error) {
            await this.writeAuditError('run_atomic', input.context, input.pageId, error, {
              action: input.action.type
            });
            throw error;
          } finally {
            if (ephemeral) this.leases.releaseIfOwned(input.pageId, lease.leaseId);
          }
        })
    );
  }

  private async mutate<T>(
    pageId: string,
    action: string,
    metadata: MutationMetadata,
    input: Record<string, unknown>,
    operation: () => Promise<T>
  ): Promise<T> {
    const run = () =>
      this.queue.enqueue(pageId, async () => {
        const tab = await this.requireTab(pageId);
        this.policy.assertMutationAllowed(tab.url, metadata.context.agentId);
        const existing = this.leases.assertCanMutate(pageId, metadata.context, metadata.leaseId);
        const lease = existing ?? this.leases.claim(pageId, metadata.context);
        const ephemeral = existing === undefined;
        try {
          const result = await operation();
          await this.writeAudit(action, 'success', metadata.context, pageId, input);
          return result;
        } catch (error) {
          await this.writeAuditError(action, metadata.context, pageId, error, input);
          throw error;
        } finally {
          if (ephemeral) this.leases.releaseIfOwned(pageId, lease.leaseId);
        }
      });
    return this.idempotent(metadata, { pageId, action, ...input }, run);
  }

  private idempotent<T>(
    metadata: MutationMetadata,
    input: Record<string, unknown>,
    operation: () => Promise<T>
  ): Promise<T> {
    if (!metadata.idempotencyKey) return operation();
    return this.idempotency.run(
      `${metadata.context.agentId}:${metadata.context.taskId}`,
      metadata.idempotencyKey,
      hash(input),
      operation
    );
  }

  private async requireTab(pageId: string): Promise<DriverTab> {
    const tab = (await this.driver.listTabs()).find((candidate) => candidate.pageId === pageId);
    if (!tab) throw new GatewayError('TAB_NOT_FOUND', 'No page target exists for pageId', { pageId });
    return tab;
  }

  private assertContextAccess(browserContextId: string | undefined, agentId: string): void {
    if (!browserContextId || browserContextId === 'default') return;
    const context = this.contexts.get(browserContextId);
    if (!context) throw new GatewayError('CONTEXT_NOT_FOUND', 'No managed browser context exists', { browserContextId });
    if (context.owner !== agentId) {
      throw new GatewayError('CONTEXT_OWNER_MISMATCH', 'Context belongs to another agent', {
        browserContextId,
        owner: context.owner,
        agentId
      });
    }
  }

  private async cleanupExpiredContexts(): Promise<void> {
    const now = Date.now();
    for (const context of [...this.contexts.values()]) {
      if (Date.parse(context.expiresAt) > now) continue;
      const pages = (await this.driver.listTabs().catch(() => []))
        .filter((tab) => tab.browserContextId === context.browserContextId);
      for (const lease of this.leases.list().filter((entry) => pages.some((page) => page.pageId === entry.pageId))) {
        this.leases.releaseIfOwned(lease.pageId, lease.leaseId);
      }
      try {
        await this.driver.disposeBrowserContext(context.browserContextId);
        this.contexts.delete(context.browserContextId);
        await this.audit.write({
          action: 'dispose_browser_context',
          outcome: 'success',
          agentId: context.owner,
          taskId: 'context-ttl-cleanup',
          leaseOwnerId: 'gateway',
          details: { browserContextId: context.browserContextId, closedPages: pages.map((page) => page.pageId), expired: true }
        });
      } catch (error) {
        await this.audit.write({
          action: 'dispose_browser_context',
          outcome: 'error',
          agentId: context.owner,
          taskId: 'context-ttl-cleanup',
          leaseOwnerId: 'gateway',
          details: { browserContextId: context.browserContextId, error: asGatewayError(error).toJSON() }
        });
      }
    }
  }

  private observe(event: BrowserEvent): void {
    const pageId = event.pageId ?? '__browser__';
    const clean = redact(event);
    const buffers =
      event.kind === 'console'
        ? this.consoleEvents
        : event.kind === 'network'
          ? this.networkEvents
          : this.lifecycleEvents;
    let buffer = buffers.get(pageId);
    if (!buffer) {
      buffer = new RingBuffer<BrowserEvent>(this.config.eventBufferSize);
      buffers.set(pageId, buffer);
    }
    buffer.push(clean);
    if (event.method === 'Network.requestWillBeSent') {
      const requestId = event.data['requestId'];
      if (typeof requestId === 'string' && event.pageId) {
        this.requestOwners.set(requestKey(event.pageId, requestId), event.pageId);
        let order = this.requestOrder.get(event.pageId);
        if (!order) {
          order = new RingBuffer<string>(this.config.eventBufferSize);
          this.requestOrder.set(event.pageId, order);
        }
        const evicted = order.push(requestId);
        if (evicted) this.requestOwners.delete(requestKey(event.pageId, evicted));
      }
    }
  }

  private writeAudit(
    action: string,
    outcome: AuditEvent['outcome'],
    context: AgentContext,
    pageId?: string,
    details?: Record<string, unknown>
  ): Promise<void> {
    return this.audit.write({
      action,
      outcome,
      agentId: context.agentId,
      taskId: context.taskId,
      leaseOwnerId: context.leaseOwnerId,
      clientSessionId: context.clientSessionId,
      ...(context.correlationId ? { correlationId: context.correlationId } : {}),
      ...(pageId ? { pageId } : {}),
      ...(details ? { details: safeAuditDetails(details) } : {})
    });
  }

  private writeAuditError(
    action: string,
    context: AgentContext,
    pageId: string | undefined,
    error: unknown,
    details?: Record<string, unknown>
  ): Promise<void> {
    const normalized = asGatewayError(error);
    return this.audit.write({
      action,
      outcome: 'error',
      agentId: context.agentId,
      taskId: context.taskId,
      leaseOwnerId: context.leaseOwnerId,
      clientSessionId: context.clientSessionId,
      ...(context.correlationId ? { correlationId: context.correlationId } : {}),
      ...(pageId ? { pageId } : {}),
      errorCode: normalized.code,
      ...(details ? { details: safeAuditDetails(details) } : {})
    });
  }
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function safeOrigin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return '[INVALID_URL]';
  }
}

function isCommittedHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && parsed.hostname.length > 0;
  } catch {
    return false;
  }
}

function safeAuditDetails(details: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(details).map(([key, value]) => [
      key,
      typeof value === 'string' && /url$/i.test(key) ? safeOrigin(value) : value
    ])
  );
}

function requestKey(pageId: string, requestId: string): string {
  return `${pageId}\u0000${requestId}`;
}

function publicLease(lease: RuntimeLease): PublicRuntimeLease {
  return {
    leaseId: lease.leaseId,
    pageId: lease.pageId,
    leaseOwnerId: lease.leaseOwnerId,
    agentId: lease.agentId,
    taskId: lease.taskId,
    createdAt: lease.createdAt,
    expiresAt: lease.expiresAt
  };
}
