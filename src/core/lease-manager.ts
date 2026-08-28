import { randomUUID } from 'node:crypto';

import { GatewayError } from '../errors.js';
import type { AgentContext } from '../types.js';

export interface RuntimeLease {
  leaseId: string;
  pageId: string;
  leaseOwnerId: string;
  agentId: string;
  taskId: string;
  clientSessionId: string;
  createdAt: string;
  expiresAt: string;
}

export class LeaseManager {
  private readonly leases = new Map<string, RuntimeLease>();
  private cleanupTimer?: NodeJS.Timeout;

  constructor(
    private readonly defaultTtlMs: number,
    private readonly maxTtlMs: number,
    private readonly now: () => number = Date.now
  ) {}

  startCleanup(intervalMs = Math.min(this.defaultTtlMs, 5_000)): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => this.cleanupExpired(), Math.max(100, intervalMs));
    this.cleanupTimer.unref();
  }

  stopCleanup(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = undefined;
  }

  claim(pageId: string, context: AgentContext, ttlMs = this.defaultTtlMs): RuntimeLease {
    this.cleanupPage(pageId);
    const existing = this.leases.get(pageId);
    const effectiveTtl = Math.min(Math.max(100, ttlMs), this.maxTtlMs);
    const expiresAtMs = this.now() + effectiveTtl;

    if (existing) {
      if (!sameOwner(existing, context)) {
        throw new GatewayError('LEASE_CONFLICT', 'The tab is leased by another task', {
          pageId,
          ownerAgentId: existing.agentId,
          ownerTaskId: existing.taskId,
          expiresAt: existing.expiresAt
        });
      }
      const renewed = {
        ...existing,
        clientSessionId: context.clientSessionId,
        expiresAt: new Date(expiresAtMs).toISOString()
      };
      this.leases.set(pageId, renewed);
      return renewed;
    }

    const lease: RuntimeLease = {
      leaseId: randomUUID(),
      pageId,
      leaseOwnerId: context.leaseOwnerId,
      agentId: context.agentId,
      taskId: context.taskId,
      clientSessionId: context.clientSessionId,
      createdAt: new Date(this.now()).toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString()
    };
    this.leases.set(pageId, lease);
    return lease;
  }

  assertCanMutate(pageId: string, context: AgentContext, leaseId?: string): RuntimeLease | undefined {
    const hadLease = this.leases.has(pageId);
    this.cleanupPage(pageId);
    const lease = this.leases.get(pageId);
    if (!lease) {
      if (leaseId && hadLease) {
        throw new GatewayError('LEASE_EXPIRED', 'The supplied lease has expired', { pageId });
      }
      if (leaseId) {
        throw new GatewayError('LEASE_EXPIRED', 'The supplied lease is no longer active', { pageId });
      }
      return undefined;
    }
    if (!sameOwner(lease, context) || (leaseId !== undefined && lease.leaseId !== leaseId)) {
      throw new GatewayError('LEASE_CONFLICT', 'The tab is leased by another task or lease ID', {
        pageId,
        ownerAgentId: lease.agentId,
        ownerTaskId: lease.taskId,
        expiresAt: lease.expiresAt
      });
    }
    return lease;
  }

  release(pageId: string, leaseId: string, context: AgentContext): RuntimeLease {
    const hadLease = this.leases.has(pageId);
    this.cleanupPage(pageId);
    const lease = this.leases.get(pageId);
    if (!lease) {
      throw new GatewayError('LEASE_EXPIRED', hadLease ? 'The lease has expired' : 'The lease is no longer active', {
        pageId
      });
    }
    if (lease.leaseId !== leaseId || !sameOwner(lease, context)) {
      throw new GatewayError('LEASE_CONFLICT', 'The lease belongs to another task', { pageId });
    }
    this.leases.delete(pageId);
    return lease;
  }

  releaseIfOwned(pageId: string, leaseId: string): boolean {
    const lease = this.leases.get(pageId);
    if (!lease || lease.leaseId !== leaseId) return false;
    this.leases.delete(pageId);
    return true;
  }

  releaseClientSession(clientSessionId: string): RuntimeLease[] {
    const released: RuntimeLease[] = [];
    for (const [pageId, lease] of this.leases) {
      if (lease.clientSessionId === clientSessionId) {
        this.leases.delete(pageId);
        released.push(lease);
      }
    }
    return released;
  }

  get(pageId: string): RuntimeLease | undefined {
    this.cleanupPage(pageId);
    return this.leases.get(pageId);
  }

  list(): RuntimeLease[] {
    this.cleanupExpired();
    return [...this.leases.values()];
  }

  cleanupExpired(): RuntimeLease[] {
    const expired: RuntimeLease[] = [];
    for (const [pageId, lease] of this.leases) {
      if (Date.parse(lease.expiresAt) <= this.now()) {
        this.leases.delete(pageId);
        expired.push(lease);
      }
    }
    return expired;
  }

  private cleanupPage(pageId: string): void {
    const lease = this.leases.get(pageId);
    if (lease && Date.parse(lease.expiresAt) <= this.now()) this.leases.delete(pageId);
  }
}

function sameOwner(lease: RuntimeLease, context: AgentContext): boolean {
  return (
    lease.leaseOwnerId === context.leaseOwnerId &&
    lease.agentId === context.agentId &&
    lease.taskId === context.taskId
  );
}
