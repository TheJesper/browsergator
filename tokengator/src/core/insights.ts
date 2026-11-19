// Aggregates across meters for the Overview: what expires on which day, what expired week by week, which
// subscriptions keep leaving quota unused, which readings to refresh. Pure functions of the state, shared
// by the dashboard, the brief and the MCP server so that every figure is computed once.

import { ledgerTotals, type MeterView, type Money, type Tier, type ValueBasis } from './forecast.js';
import { nextBoundary, staleAfterMs } from './reset.js';
import { DAY, HOUR, dateKey, toMs, zonedParts, zonedTimeToUtc } from './time.js';
import type { ClosedCycle } from './types.js';

function addMoney(target: Money, currency: string | null, amount: number | null): void {
  if (!currency || amount === null || !(amount > 0)) return;
  target[currency] = (target[currency] ?? 0) + amount;
}

function sumMoney(target: Money, source: Money): void {
  for (const [currency, amount] of Object.entries(source)) addMoney(target, currency, amount);
}

/** Midnight at the start of the day `offset` days from the one `nowMs` falls on, in `tz`. */
function dayStart(nowMs: number, offset: number, tz: string): number {
  const p = zonedParts(nowMs, tz);
  return zonedTimeToUtc(p.year, p.month, p.day + offset, 0, 0, tz);
}

// ---------------------------------------------------------------------------
// Resets ahead
// ---------------------------------------------------------------------------

/**
 * Ends of a meter's windows from its current reset on: the one it is in, then those its rule alone
 * determines. A rolling window opens on first use and a one-off has no second end, so both stop after one.
 */
export function upcomingResets(view: Pick<MeterView, 'meter'>, nowMs: number, untilMs: number, max = 60): number[] {
  const first = toMs(view.meter.resetsAt);
  if (first === null || first <= nowMs || first > untilMs) return [];
  const resets = [first];
  const rule = view.meter.reset;
  while (resets.length < max) {
    const last = resets[resets.length - 1] as number;
    const next = rule.kind === 'interval' ? last + rule.hours * HOUR : rule.kind === 'daily' || rule.kind === 'monthly' ? nextBoundary(rule, last) : null;
    if (next === null || next > untilMs) break;
    resets.push(next);
  }
  return resets;
}

// ---------------------------------------------------------------------------
// What expires, and when
// ---------------------------------------------------------------------------

export interface ExpiryEntry {
  id: string;
  atMs: number;
  /** The window the meter is in now. Later windows have not started, so nothing about them is forecast. */
  current: boolean;
  tier: Tier;
  projectedUnused: number;
  valueAtRisk: number | null;
  currency: string | null;
  basis: ValueBasis | null;
  /** The forecast rests on an old reading, or on numbers assumed after an unobserved reset. */
  uncertain: boolean;
}

export interface ExpiryDay {
  /** `YYYY-MM-DD` in the zone asked for. */
  date: string;
  startMs: number;
  plan: Money;
  credits: Money;
  /** Current windows that lose 5% or more at this day's resets: what a chart without prices counts. */
  count: number;
  /** A quota to use now resets this day. */
  urgent: boolean;
  /** Some of this day's money rests on an old or assumed reading. */
  uncertain: boolean;
  /** Current windows that will lose 5% or more but have no price, so carry no money. */
  unvalued: number;
  entries: ExpiryEntry[];
}

export interface ExpiryOutlook {
  days: ExpiryDay[];
  firstWeek: { plan: Money; credits: Money };
  /**
   * Current windows that reset after the last day. `count` is those with money at stake or that will lose
   * 5% or more, so it counts every quota behind the money; `firstMs` is the first of their resets with money.
   */
  later: { plan: Money; credits: Money; count: number; firstMs: number | null };
  /** Allowances of snoozed subscriptions, left out like everywhere else. */
  snoozed: number;
  /** Current windows with money at stake whose reading is old or assumed. */
  stale: number;
  /** Current windows inside the days that will lose 5% or more and have no price. */
  unvalued: number;
}

const LOSES = 0.05;
/** The states that carry a forecast of what expires. A new window is too early to forecast. */
export const FORECAST_TIERS: readonly Tier[] = ['use-now', 'behind', 'on-pace'];
/** How long after its reset time a window still counts as closing now, before the next reading rolls it on. */
const DUE_NOW_MS = DAY;

/**
 * True when part of a quota is expected to expire at its reset: it has a forecast, 5% or more of it will be
 * left at this pace, and what is left does not carry over. The one test behind every "will expire".
 */
export function expectsToExpire(view: MeterView): boolean {
  return view.tier !== null && FORECAST_TIERS.includes(view.tier) && view.projectedUnused >= LOSES && view.meter.rollover !== 'carries';
}

/**
 * The money expected to expire at each reset over the next `days` days, by calendar day in `tz`. Plan money
 * and dollar credits are kept in separate totals; no field adds them. An expired one-off pack, and a window
 * whose reset passed more than a day ago, have no reset ahead and are left out.
 */
export function expiryOutlook(views: readonly MeterView[], nowMs: number, days: number, tz: string): ExpiryOutlook {
  const out: ExpiryOutlook = {
    days: [],
    firstWeek: { plan: {}, credits: {} },
    later: { plan: {}, credits: {}, count: 0, firstMs: null },
    snoozed: 0,
    stale: 0,
    unvalued: 0
  };
  const index = new Map<string, number>();
  for (let i = 0; i < days; i += 1) {
    const startMs = dayStart(nowMs, i, tz);
    const date = dateKey(startMs, tz);
    index.set(date, i);
    out.days.push({ date, startMs, plan: {}, credits: {}, count: 0, urgent: false, uncertain: false, unvalued: 0, entries: [] });
  }
  const endMs = dayStart(nowMs, days, tz);

  for (const view of views) {
    // An expired pack keeps the date it expired on, which is behind us: nothing of it resets again.
    if (view.tier === null || view.tier === 'expired') continue;
    if (view.snoozed) {
      out.snoozed += 1;
      continue;
    }
    // Carried-over quota is not lost at its reset.
    if (view.meter.rollover === 'carries') continue;
    const atMs = view.resetsAtMs;
    // A reset long past is a window that has closed, not one closing now.
    if (atMs === null || atMs < nowMs - DUE_NOW_MS) continue;
    const loses = expectsToExpire(view);
    const money = view.valueAtRisk !== null && view.valueAtRisk > 0.004;
    const uncertain = view.stale || view.meter.estimated;
    const credit = view.valueBasis === 'credit';
    if (atMs >= endMs) {
      addMoney(credit ? out.later.credits : out.later.plan, view.currency, view.valueAtRisk);
      // Counted by the same test as the money beside it, so "0 quotas" never stands next to an amount.
      if (money || loses) out.later.count += 1;
      if (money && (out.later.firstMs === null || atMs < out.later.firstMs)) out.later.firstMs = atMs;
      continue;
    }
    // A reset just due (the window is closing now) belongs to today.
    const day = out.days[index.get(dateKey(Math.max(atMs, nowMs), tz)) ?? 0];
    if (!day) continue;
    day.entries.push({
      id: view.id,
      atMs,
      current: true,
      tier: view.tier,
      projectedUnused: view.projectedUnused,
      valueAtRisk: view.valueAtRisk,
      currency: view.currency,
      basis: view.valueBasis,
      uncertain
    });
    addMoney(credit ? day.credits : day.plan, view.currency, view.valueAtRisk);
    if (loses) day.count += 1;
    if (view.tier === 'use-now') day.urgent = true;
    if (uncertain && (money || loses)) {
      day.uncertain = true;
      out.stale += 1;
    }
    if (loses && view.valueAtRisk === null) {
      day.unvalued += 1;
      out.unvalued += 1;
    }
    // Later windows of the same meter renew inside the range; nothing about them is forecast yet.
    for (const later of upcomingResets(view, nowMs, endMs - 1).slice(1)) {
      const target = out.days[index.get(dateKey(later, tz)) ?? -1];
      target?.entries.push({ id: view.id, atMs: later, current: false, tier: view.tier, projectedUnused: 0, valueAtRisk: null, currency: view.currency, basis: view.valueBasis, uncertain: false });
    }
  }
  for (const day of out.days) day.entries.sort((a, b) => a.atMs - b.atMs);
  for (const day of out.days.slice(0, 7)) {
    sumMoney(out.firstWeek.plan, day.plan);
    sumMoney(out.firstWeek.credits, day.credits);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Finished windows week by week
// ---------------------------------------------------------------------------

export interface LedgerWeek {
  startMs: number;
  /** The next week's start, or now for the current week. */
  endMs: number;
  /** Windows that closed in the week. Zero means no record, which is not the same as nothing lost. */
  windows: number;
  estimatedWindows: number;
  /** Plan money that expired, per currency. */
  lost: Money;
  /** The part of `lost` from estimated windows. */
  lostEstimated: Money;
  /** Dollar credits that expired, at face value. */
  creditsLost: Money;
  creditsLostEstimated: Money;
  /** Mean share used over the 30 days ending with the week, or null when none closed then. */
  trailingUtilisation: number | null;
  trailingWindows: number;
}

/** Weekday of an instant in `tz`, Monday 0 to Sunday 6. */
function mondayIndex(ms: number, tz: string): number {
  const p = zonedParts(ms, tz);
  return (new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay() + 6) % 7;
}

/**
 * How many weeks, Monday to Monday in `tz`, it takes to cover the last `days` days: from the week holding
 * the start of that span to the one holding `nowMs`. With that many, `ledgerWeeks` holds every window that
 * `ledgerTotals` counts over the same days.
 */
export function weeksCovering(nowMs: number, days: number, tz: string): number {
  const sinceMs = nowMs - days * DAY;
  const first = dayStart(sinceMs, -mondayIndex(sinceMs, tz), tz);
  const current = dayStart(nowMs, -mondayIndex(nowMs, tz), tz);
  // Rounded: a week across a clock change is an hour short or long.
  return Math.round((current - first) / (7 * DAY)) + 1;
}

/** The last `weeks` weeks, Monday to Monday in `tz`, the last one holding `nowMs`. Oldest first. */
export function ledgerWeeks(cycles: readonly ClosedCycle[], nowMs: number, weeks: number, tz: string): LedgerWeek[] {
  const back = mondayIndex(nowMs, tz);
  const starts: number[] = [];
  for (let i = weeks - 1; i >= 0; i -= 1) starts.push(dayStart(nowMs, -back - 7 * i, tz));
  const out: LedgerWeek[] = starts.map((startMs, i) => {
    const endMs = i + 1 < starts.length ? (starts[i + 1] as number) : nowMs;
    const trailing = ledgerTotals(cycles, endMs, 30);
    return {
      startMs,
      endMs,
      windows: 0,
      estimatedWindows: 0,
      lost: {},
      lostEstimated: {},
      creditsLost: {},
      creditsLostEstimated: {},
      trailingUtilisation: trailing.utilisation30,
      trailingWindows: trailing.cycles30
    };
  });
  for (const cycle of cycles) {
    const ended = toMs(cycle.endedAt);
    if (ended === null || ended > nowMs) continue;
    const week = out.find((entry, i) => ended >= entry.startMs && (i === out.length - 1 ? ended <= entry.endMs : ended < entry.endMs));
    if (!week) continue;
    week.windows += 1;
    const estimated = cycle.confidence === 'estimated';
    if (estimated) week.estimatedWindows += 1;
    const credit = cycle.unit === 'usd';
    addMoney(credit ? week.creditsLost : week.lost, cycle.currency, cycle.wastedValue);
    if (estimated) addMoney(credit ? week.creditsLostEstimated : week.lostEstimated, cycle.currency, cycle.wastedValue);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Totals per subscription
// ---------------------------------------------------------------------------

export interface WasteRow {
  accountId: string;
  providerId: string;
  /** The name on the latest window, so a renamed or deleted subscription keeps a name. */
  accountLabel: string;
  windows: number;
  estimatedWindows: number;
  /** Mean share of each window used. Carried-over windows count as fully used. */
  utilisation: number;
  lost: Money;
  /** Some of `lost` comes from estimated windows. */
  lostIsEstimate: boolean;
  creditsLost: Money;
  creditsIsEstimate: boolean;
  /** The meter that left the most money unused, for opening it. */
  topMeterId: string;
}

/**
 * Finished windows totalled per subscription over the last `days` days (all time when null), ordered by
 * the plan money that expired in the preferred currency, then in other currencies, then by credits, then
 * by the lower share used, then by name.
 */
export function wasteBy(cycles: readonly ClosedCycle[], nowMs: number, days: number | null, preferredCurrency: string): WasteRow[] {
  const since = days === null ? Number.NEGATIVE_INFINITY : nowMs - days * DAY;
  const rows = new Map<string, WasteRow & { used: number; latest: number; perMeter: Map<string, number> }>();
  for (const cycle of cycles) {
    const ended = toMs(cycle.endedAt);
    if (ended === null || ended < since || ended > nowMs) continue;
    let row = rows.get(cycle.accountId);
    if (!row) {
      row = {
        accountId: cycle.accountId,
        providerId: cycle.providerId,
        accountLabel: cycle.accountLabel,
        windows: 0,
        estimatedWindows: 0,
        utilisation: 0,
        lost: {},
        lostIsEstimate: false,
        creditsLost: {},
        creditsIsEstimate: false,
        topMeterId: cycle.meterId,
        used: 0,
        latest: ended,
        perMeter: new Map()
      };
      rows.set(cycle.accountId, row);
    }
    if (ended >= row.latest) {
      row.latest = ended;
      row.accountLabel = cycle.accountLabel;
      row.providerId = cycle.providerId;
    }
    row.windows += 1;
    row.used += 1 - cycle.wastedFraction;
    const estimated = cycle.confidence === 'estimated';
    if (estimated) row.estimatedWindows += 1;
    const lostValue = cycle.wastedValue ?? 0;
    if (cycle.unit === 'usd') {
      addMoney(row.creditsLost, cycle.currency, cycle.wastedValue);
      if (estimated && lostValue > 0) row.creditsIsEstimate = true;
    } else {
      addMoney(row.lost, cycle.currency, cycle.wastedValue);
      if (estimated && lostValue > 0) row.lostIsEstimate = true;
    }
    row.perMeter.set(cycle.meterId, (row.perMeter.get(cycle.meterId) ?? 0) + Math.max(0, lostValue));
  }
  const sumOthers = (money: Money): number => Object.entries(money).reduce((sum, [code, amount]) => (code === preferredCurrency ? sum : sum + amount), 0);
  const sumAll = (money: Money): number => Object.values(money).reduce((sum, amount) => sum + amount, 0);
  return [...rows.values()]
    .map(({ used, latest: _latest, perMeter, ...row }) => {
      let top = row.topMeterId;
      let most = -1;
      for (const [meterId, amount] of perMeter) {
        if (amount > most) {
          most = amount;
          top = meterId;
        }
      }
      return { ...row, utilisation: row.windows > 0 ? used / row.windows : 0, topMeterId: top };
    })
    .sort(
      (a, b) =>
        (b.lost[preferredCurrency] ?? 0) - (a.lost[preferredCurrency] ?? 0) ||
        sumOthers(b.lost) - sumOthers(a.lost) ||
        sumAll(b.creditsLost) - sumAll(a.creditsLost) ||
        a.utilisation - b.utilisation ||
        a.accountLabel.localeCompare(b.accountLabel)
    );
}

// ---------------------------------------------------------------------------
// What needs attention
// ---------------------------------------------------------------------------

/**
 * Allowances whose numbers cannot be acted on as they are: readings too old to trust (the same test as the
 * summary's stale count) and windows whose reset time nobody has given. Never-read first, then those
 * without a reset time, then by how far past its freshness each reading is.
 */
export function refreshList(views: readonly MeterView[]): MeterView[] {
  const wanted = views.filter((view) => view.tier !== null && !view.snoozed && ((view.stale && view.tier !== 'idle' && view.tier !== 'expired') || view.needsReset));
  const overdue = (view: MeterView): number => (view.ageMs === null ? Number.POSITIVE_INFINITY : view.ageMs / staleAfterMs(view.meter));
  return wanted.sort((a, b) => {
    if ((a.ageMs === null) !== (b.ageMs === null)) return a.ageMs === null ? -1 : 1;
    if (a.needsReset !== b.needsReset) return a.needsReset ? -1 : 1;
    return overdue(b) - overdue(a);
  });
}

/** Rate limits that are closed now and will reopen, soonest first: until then their account cannot be used. */
export function blockedLimits(views: readonly MeterView[], nowMs: number): MeterView[] {
  return views
    .filter((view) => view.tier === null && view.throttle === 'blocked' && !view.snoozed && view.resetsAtMs !== null && view.resetsAtMs > nowMs)
    .sort((a, b) => (a.resetsAtMs ?? 0) - (b.resetsAtMs ?? 0));
}

// ---------------------------------------------------------------------------
// Pace
// ---------------------------------------------------------------------------

export interface TierCounts {
  /** Per tier, among the quotas placed on the even-pace chart. */
  tiers: Partial<Record<Tier, number>>;
  /** Allowances with a running window, not snoozed: the ones the chart places. */
  plotted: number;
  /** Allowances not snoozed that have no running window (no clock, a balance, expired). */
  unplotted: number;
  snoozed: number;
}

/** True when a quota has a running window that can be placed on the even-pace chart. */
export function plottable(view: MeterView): boolean {
  return view.tier !== null && !view.snoozed && view.elapsedFraction !== null && view.resetsAtMs !== null && view.tier !== 'expired';
}

export function countTiers(views: readonly MeterView[]): TierCounts {
  const out: TierCounts = { tiers: {}, plotted: 0, unplotted: 0, snoozed: 0 };
  for (const view of views) {
    if (view.tier === null) continue;
    if (view.snoozed) out.snoozed += 1;
    else if (plottable(view)) {
      out.plotted += 1;
      out.tiers[view.tier] = (out.tiers[view.tier] ?? 0) + 1;
    } else out.unplotted += 1;
  }
  return out;
}

/**
 * The first quota now behind pace to enter its "use now" stretch, and when: the moment its reset comes
 * within the action horizon. The same stretch reminders and the calendar use.
 */
export function nextUseNow(views: readonly MeterView[], nowMs: number): { view: MeterView; atMs: number } | null {
  let best: { view: MeterView; atMs: number } | null = null;
  for (const view of views) {
    if (view.tier !== 'behind' || view.snoozed || view.resetsAtMs === null || view.horizonMs === null) continue;
    const atMs = view.resetsAtMs - view.horizonMs;
    if (atMs <= nowMs) continue;
    if (best === null || atMs < best.atMs) best = { view, atMs };
  }
  return best;
}
