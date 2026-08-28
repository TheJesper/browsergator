import { describe, expect, it } from 'vitest';

import { GatewayError } from '../src/errors.js';
import { LeaseManager } from '../src/core/lease-manager.js';

describe('LeaseManager', () => {
  it('claims, renews, conflicts, expires, and releases by session', () => {
    let now = 1_000;
    const leases = new LeaseManager(500, 2_000, () => now);
    const owner = { agentId: 'a', taskId: 't', leaseOwnerId: 'owner-a', clientSessionId: 's1' };
    const other = { agentId: 'b', taskId: 't', leaseOwnerId: 'owner-b', clientSessionId: 's2' };

    const first = leases.claim('p1', owner);
    const renewed = leases.claim('p1', owner, 1_000);
    expect(renewed.leaseId).toBe(first.leaseId);
    expect(() => leases.claim('p1', other)).toThrowError(GatewayError);

    now = 2_001;
    expect(leases.get('p1')).toBeUndefined();
    expect(() => leases.release('p1', first.leaseId, owner)).toThrowError(
      expect.objectContaining({ code: 'LEASE_EXPIRED' })
    );

    const second = leases.claim('p1', owner);
    const third = leases.claim('p2', owner);
    expect(leases.releaseClientSession('s1').map((lease) => lease.leaseId).sort()).toEqual(
      [second.leaseId, third.leaseId].sort()
    );
    expect(leases.list()).toHaveLength(0);
  });

  it('reports an expired supplied lease', () => {
    let now = 0;
    const leases = new LeaseManager(100, 1_000, () => now);
    const owner = { agentId: 'a', taskId: 't', leaseOwnerId: 'owner-a', clientSessionId: 's' };
    const lease = leases.claim('p', owner);
    now = 101;
    expect(() => leases.assertCanMutate('p', owner, lease.leaseId)).toThrowError(
      expect.objectContaining({ code: 'LEASE_EXPIRED' })
    );
  });

  it('treats lease ownership as independent from the MCP client session', () => {
    const leases = new LeaseManager(500, 2_000);
    const firstSession = {
      agentId: 'subagent-a',
      taskId: 'task-1',
      leaseOwnerId: 'lease-owner-1',
      clientSessionId: 'client-session-1'
    };
    const secondSession = { ...firstSession, clientSessionId: 'client-session-2' };

    const claimed = leases.claim('p1', firstSession);
    const renewed = leases.claim('p1', secondSession);

    expect(renewed.leaseId).toBe(claimed.leaseId);
    expect(renewed.clientSessionId).toBe('client-session-2');
    expect(leases.releaseClientSession('client-session-1')).toEqual([]);
    expect(leases.get('p1')).toBeDefined();
  });
});
