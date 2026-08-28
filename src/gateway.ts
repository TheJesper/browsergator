import { createHash } from 'node:crypto';

import type { GatewayConfig } from './config.js';
import { asGatewayError, GatewayError } from './errors.js';
import type {
  AgentContext,
  BrowserDriver,
  BrowserEvent,
  DriverTab,
  NavigationOptions
} from './types.js';
import type { AuditEvent, AuditSink } from './core/audit-log.js';
import { IdempotencyStore } from './core/idempotency-store.js';
import { LeaseManager, type RuntimeLease } from './core/lease-manager.js';
import { PerTabFifo } from './core/per-tab-fifo.js';
import { ProtectedTabPolicy } from './core/policy.js';
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

export class BrowserGateway {
  readonly leases: LeaseManager;
  readonly queue = new PerTabFifo();
  readonly policy: ProtectedTabPolicy;
  private readonly idempotency = new IdempotencyStore();
  private readonly consoleEvents = new Map<string, RingBuffer<BrowserEvent>>();
  private readonly networkEvents = new Map<string, RingBuffer<BrowserEvent>>();
  private readonly lifecycleEvents = new Map<string, RingBuffer<BrowserEvent>>();
  private readonly requestOwners = new Map<string, string>();
  private readonly requestOrder = new Map<string, RingBuffer<string>>();
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
    this.removeEventListener = this.driver.onEvent((event) => this.observe(event));
    await this.driver.start();
  }

  async stop(): Promise<void> {
    this.removeEventListener?.();
    this.removeEventListener = undefined;
    this.leases.stopCleanup();
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

  async listTabs(agentId?: string): Promise<TabView[]> {
    const tabs = await this.driver.listTabs();
    const browserSessionId = this.driver.status().browserSessionId;
    return tabs.map((tab) => {
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

  async openTab(url: string, metadata: MutationMetadata): Promise<DriverTab> {
    const operation = async (): Promise<DriverTab> => {
      this.policy.assertMutationAllowed(url, metadata.context.agentId);
      try {
        const tab = await this.driver.openTab(url);
        await this.writeAudit('open_tab', 'success', metadata.context, tab.pageId, {
          destinationOrigin: safeOrigin(url)
        });
        return tab;
      } catch (error) {
        await this.writeAuditError('open_tab', metadata.context, undefined, error, {
          destinationOrigin: safeOrigin(url)
        });
        throw error;
      }
    };
    return this.idempotent(metadata, { url }, operation);
  }

  async closeTab(pageId: string, metadata: MutationMetadata): Promise<{ pageId: string; closed: true }> {
    return this.mutate(pageId, 'close_tab', metadata, {}, async () => {
      await this.driver.closeTab(pageId);
      return { pageId, closed: true as const };
    });
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

  async snapshot(pageId: string, maxNodes: number): ReturnType<BrowserDriver['snapshot']> {
    await this.requireTab(pageId);
    return this.driver.snapshot(pageId, maxNodes);
  }

  async screenshot(
    pageId: string,
    format: 'png' | 'jpeg',
    quality?: number
  ): ReturnType<BrowserDriver['screenshot']> {
    await this.requireTab(pageId);
    return this.driver.screenshot(pageId, format, quality);
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
