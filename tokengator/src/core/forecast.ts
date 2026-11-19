// The forecast: turns a meter and a clock into "how much of this will expire, what is that worth, how
// urgent is it". Nothing computed here is stored; every interface derives it from (account, meter, now).

import type { Account, ClosedCycle, Meter, State } from './types.js';
import { nominalWindowMs, staleAfterMs, valueCurrency, windowLengthMs, windowStartFor, windowValue } from './reset.js';
import { DAY, HOUR, clamp, toMs } from './time.js';

/** Pseudo-observation of "on pace" that keeps the first minutes of a window from predicting a disaster. */
export const PACE_PRIOR = 0.05;
export const SPENT_AT = 0.98;
export const USE_NOW_MIN_LEFT = 0.1;
export const USE_NOW_MIN_UNUSED = 0.05;
export const BEHIND_MIN_UNUSED = 0.15;
export const HOT_PACE = 1.2;
export const FRESH_ELAPSED = 0.05;

export type Tier = 'use-now' | 'behind' | 'hot' | 'on-pace' | 'fresh' | 'idle' | 'balance' | 'spent' | 'expired';
export type ThrottleState = 'open' | 'blocked' | 'idle';

/** "Use first" order of tiers. */
export const TIER_ORDER: readonly Tier[] = [
  'use-now',
  'behind',
  'hot',
  'on-pace',
  'fresh',
  'idle',
  'balance',
  'spent',
  'expired'
];

export type ValueBasis = 'plan' | 'credit';

export interface MeterView {
  account: Account;
  meter: Meter;
  /** The meter's globally unique id; used for lists and selection. */
  id: string;

  limit: number;
  used: number;
  remaining: number;
  usedFraction: number;
  remainingFraction: number;

  resetsAtMs: number | null;
  windowStartMs: number | null;
  windowMs: number | null;
  elapsedFraction: number | null;
  msLeft: number | null;
  horizonMs: number | null;

  /** Share of the limit expected to be used by the reset at the current pace. Null without a clock. */
  projectedFraction: number | null;
  /** Share of the limit expected to expire. 0 for throttles and carry-over quota. */
  projectedUnused: number;
  /** How many times the current pace is needed to finish the quota. Null when not applicable. */
  requiredMultiple: number | null;
  /** Amount per day that would finish the quota by the reset. */
  perDayToFinish: number | null;
  /** When a hot meter is expected to hit its limit. */
  runsOutAtMs: number | null;

  windowValue: number | null;
  remainingValue: number | null;
  valueAtRisk: number | null;
  currency: string | null;
  /**
   * What the money figures are made of. `plan`: a share of the plan fee, an estimate for comparing meters.
   * `credit`: the face value of a credit counted in dollars. The two are never added together.
   */
  valueBasis: ValueBasis | null;

  /** Allowance meters only. */
  tier: Tier | null;
  /** Throttle meters only. */
  throttle: ThrottleState | null;
  /** When the account's blocked throttle reopens, attached to its allowance meters. */
  blockedUntilMs: number | null;
  blockedBy: string | null;

  stale: boolean;
  ageMs: number | null;
  snoozed: boolean;
  /** The rule needs an anchor only the user or provider knows, and it has not been given yet. */
  needsReset: boolean;
}

/**
 * Action horizon: the stretch before a reset in which leftover quota becomes "use now". It is 15% of the
 * window, between 2 and 72 hours, and never more than half the window: without that last bound a window
 * of two hours or less would be "use now" from the moment it opened.
 */
export function horizonFor(windowMs: number): number {
  return Math.min(windowMs / 2, clamp(windowMs * 0.15, 2 * HOUR, 72 * HOUR));
}

/** Projected final used share from the used and elapsed shares of a window. */
export function projectUse(usedFraction: number, elapsedFraction: number): number {
  const u = clamp(usedFraction, 0, 1);
  const e = clamp(elapsedFraction, 0, 1);
  const rate = (u + PACE_PRIOR) / (e + PACE_PRIOR);
  return clamp(u + (1 - e) * rate, 0, 1);
}

function classify(input: {
  meter: Meter;
  usedFraction: number;
  /** Share of the limit used since the window (or, for a one-off pack, the tracking) began. */
  pacedFraction: number;
  remainingFraction: number;
  elapsedFraction: number | null;
  msLeft: number | null;
  horizonMs: number | null;
  projectedUnused: number;
}): Tier {
  const { meter, usedFraction, pacedFraction, remainingFraction, elapsedFraction, msLeft, horizonMs, projectedUnused } = input;
  if (meter.expired) return 'expired';
  if (usedFraction >= SPENT_AT) return 'spent';
  if (meter.reset.kind === 'none') return 'balance';
  if (msLeft === null || elapsedFraction === null || horizonMs === null) return 'idle';
  if (msLeft <= horizonMs && remainingFraction >= USE_NOW_MIN_LEFT && projectedUnused >= USE_NOW_MIN_UNUSED) {
    return 'use-now';
  }
  if (elapsedFraction >= 0.1 && pacedFraction > 0 && pacedFraction / elapsedFraction >= HOT_PACE) {
    // At this pace what is left lasts remaining/pace of a window more; "well before" the reset means
    // running out with a tenth of the window still to go.
    const runOutAt = elapsedFraction + (remainingFraction * elapsedFraction) / pacedFraction;
    if (1 - runOutAt >= 0.1) return 'hot';
  }
  if (elapsedFraction < FRESH_ELAPSED) return 'fresh';
  if (projectedUnused >= BEHIND_MIN_UNUSED) return 'behind';
  return 'on-pace';
}

export function viewMeter(account: Account, meter: Meter, nowMs: number): MeterView {
  const limit = meter.limit > 0 ? meter.limit : 0;
  const used = Math.max(0, meter.used);
  const usedFraction = limit > 0 ? clamp(used / limit, 0, 1) : 0;
  const remaining = Math.max(0, limit - used);
  // Divide the remainder itself: 1 - 0.9 is 0.09999999999999998, which would put a meter with exactly
  // 10% left just under the "use now" threshold.
  const remainingFraction = limit > 0 ? remaining / limit : 1 - usedFraction;

  const resetsAtMs = toMs(meter.resetsAt);
  const hasClock = resetsAtMs !== null && !meter.expired;
  const windowMs = hasClock ? windowLengthMs(meter) : null;
  const windowStartMs = hasClock
    ? (toMs(meter.windowStartedAt) ?? windowStartFor(meter.reset, resetsAtMs) ?? (windowMs ? resetsAtMs - windowMs : null))
    : null;
  const msLeft = hasClock ? resetsAtMs - nowMs : null;
  const elapsedFraction =
    hasClock && windowMs && windowStartMs !== null ? clamp((nowMs - windowStartMs) / windowMs, 0, 1) : null;
  const horizonMs = windowMs ? horizonFor(windowMs) : null;

  const ageMs = meter.updatedAt ? Math.max(0, nowMs - (toMs(meter.updatedAt) ?? nowMs)) : null;
  const stale = ageMs === null || ageMs > staleAfterMs(meter);
  const snoozedUntil = toMs(account.snoozedUntil);
  const snoozed = snoozedUntil !== null && snoozedUntil > nowMs;
  // Fixed and one-off windows need their reset time told. So does a long window "from first use" once it
  // has been used: its start is in the past, and only the provider's page knows when.
  const needsReset =
    resetsAtMs === null && (meter.reset.kind === 'interval' || meter.reset.kind === 'once' || (meter.reset.kind === 'rolling' && used > 0));

  const base = {
    account,
    meter,
    id: meter.id,
    limit,
    used,
    remaining,
    usedFraction,
    remainingFraction,
    resetsAtMs,
    windowStartMs,
    windowMs,
    elapsedFraction,
    msLeft,
    horizonMs,
    stale,
    ageMs,
    snoozed,
    needsReset,
    blockedUntilMs: null,
    blockedBy: null
  };

  if (meter.role === 'throttle') {
    let throttle: ThrottleState = 'idle';
    // With a reading but no reset time yet, the limit is in use all the same: it is not "idle".
    if (hasClock || meter.reset.kind === 'none' || (needsReset && used > 0)) throttle = usedFraction >= SPENT_AT ? 'blocked' : 'open';
    return {
      ...base,
      projectedFraction: null,
      projectedUnused: 0,
      requiredMultiple: null,
      perDayToFinish: null,
      runsOutAtMs: null,
      windowValue: null,
      remainingValue: null,
      valueAtRisk: null,
      currency: null,
      valueBasis: null,
      tier: null,
      throttle
    };
  }

  const carries = meter.rollover === 'carries';
  // A one-off pack is usually tracked with something already spent. That part was not spent at the pace
  // being measured: counted as such it reads as "running hot" for half the pack's life while the balance
  // sits untouched. So for a pack, pace is what was used since the first reading of the tracked window,
  // against what was left at that point.
  const first = meter.samples[0];
  const baseline = meter.reset.kind === 'once' && limit > 0 ? clamp((first ? first.used : used) / limit, 0, usedFraction) : 0;
  const room = 1 - baseline;
  const pacedFraction = usedFraction - baseline;
  const projectedFraction =
    elapsedFraction === null ? null : room > 0 ? baseline + room * projectUse(pacedFraction / room, elapsedFraction) : 1;
  const projectedUnused = projectedFraction === null || carries || meter.expired ? 0 : 1 - projectedFraction;

  const tier = classify({ meter, usedFraction, pacedFraction, remainingFraction, elapsedFraction, msLeft, horizonMs, projectedUnused });

  let requiredMultiple: number | null = null;
  let perDayToFinish: number | null = null;
  let runsOutAtMs: number | null = null;
  if (elapsedFraction !== null && msLeft !== null && msLeft > 0 && windowMs) {
    if (tier === 'use-now' || tier === 'behind') {
      perDayToFinish = remaining / (msLeft / DAY);
      if (pacedFraction > 0 && elapsedFraction > 0 && elapsedFraction < 1) {
        const currentRate = pacedFraction / elapsedFraction;
        const requiredRate = remainingFraction / (1 - elapsedFraction);
        requiredMultiple = requiredRate / currentRate;
      }
    }
    if (tier === 'hot' && pacedFraction > 0 && windowStartMs !== null) {
      // What is left, at the pace since the start. For a window that began at nothing used this is the
      // same moment as start + elapsed / used.
      runsOutAtMs = nowMs + ((nowMs - windowStartMs) * remainingFraction) / pacedFraction;
    }
  }

  const value = windowValue(account, meter, windowMs ?? nominalWindowMs(meter.reset));
  // Nothing is counted as at risk where there is no forecast yet, or nothing left to forecast.
  const settled = tier === 'spent' || tier === 'expired' || tier === 'balance' || tier === 'idle' || tier === 'fresh';
  const valueAtRisk = value === null ? null : settled ? 0 : value * projectedUnused;
  const remainingValue = value === null ? null : carries ? 0 : value * remainingFraction;

  return {
    ...base,
    projectedFraction,
    projectedUnused,
    requiredMultiple,
    perDayToFinish,
    runsOutAtMs,
    windowValue: value,
    remainingValue,
    valueAtRisk,
    currency: value === null ? null : valueCurrency(account, meter),
    valueBasis: value === null ? null : meter.unit === 'usd' ? 'credit' : 'plan',
    tier,
    throttle: null
  };
}

/** Views of every meter of an account, with a blocked throttle attached to the allowances it gates. */
export function viewAccount(account: Account, nowMs: number): MeterView[] {
  const views = account.meters.map((meter) => viewMeter(account, meter, nowMs));
  let blockedUntilMs: number | null = null;
  let blockedBy: string | null = null;
  for (const view of views) {
    // A partial limit (one model family) leaves the rest of the account usable.
    if (view.throttle !== 'blocked' || view.meter.partial) continue;
    // The longest block is the one that matters: nothing can be used until every gate is open.
    const until = view.resetsAtMs;
    if (until !== null && (blockedUntilMs === null || until > blockedUntilMs)) {
      blockedUntilMs = until;
      blockedBy = view.meter.label;
    } else if (until === null && blockedBy === null) {
      blockedBy = view.meter.label;
    }
  }
  if (blockedBy === null) return views;
  return views.map((view) => (view.tier === null ? view : { ...view, blockedUntilMs, blockedBy }));
}

export function viewState(state: State, nowMs: number): MeterView[] {
  return state.accounts.flatMap((account) => viewAccount(account, nowMs));
}

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

export type SortOrder = 'use-first' | 'reset' | 'left' | 'value' | 'name' | 'updated';

export const SORT_ORDERS: readonly { id: SortOrder; label: string }[] = [
  { id: 'use-first', label: 'Use first' },
  { id: 'reset', label: 'Soonest reset' },
  { id: 'left', label: 'Most left' },
  { id: 'value', label: 'Most value at risk' },
  { id: 'name', label: 'Name' },
  { id: 'updated', label: 'Least recently updated' }
];

function tierRank(view: MeterView): number {
  if (view.tier === null) return TIER_ORDER.length; // throttles sort after every allowance tier
  return TIER_ORDER.indexOf(view.tier);
}

const byName = (a: MeterView, b: MeterView): number =>
  a.account.label.localeCompare(b.account.label) || a.meter.label.localeCompare(b.meter.label);

const nullsLast = (a: number | null, b: number | null): number => {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
};

export function compareViews(order: SortOrder): (a: MeterView, b: MeterView) => number {
  switch (order) {
    case 'reset':
      return (a, b) => nullsLast(a.msLeft, b.msLeft) || byName(a, b);
    case 'left':
      return (a, b) => b.remainingFraction - a.remainingFraction || nullsLast(a.msLeft, b.msLeft) || byName(a, b);
    case 'value':
      return (a, b) =>
        (b.valueAtRisk ?? -1) - (a.valueAtRisk ?? -1) || b.projectedUnused - a.projectedUnused || byName(a, b);
    case 'name':
      return byName;
    case 'updated':
      return (a, b) => (b.ageMs ?? Number.POSITIVE_INFINITY) - (a.ageMs ?? Number.POSITIVE_INFINITY) || byName(a, b);
    default:
      return (a, b) =>
        Number(a.snoozed) - Number(b.snoozed) ||
        tierRank(a) - tierRank(b) ||
        nullsLast(a.msLeft, b.msLeft) ||
        (b.valueAtRisk ?? 0) - (a.valueAtRisk ?? 0) ||
        byName(a, b);
  }
}

export function sortViews(views: readonly MeterView[], order: SortOrder = 'use-first'): MeterView[] {
  return views.slice().sort(compareViews(order));
}

/** Allowance meters only, in the given order. This is the list every view of the dashboard is built from. */
export function allowanceQueue(state: State, nowMs: number, order: SortOrder = 'use-first'): MeterView[] {
  return sortViews(
    viewState(state, nowMs).filter((view) => view.tier !== null),
    order
  );
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

export type Money = Record<string, number>;

function addMoney(target: Money, currency: string | null, amount: number | null): void {
  if (!currency || amount === null || !(amount > 0)) return;
  target[currency] = (target[currency] ?? 0) + amount;
}

export interface Summary {
  useNow: number;
  behind: number;
  hot: number;
  stale: number;
  /** Plan money expected to expire across all active windows: each meter's share of its plan fee. */
  atRisk: Money;
  /** Subset of `atRisk` inside "use now" meters. */
  atRiskNow: Money;
  /**
   * Credits counted in dollars that are expected to expire, at face value. Kept apart from `atRisk`:
   * a plan that bundles 100 dollars of credits with a 100 dollar fee has not put 200 dollars at risk.
   */
  creditsAtRisk: Money;
  creditsAtRiskNow: Money;
  /** The next reset among allowance meters that still have quota left. */
  nextReset: MeterView | null;
  /** Ledger: plan money that expired in the trailing 30 days. */
  lost30: Money;
  /** Ledger: dollar credits that expired in the trailing 30 days, at face value. */
  creditsLost30: Money;
  /** Ledger: mean utilisation (0..1) over cycles closed in the trailing 30 days, or null without cycles. */
  utilisation30: number | null;
  cycles30: number;
  /** True when any figure in `lost30` comes from an estimated cycle. */
  lostIsEstimate: boolean;
}

export function ledgerTotals(
  cycles: readonly ClosedCycle[],
  nowMs: number,
  days = 30
): Pick<Summary, 'lost30' | 'creditsLost30' | 'utilisation30' | 'cycles30' | 'lostIsEstimate'> {
  const since = nowMs - days * DAY;
  const lost30: Money = {};
  const creditsLost30: Money = {};
  let count = 0;
  let utilisation = 0;
  let lostIsEstimate = false;
  for (const cycle of cycles) {
    const ended = toMs(cycle.endedAt);
    if (ended === null || ended < since || ended > nowMs) continue;
    count += 1;
    utilisation += 1 - cycle.wastedFraction;
    addMoney(cycle.unit === 'usd' ? creditsLost30 : lost30, cycle.currency, cycle.wastedValue);
    if (cycle.confidence === 'estimated' && (cycle.wastedValue ?? 0) > 0) lostIsEstimate = true;
  }
  return { lost30, creditsLost30, utilisation30: count ? utilisation / count : null, cycles30: count, lostIsEstimate };
}

export function summarise(state: State, nowMs: number): Summary {
  const views = viewState(state, nowMs).filter((view) => view.tier !== null && !view.snoozed);
  const atRisk: Money = {};
  const atRiskNow: Money = {};
  const creditsAtRisk: Money = {};
  const creditsAtRiskNow: Money = {};
  let useNow = 0;
  let behind = 0;
  let hot = 0;
  let stale = 0;
  let nextReset: MeterView | null = null;
  for (const view of views) {
    if (view.tier === 'use-now') useNow += 1;
    if (view.tier === 'behind') behind += 1;
    if (view.tier === 'hot') hot += 1;
    if (view.stale && view.tier !== 'idle' && view.tier !== 'expired') stale += 1;
    const credit = view.valueBasis === 'credit';
    addMoney(credit ? creditsAtRisk : atRisk, view.currency, view.valueAtRisk);
    if (view.tier === 'use-now') addMoney(credit ? creditsAtRiskNow : atRiskNow, view.currency, view.valueAtRisk);
    if (view.msLeft !== null && view.msLeft > 0 && view.tier !== 'spent' && view.tier !== 'expired') {
      if (nextReset === null || view.msLeft < (nextReset.msLeft ?? Number.POSITIVE_INFINITY)) nextReset = view;
    }
  }
  return { useNow, behind, hot, stale, atRisk, atRiskNow, creditsAtRisk, creditsAtRiskNow, nextReset, ...ledgerTotals(state.cycles, nowMs) };
}

/** Recent finished cycles of one meter, oldest first. */
export function cyclesOf(state: State, meterId: string, count = 12): ClosedCycle[] {
  const own = state.cycles.filter((cycle) => cycle.meterId === meterId);
  return own.slice(Math.max(0, own.length - count));
}
