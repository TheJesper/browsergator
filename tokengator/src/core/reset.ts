// Reset-rule arithmetic: where a window starts and ends, how a new reading moves it, and what happens
// when a reset time passes with nobody watching. Everything here is pure: (state, now) -> state.

import type { Account, ClosedCycle, Meter, Reading, ResetRule, State } from './types.js';
import { DAY, HOUR, MONTH, clamp, daysInMonth, iso, parseClock, toMs, zonedParts, zonedTimeToUtc } from './time.js';

/** Finished cycles kept in the ledger. */
export const MAX_CYCLES = 2000;
/** Samples kept per meter for the current window. */
export const MAX_SAMPLES = 240;

/** The first boundary of a wall-clock rule strictly after `afterMs`. Null for rules without a calendar. */
export function nextBoundary(rule: ResetRule, afterMs: number): number | null {
  if (rule.kind === 'daily') {
    const { hour, minute } = parseClock(rule.time);
    const p = zonedParts(afterMs, rule.tz);
    for (let offset = 0; offset <= 2; offset += 1) {
      const candidate = zonedTimeToUtc(p.year, p.month, p.day + offset, hour, minute, rule.tz);
      if (candidate > afterMs) return candidate;
    }
    return null;
  }
  if (rule.kind === 'monthly') {
    const { hour, minute } = parseClock(rule.time);
    const p = zonedParts(afterMs, rule.tz);
    for (let offset = 0; offset <= 2; offset += 1) {
      const candidate = monthlyInstant(p.year, p.month + offset, rule.day, hour, minute, rule.tz);
      if (candidate > afterMs) return candidate;
    }
    return null;
  }
  return null;
}

/** The last boundary of a wall-clock rule at or before `atMs`. */
export function previousBoundary(rule: ResetRule, atMs: number): number | null {
  if (rule.kind === 'daily') {
    const { hour, minute } = parseClock(rule.time);
    const p = zonedParts(atMs, rule.tz);
    for (let offset = 0; offset >= -2; offset -= 1) {
      const candidate = zonedTimeToUtc(p.year, p.month, p.day + offset, hour, minute, rule.tz);
      if (candidate <= atMs) return candidate;
    }
    return null;
  }
  if (rule.kind === 'monthly') {
    const { hour, minute } = parseClock(rule.time);
    const p = zonedParts(atMs, rule.tz);
    for (let offset = 0; offset >= -2; offset -= 1) {
      const candidate = monthlyInstant(p.year, p.month + offset, rule.day, hour, minute, rule.tz);
      if (candidate <= atMs) return candidate;
    }
    return null;
  }
  return null;
}

function monthlyInstant(year: number, month: number, day: number, hour: number, minute: number, tz: string): number {
  // Normalise an overflowing month (0, 13, 14) before clamping the day to that month's length.
  const normalised = new Date(Date.UTC(year, month - 1, 1));
  const y = normalised.getUTCFullYear();
  const m = normalised.getUTCMonth() + 1;
  const d = clamp(Math.round(day), 1, daysInMonth(y, m));
  return zonedTimeToUtc(y, m, d, hour, minute, tz);
}

/** Nominal window length of a rule. Monthly uses the mean month; `once` and `none` have no cadence. */
export function nominalWindowMs(rule: ResetRule): number | null {
  switch (rule.kind) {
    case 'rolling':
    case 'interval':
      return rule.hours * HOUR;
    case 'daily':
      return DAY;
    case 'monthly':
      return MONTH;
    default:
      return null;
  }
}

/** Start of the window that ends at `resetsAtMs`, when the rule alone determines it. */
export function windowStartFor(rule: ResetRule, resetsAtMs: number): number | null {
  switch (rule.kind) {
    case 'rolling':
    case 'interval':
      return resetsAtMs - rule.hours * HOUR;
    case 'daily':
    case 'monthly': {
      // One millisecond earlier, otherwise "at or before" would return the reset itself.
      const before = previousBoundary(rule, resetsAtMs - 1);
      if (before === null) return null;
      // A reset time shortly after one of the rule's boundaries is that boundary reported late (the
      // provider's real reset is at 14:37, say), not a window a few hours long that starts in the future.
      // Same half-window test as for readings: under half a window is a correction.
      const half = (rule.kind === 'daily' ? DAY : MONTH) / 2;
      return resetsAtMs - before < half ? previousBoundary(rule, before - 1) : before;
    }
    default:
      return null;
  }
}

/** Length of the meter's current window in milliseconds, or null when it has none. */
export function windowLengthMs(meter: Meter): number | null {
  const end = toMs(meter.resetsAt);
  if (end === null) return null;
  const start = toMs(meter.windowStartedAt) ?? windowStartFor(meter.reset, end);
  if (start === null || end <= start) return nominalWindowMs(meter.reset);
  return end - start;
}

/** How old a reading may be before the meter is called stale: 20% of the window, 30 minutes to 48 hours. */
export function staleAfterMs(meter: Meter): number {
  const length = windowLengthMs(meter) ?? nominalWindowMs(meter.reset);
  if (length === null) return 48 * HOUR;
  return clamp(length * 0.2, 30 * 60_000, 48 * HOUR);
}

/**
 * Gives a meter its reset time when the rule alone determines one (daily, monthly), and fills in a missing
 * window start. Meters whose anchor only the provider knows (rolling, interval, once) are left as they are.
 */
export function anchorMeter(meter: Meter, nowMs: number): Meter {
  let { resetsAt, windowStartedAt } = meter;
  if (resetsAt === null && (meter.reset.kind === 'daily' || meter.reset.kind === 'monthly')) {
    const next = nextBoundary(meter.reset, nowMs);
    if (next !== null) resetsAt = iso(next);
  }
  const end = toMs(resetsAt);
  if (end !== null && windowStartedAt === null) {
    const start = windowStartFor(meter.reset, end);
    if (start !== null) windowStartedAt = iso(start);
  }
  if (resetsAt === meter.resetsAt && windowStartedAt === meter.windowStartedAt) return meter;
  return { ...meter, resetsAt, windowStartedAt };
}

export type CycleDraft = Omit<ClosedCycle, 'id' | 'accountId' | 'providerId' | 'accountLabel' | 'wastedValue' | 'currency'>;

function closeWindow(meter: Meter, endedAtMs: number): CycleDraft | null {
  if (meter.role !== 'allowance') return null;
  if (meter.updatedAt === null) return null; // never observed: nothing truthful to record
  if (meter.limit <= 0) return null;
  // No reading arrived inside this window. For a source that reports by itself, silence means the quota
  // sat unused, which is exactly the loss worth recording. For a hand-kept meter it only means nobody typed.
  const unobserved = meter.estimated;
  if (unobserved && meter.source.kind !== 'collector' && meter.source.kind !== 'statusline') return null;
  const used = clamp(meter.used, 0, meter.limit);
  const wastedFraction = meter.rollover === 'carries' ? 0 : 1 - used / meter.limit;
  const lastReading = toMs(meter.updatedAt) ?? 0;
  const fresh = endedAtMs - lastReading <= staleAfterMs(meter);
  return {
    meterId: meter.id,
    meterLabel: meter.label,
    unit: meter.unit,
    startedAt: meter.windowStartedAt ?? (() => {
      const start = windowStartFor(meter.reset, endedAtMs);
      return start === null ? null : iso(start);
    })(),
    endedAt: iso(endedAtMs),
    limit: meter.limit,
    used,
    wastedFraction: clamp(wastedFraction, 0, 1),
    confidence: fresh && !unobserved ? 'measured' : 'estimated'
  };
}

/**
 * Advances a meter past every reset that has already happened. At most one finished cycle comes back:
 * when several windows passed unobserved only the first carries real data.
 */
export function rollMeter(meter: Meter, nowMs: number): { meter: Meter; closed: CycleDraft | null } {
  let current = anchorMeter(meter, nowMs);
  let closed: CycleDraft | null = null;
  let first = true;

  for (let guard = 0; guard < 4000; guard += 1) {
    const end = toMs(current.resetsAt);
    if (end === null || end > nowMs || current.expired) break;

    if (first) {
      closed = closeWindow(current, end);
      first = false;
    }

    const rule = current.reset;
    if (rule.kind === 'once') {
      current = { ...current, expired: true };
      break;
    }
    if (rule.kind === 'none') {
      current = { ...current, resetsAt: null, windowStartedAt: null };
      break;
    }
    if (rule.kind === 'rolling') {
      current = { ...current, used: 0, resetsAt: null, windowStartedAt: null, samples: [], estimated: true };
      break;
    }

    let next: number | null;
    if (rule.kind === 'interval') {
      const step = rule.hours * HOUR;
      // Jump straight to the window containing `now` instead of iterating thousands of short windows.
      const skipped = Math.floor((nowMs - end) / step);
      next = end + (skipped + 1) * step;
      current = {
        ...current,
        used: 0,
        windowStartedAt: iso(next - step),
        resetsAt: iso(next),
        samples: [],
        estimated: true
      };
      break;
    }
    next = nextBoundary(rule, end);
    // A reset that came shortly before one of the rule's boundaries (the provider's own clock) was that
    // boundary: the next window runs to the one after, not for the few hours in between. Without this a
    // collector-fed meter records that sliver as a window that expired fully unused.
    if (next !== null && next - end < (rule.kind === 'daily' ? DAY : MONTH) / 2) next = nextBoundary(rule, next);
    if (next === null) break;
    current = { ...current, used: 0, windowStartedAt: iso(end), resetsAt: iso(next), samples: [], estimated: true };
  }

  return { meter: current, closed };
}

/** Price of one month of the account, or null. */
export function monthlyPrice(account: Pick<Account, 'price'>): number | null {
  if (!account.price || !(account.price.amount > 0)) return null;
  return account.price.period === 'year' ? account.price.amount / 12 : account.price.amount;
}

/**
 * Money a full window of this meter stands for. A meter counted in dollars is its own value; anything else
 * is valued as its share of the plan price.
 */
export function windowValue(account: Pick<Account, 'price'>, meter: Meter, lengthMs: number | null): number | null {
  if (meter.role !== 'allowance') return null;
  if (meter.unit === 'usd') return meter.limit > 0 ? meter.limit : null;
  const perMonth = monthlyPrice(account);
  if (perMonth === null) return null;
  if (!(meter.valueShare > 0)) return null;
  // A one-off purchase is worth what was paid, however long it was tracked. It must not depend on a
  // window length: a pack that expires before its first reading has no window start to measure from.
  if (meter.reset.kind === 'once') return perMonth * meter.valueShare;
  if (lengthMs === null) return null;
  // A window is never worth more than one billing month.
  return perMonth * Math.min(lengthMs / MONTH, 1) * meter.valueShare;
}

/** Currency of the money figures of a meter. */
export function valueCurrency(account: Pick<Account, 'price'>, meter: Pick<Meter, 'unit'>): string | null {
  if (meter.unit === 'usd') return 'USD';
  return account.price?.currency ?? null;
}

function completeCycle(draft: CycleDraft, account: Account, meter: Meter, seq: number): ClosedCycle {
  const lengthMs = draft.startedAt ? (toMs(draft.endedAt) ?? 0) - (toMs(draft.startedAt) ?? 0) : nominalWindowMs(meter.reset);
  const value = windowValue(account, meter, lengthMs && lengthMs > 0 ? lengthMs : nominalWindowMs(meter.reset));
  return {
    ...draft,
    id: `${draft.meterId}:${draft.endedAt}:${seq}`,
    accountId: account.id,
    providerId: account.providerId,
    accountLabel: account.label,
    wastedValue: value === null ? null : value * draft.wastedFraction,
    currency: valueCurrency(account, meter)
  };
}

function appendCycles(existing: ClosedCycle[], added: ClosedCycle[]): ClosedCycle[] {
  if (added.length === 0) return existing;
  const seen = new Set(existing.map((cycle) => `${cycle.meterId}|${cycle.endedAt}`));
  const merged = existing.slice();
  for (const cycle of added) {
    const key = `${cycle.meterId}|${cycle.endedAt}`;
    if (seen.has(key)) continue; // two processes rolled the same window: record it once
    seen.add(key);
    merged.push(cycle);
  }
  merged.sort((a, b) => (a.endedAt < b.endedAt ? -1 : a.endedAt > b.endedAt ? 1 : 0));
  return merged.length > MAX_CYCLES ? merged.slice(merged.length - MAX_CYCLES) : merged;
}

/**
 * Rolls every meter in the state to `now`. Idempotent; returns the same object when nothing changed so
 * callers can skip a write.
 */
export function rollState(state: State, nowMs: number): State {
  const added: ClosedCycle[] = [];
  let changed = false;
  const accounts = state.accounts.map((account) => {
    let accountChanged = false;
    const meters = account.meters.map((meter) => {
      const { meter: rolled, closed } = rollMeter(meter, nowMs);
      if (rolled !== meter) accountChanged = true;
      if (closed) added.push(completeCycle(closed, account, meter, added.length));
      return rolled;
    });
    if (!accountChanged) return account;
    changed = true;
    return { ...account, meters };
  });
  if (!changed && added.length === 0) return state;
  return { ...state, accounts, cycles: appendCycles(state.cycles, added) };
}

export class ReadingError extends Error {
  constructor(
    readonly field: string,
    message: string
  ) {
    super(message);
    this.name = 'ReadingError';
  }
}

function resolveUsed(reading: Reading, limit: number): number | null {
  const given = [reading.used, reading.remaining, reading.usedPercent, reading.remainingPercent].filter(
    (value) => value !== undefined
  );
  if (given.length === 0) return null;
  if (given.length > 1) {
    throw new ReadingError('used', 'Give one of used, remaining, usedPercent or remainingPercent, not several.');
  }
  const check = (field: string, value: number, max?: number): number => {
    if (!Number.isFinite(value) || value < 0) throw new ReadingError(field, `${field} must be a number of 0 or more.`);
    if (max !== undefined && value > max) throw new ReadingError(field, `${field} must be between 0 and ${max}.`);
    return value;
  };
  if (reading.used !== undefined) return check('used', reading.used);
  if (reading.remaining !== undefined) return Math.max(0, limit - check('remaining', reading.remaining));
  // Multiply before dividing: (55 / 100) * 100 is 55.00000000000001, and "55% used" must store 55.
  if (reading.usedPercent !== undefined) return (check('usedPercent', reading.usedPercent, 100) * limit) / 100;
  return ((100 - check('remainingPercent', reading.remainingPercent as number, 100)) * limit) / 100;
}

function pushSample(meter: Meter, nowMs: number, used: number): Meter['samples'] {
  const samples = meter.samples.slice();
  const last = samples[samples.length - 1];
  // Readings closer than a minute apart replace each other: a status line can fire many times a second.
  if (last && nowMs - (toMs(last.t) ?? 0) < 60_000) samples[samples.length - 1] = { t: iso(nowMs), used };
  else samples.push({ t: iso(nowMs), used });
  if (samples.length <= MAX_SAMPLES) return samples;
  // Thin the older half so a long window keeps its shape without growing without bound.
  const half = Math.floor(samples.length / 2);
  const thinned = samples.slice(0, half).filter((_, index) => index % 2 === 0);
  return thinned.concat(samples.slice(half));
}

/**
 * Applies one reading. Returns the updated meter and, when the reading revealed that a window had ended,
 * the finished cycle to record.
 */
export function applyReading(meter: Meter, reading: Reading, nowMs: number): { meter: Meter; closed: CycleDraft | null } {
  const rolled = rollMeter(meter, nowMs);
  let current = rolled.meter;
  let closed = rolled.closed;

  let limit = current.limit;
  // What the reading's own amounts are out of. It differs from the meter's limit only on a percentage-only
  // meter, which keeps its limit of 100: "45 of 200" has to be stored there as 22.5, not as 45.
  let outOf = limit;
  if (reading.limit !== undefined) {
    if (!Number.isFinite(reading.limit) || reading.limit <= 0) {
      throw new ReadingError('limit', 'limit must be a number greater than 0.');
    }
    outOf = reading.limit;
    limit = current.unit === 'percent' ? 100 : reading.limit;
  }

  let newEnd: number | null = null;
  if (reading.resetsAt !== undefined) {
    newEnd = toMs(reading.resetsAt);
    if (newEnd === null) throw new ReadingError('resetsAt', 'resetsAt must be an ISO 8601 date and time.');
  }
  let newStart: number | null = null;
  if (reading.windowStartedAt !== undefined) {
    newStart = toMs(reading.windowStartedAt);
    if (newStart === null) {
      throw new ReadingError('windowStartedAt', 'windowStartedAt must be an ISO 8601 date and time.');
    }
  }

  const reported = resolveUsed(reading, outOf);
  const used = reported === null || outOf === limit ? reported : (reported * limit) / outOf;
  if (used === null && newEnd === null && reading.limit === undefined) {
    throw new ReadingError('used', 'A reading needs an amount (used, remaining or a percentage) or a reset time.');
  }

  const nominal = nominalWindowMs(current.reset);
  const oldEnd = toMs(current.resetsAt);

  if (newEnd !== null && newEnd > nowMs) {
    const sameWindow = oldEnd !== null && Math.abs(newEnd - oldEnd) < (windowLengthMs(current) ?? nominal ?? DAY) / 2;
    if (oldEnd !== null && !sameWindow && newEnd > oldEnd) {
      // The provider is already in a later window than the one we were tracking.
      closed = closed ?? closeWindow(current, oldEnd);
      current = { ...current, used: 0, samples: [], windowStartedAt: null };
    } else if (oldEnd !== null && !sameWindow) {
      // An earlier reset than we believed: the anchor was wrong. Keep the usage, drop the stale start.
      current = { ...current, windowStartedAt: null };
    }
    current = { ...current, resetsAt: iso(newEnd), expired: false };
    const start = newStart ?? windowStartFor(current.reset, newEnd) ?? toMs(current.windowStartedAt);
    current = { ...current, windowStartedAt: start === null ? current.windowStartedAt : iso(start) };
  } else if (newEnd !== null && newEnd <= nowMs && current.reset.kind !== 'once') {
    throw new ReadingError('resetsAt', 'resetsAt is in the past.');
  } else if (newEnd !== null) {
    current = { ...current, resetsAt: iso(newEnd) };
  } else if (newStart !== null) {
    current = { ...current, windowStartedAt: iso(newStart) };
  }

  // A rolling window with no clock starts at the first reading that shows any use.
  if (current.reset.kind === 'rolling' && current.resetsAt === null && used !== null && used > 0) {
    current = {
      ...current,
      windowStartedAt: iso(nowMs),
      resetsAt: iso(nowMs + current.reset.hours * HOUR)
    };
  }
  // `once` credits bought today: remember when tracking began so pace has a baseline.
  if (current.reset.kind === 'once' && current.windowStartedAt === null && current.resetsAt !== null) {
    current = { ...current, windowStartedAt: iso(nowMs) };
  }

  const nextUsed = used ?? current.used;
  current = {
    ...current,
    limit,
    used: nextUsed,
    samples: used === null ? current.samples : pushSample(current, nowMs, nextUsed),
    updatedAt: used === null ? current.updatedAt : iso(nowMs),
    estimated: used === null ? current.estimated : false,
    source: reading.source ?? current.source
  };
  return { meter: current, closed };
}

/** Applies a reading to a meter inside the state, recording a finished cycle when one results. */
export function applyReadingToState(
  state: State,
  accountId: string,
  meterId: string,
  reading: Reading,
  nowMs: number
): State {
  const rolled = rollState(state, nowMs);
  const account = rolled.accounts.find((candidate) => candidate.id === accountId);
  const meter = account?.meters.find((candidate) => candidate.id === meterId);
  if (!account || !meter) throw new ReadingError('meter', 'No such meter.');
  const { meter: next, closed } = applyReading(meter, reading, nowMs);
  const accounts = rolled.accounts.map((candidate) =>
    candidate.id === accountId
      ? {
          ...candidate,
          updatedAt: iso(nowMs),
          meters: candidate.meters.map((m) => (m.id === meterId ? next : m))
        }
      : candidate
  );
  const cycles = closed ? appendCycles(rolled.cycles, [completeCycle(closed, account, meter, 0)]) : rolled.cycles;
  return { ...rolled, accounts, cycles };
}
