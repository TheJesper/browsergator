// The contract every collector implements. A collector turns one dependable source (a local file, a
// documented API, an undocumented API, or data pushed by another tool) into readings.

import type { MeterRole, Reading, ResetRule } from '../../core/types.js';

/** How trustworthy and how stable the source is. Shown wherever a collector is offered. */
export type CollectorSourceKind = 'local-file' | 'documented-api' | 'undocumented-api' | 'push';

export interface CollectedMeter {
  /** Preset meter key within the provider's plan (`weekly`, `session`, `characters`). */
  key: string;
  reading: Reading;
  /** Used only when the account has no meter with this key and the preset has none either. */
  label?: string;
  /** The window's cadence, when the source reveals it. Used for a meter that has to be created. */
  reset?: ResetRule;
  /** `throttle` for short rate windows. Used for a meter that has to be created. */
  role?: MeterRole;
}

export interface CollectedAccount {
  providerId: string;
  /** Catalog plan id, when the source reveals the plan. */
  planId?: string;
  meters: CollectedMeter[];
  /**
   * Meter keys the source says this account does not have (a bucket it marks as disabled). An account
   * created from this reading leaves them out, however complete the catalog's preset is.
   */
  absent?: string[];
}

export interface CollectedSpend {
  providerId: string;
  label: string;
  currency: string;
  /** Daily totals; each replaces that day's stored total. */
  days: { date: string; amount: number }[];
}

export interface CollectorResult {
  accounts: CollectedAccount[];
  spend: CollectedSpend[];
  /** A short human-readable remark, such as "no current window found". */
  note?: string;
}

export interface CollectorContext {
  env: Readonly<Record<string, string | undefined>>;
  /** The user's home directory. */
  homeDir: string;
  nowMs: number;
  signal: AbortSignal;
  /**
   * HTTPS GET/POST restricted to `allowedHosts` of the collector: no other host, no cross-host redirect,
   * and a time limit. Collectors must use this instead of the global fetch.
   */
  fetchJson(url: string, init?: { method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: string }): Promise<unknown>;
}

export interface CollectorAvailability {
  ok: boolean;
  /** Why it cannot run, naming what is missing (a variable or a path) but never a value. */
  reason?: string;
}

export interface Collector {
  id: string;
  providerId: string;
  title: string;
  /** One or two sentences: what is read and from where. */
  description: string;
  sourceKind: CollectorSourceKind;
  /** Hosts this collector may contact. Empty for local sources. */
  allowedHosts: string[];
  /** Environment variables it needs, by name. */
  env: string[];
  intervalMinutes: number;
  available(context: Pick<CollectorContext, 'env' | 'homeDir'>): Promise<CollectorAvailability>;
  collect(context: CollectorContext): Promise<CollectorResult>;
}

export class CollectorError extends Error {
  constructor(
    message: string,
    /** `auth`: the credential was rejected. `unavailable`: the source is missing. `failed`: anything else. */
    readonly kind: 'auth' | 'unavailable' | 'failed' = 'failed'
  ) {
    super(message);
    this.name = 'CollectorError';
  }
}

export interface CollectorStatus {
  id: string;
  providerId: string;
  title: string;
  description: string;
  sourceKind: CollectorSourceKind;
  env: string[];
  enabled: boolean;
  available: boolean;
  reason: string | null;
  lastRunAt: string | null;
  lastOutcome: 'ok' | 'auth' | 'unavailable' | 'failed' | null;
  lastMessage: string | null;
  /** Meter ids changed by the last successful run. */
  lastUpdated: string[];
  nextRunAt: string | null;
}

/** What the HTTP API, the MCP server and the CLI need from the collector runner. */
export interface CollectorHost {
  list(): Promise<CollectorStatus[]>;
  setEnabled(id: string, enabled: boolean): Promise<CollectorStatus>;
  /** Runs the enabled collectors now (or only the given ids) and returns their status afterwards. */
  refresh(ids?: string[]): Promise<CollectorStatus[]>;
}
