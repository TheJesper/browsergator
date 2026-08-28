import { GatewayError } from '../errors.js';

export interface ProtectedTabDecision {
  protected: boolean;
  matchedPattern?: string;
  authorized: boolean;
}

export class ProtectedTabPolicy {
  constructor(
    private readonly patterns: string[],
    private readonly authorizedAgents: Set<string>
  ) {}

  inspect(url: string, agentId?: string): ProtectedTabDecision {
    const matchedPattern = this.patterns.find((pattern) => matchesPattern(url, pattern));
    if (!matchedPattern) return { protected: false, authorized: true };
    return {
      protected: true,
      matchedPattern,
      authorized: agentId !== undefined && this.authorizedAgents.has(agentId)
    };
  }

  assertMutationAllowed(url: string, agentId: string): void {
    const decision = this.inspect(url, agentId);
    if (decision.protected && !decision.authorized) {
      throw new GatewayError('TAB_PROTECTED', 'The tab is protected from mutation by this agent', {
        matchedPattern: decision.matchedPattern
      });
    }
  }
}

function matchesPattern(url: string, pattern: string): boolean {
  const normalized = pattern.trim().toLowerCase();
  if (!normalized) return false;
  const escaped = normalized.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');
  return new RegExp(escaped, 'i').test(url);
}
