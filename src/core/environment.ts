/**
 * Environment classification for write-safety gating.
 *
 * A page URL is classified into a risk tier. Reads are allowed on any tier;
 * writes (evaluate, navigate, click, fill, ...) escalate the required grant:
 *
 *   local   -> free       (loopback: localhost / 127.0.0.1 / ::1)
 *   test    -> warn        (ci / qa / staging / test / dev / iot* -- non-loopback dev systems)
 *   remote  -> confirm     (any other non-loopback host)
 *   prod    -> confirm+    (matches a production pattern)
 *
 * Patterns are configurable so nothing environment-specific is hardcoded.
 */

export type EnvironmentTier = 'local' | 'test' | 'remote' | 'prod';

export interface EnvironmentDecision {
  tier: EnvironmentTier;
  host: string;
  /** True when a mutating action on this tier should require explicit confirmation. */
  writeNeedsConfirm: boolean;
  /** Human-readable reason, surfaced to the agent so it can warn the user. */
  reason: string;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

export interface EnvironmentPatterns {
  /** Substrings/globs that mark a host as a non-prod test system (ci, qa, staging...). */
  test: string[];
  /** Substrings/globs that mark a host as production. */
  prod: string[];
}

export const DEFAULT_ENVIRONMENT_PATTERNS: EnvironmentPatterns = {
  test: ['ci', 'qa', 'staging', 'stage', 'test', 'dev', 'sandbox', 'iot', 'preprod', 'uat'],
  prod: ['prod', 'production', 'live']
};

export class EnvironmentPolicy {
  constructor(private readonly patterns: EnvironmentPatterns = DEFAULT_ENVIRONMENT_PATTERNS) {}

  classify(url: string): EnvironmentDecision {
    let host = '';
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      // Unparseable URL -> treat as remote (safer than assuming local).
      return {
        tier: 'remote',
        host: url,
        writeNeedsConfirm: true,
        reason: 'URL could not be parsed; treating as a remote environment'
      };
    }

    if (LOOPBACK.has(host)) {
      return { tier: 'local', host, writeNeedsConfirm: false, reason: 'Loopback host -- local development' };
    }

    if (matchesAny(host, this.patterns.prod)) {
      return {
        tier: 'prod',
        host,
        writeNeedsConfirm: true,
        reason: `Host "${host}" looks like PRODUCTION -- writes are high risk`
      };
    }

    if (matchesAny(host, this.patterns.test)) {
      return {
        tier: 'test',
        host,
        writeNeedsConfirm: true,
        reason: `Host "${host}" looks like a shared test/CI environment -- writes affect others`
      };
    }

    return {
      tier: 'remote',
      host,
      writeNeedsConfirm: true,
      reason: `Host "${host}" is remote (non-loopback) -- writes are not local`
    };
  }
}

function matchesAny(host: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    const p = pattern.trim().toLowerCase();
    if (!p) return false;
    if (p.includes('*')) {
      const escaped = p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');
      return new RegExp(`(^|[.\\-_])${escaped}([.\\-_]|$)|${escaped}`, 'i').test(host);
    }
    // token-boundary match, allowing trailing digits (prod, qa2, iot1, staging3...)
    return new RegExp(`(^|[.\\-_])${p}\\d*([.\\-_]|$)`, 'i').test(host);
  });
}
