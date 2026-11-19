// Domain model shared by the server, the CLI, the MCP server and the browser bundle.
// Everything here is plain JSON: the persisted state file is exactly a `State`.

export const STATE_VERSION = 1;

/** What a meter counts. `percent` is used when the provider only exposes a utilisation percentage. */
export type Unit =
  | 'percent'
  | 'requests'
  | 'credits'
  | 'tokens'
  | 'characters'
  | 'minutes'
  | 'hours'
  | 'images'
  | 'usd'
  | 'count';

/**
 * - `allowance`: prepaid quota that is lost when the window resets. This is what Tokengator exists for.
 * - `throttle`: a short rate window (for example a 5-hour session cap). Nothing of value expires with it,
 *   but when it is exhausted the allowance behind it cannot be burned until it reopens.
 */
export type MeterRole = 'allowance' | 'throttle';

/**
 * How a meter's window renews.
 * - `rolling`: the window starts on first use and lasts `hours`; after it ends the meter is idle until used again.
 * - `interval`: fixed cadence; each window ends `hours` after the previous one.
 * - `daily` / `monthly`: wall-clock boundaries in an IANA time zone. `monthly.day` is clamped to the month length.
 * - `once`: a single expiry date (prepaid credits that expire); no renewal.
 * - `none`: a balance with no clock.
 */
export type ResetRule =
  | { kind: 'rolling'; hours: number }
  | { kind: 'interval'; hours: number }
  | { kind: 'daily'; time: string; tz: string }
  | { kind: 'monthly'; day: number; time: string; tz: string }
  | { kind: 'once' }
  | { kind: 'none' };

export type SourceKind = 'manual' | 'agent' | 'collector' | 'statusline' | 'demo';

export interface MeterSource {
  kind: SourceKind;
  /** Collector id or agent name, when known. */
  id?: string;
  note?: string;
}

export interface Sample {
  /** ISO 8601 instant. */
  t: string;
  /** Amount used at that instant, in the meter's unit. */
  used: number;
}

export interface Meter {
  id: string;
  /** Stable machine key within the account (`weekly`, `session`, `premium-requests`). Collectors and presets match on it. */
  key: string;
  label: string;
  role: MeterRole;
  unit: Unit;
  /** Optional plural noun shown instead of the unit name ("songs", "fast hours"). */
  unitLabel?: string;
  /** Size of the window's allowance. Percent meters use 100. */
  limit: number;
  used: number;
  reset: ResetRule;
  windowStartedAt: string | null;
  resetsAt: string | null;
  /** `carries`: unused quota is kept at reset, so it is never counted as waste. */
  rollover: 'none' | 'carries';
  /** Share (0..1) of the plan price this meter stands for when turning unused quota into money. */
  valueShare: number;
  source: MeterSource;
  /** Time of the last real reading. `null` until the first one arrives. */
  updatedAt: string | null;
  /** Readings inside the current window, oldest first. */
  samples: Sample[];
  /** True after an automatic roll-over, until the next real reading confirms the numbers. */
  estimated: boolean;
  /** Set once a `once` meter has passed its expiry and its final cycle has been recorded. */
  expired: boolean;
  /**
   * Throttles only. True when the limit covers part of the plan (one model family, say): reaching it does
   * not stop the rest of the account from being used.
   */
  partial?: boolean;
}

export interface Price {
  amount: number;
  /** ISO 4217 code. Tokengator never converts between currencies. */
  currency: string;
  period: 'month' | 'year';
}

export interface Account {
  id: string;
  /** Catalog provider id (`claude`, `codex`, ...) or `custom`. */
  providerId: string;
  label: string;
  plan: string | null;
  price: Price | null;
  /** Where a signed-in human reads the current usage. */
  usageUrl: string | null;
  notes: string | null;
  meters: Meter[];
  /** While set and in the future the account is excluded from alerts and the "use first" queue. */
  snoozedUntil: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One finished window: the scoreboard of what was actually left unused. */
export interface ClosedCycle {
  id: string;
  accountId: string;
  meterId: string;
  providerId: string;
  accountLabel: string;
  meterLabel: string;
  unit: Unit;
  startedAt: string | null;
  endedAt: string;
  limit: number;
  used: number;
  /** 0..1 of the allowance that expired unused. */
  wastedFraction: number;
  /** Money equivalent of the wasted share, when the account has a price. */
  wastedValue: number | null;
  currency: string | null;
  /** `measured`: a reading arrived close to the reset. `estimated`: the last reading was old. */
  confidence: 'measured' | 'estimated';
}

export interface SpendEntry {
  /** Calendar day, `YYYY-MM-DD`. */
  date: string;
  amount: number;
}

/** Optional pay-as-you-go API cost tracking. */
export interface SpendSource {
  id: string;
  providerId: string;
  label: string;
  currency: string;
  monthlyBudget: number | null;
  /** Daily totals, ascending by date, one entry per day. */
  entries: SpendEntry[];
  source: MeterSource;
  updatedAt: string | null;
}

export interface Settings {
  /** Preferred display currency for totals. Amounts in other currencies are listed separately. */
  currency: string;
  /** Collectors the user switched on, by id. */
  enabledCollectors: string[];
  /** The service raises a notification on this computer when a quota becomes "use now". Off unless set. */
  desktopReminders?: boolean;
}

export interface State {
  version: typeof STATE_VERSION;
  accounts: Account[];
  spend: SpendSource[];
  cycles: ClosedCycle[];
  settings: Settings;
}

/** A new observation of a meter. Exactly one of the four amount fields is expected; all are optional so a
 *  reading can also just move the reset time. */
export interface Reading {
  used?: number;
  remaining?: number;
  /** 0..100 */
  usedPercent?: number;
  /** 0..100 */
  remainingPercent?: number;
  limit?: number;
  resetsAt?: string;
  windowStartedAt?: string;
  source?: MeterSource;
}

export function emptyState(): State {
  return {
    version: STATE_VERSION,
    accounts: [],
    spend: [],
    cycles: [],
    settings: { currency: 'USD', enabledCollectors: [] }
  };
}
