import { describe, expect, it } from 'vitest';

import { addAccount, type AccountInput, type MeterInput } from '../../src/core/accounts.js';
import { viewMeter } from '../../src/core/forecast.js';
import {
  BILLING_MONTH_HOURS,
  adoptSchedule,
  MAX_SAMPLES,
  ReadingError,
  anchorMeter,
  applyReading,
  applyReadingToState,
  nextBoundary,
  nominalWindowMs,
  previousBoundary,
  rollMeter,
  rollState,
  staleAfterMs,
  windowLengthMs,
  windowStartFor
} from '../../src/core/reset.js';
import { DAY, HOUR, MINUTE, MONTH, iso, zonedParts } from '../../src/core/time.js';
import { emptyState, type Account, type Meter, type Reading, type ResetRule, type State } from '../../src/core/types.js';

const LA = 'America/Los_Angeles';
const utc = (y: number, mo: number, d: number, h = 0, mi = 0): number => Date.UTC(y, mo - 1, d, h, mi, 0);
/** Thursday 19 November 2026, 10:00 UTC. */
const NOW = utc(2026, 11, 19, 10, 0);
const WEEK = 7 * DAY;
const WEEKLY: ResetRule = { kind: 'interval', hours: 168 };

function one(
  input: MeterInput,
  nowMs = NOW,
  extra: Partial<AccountInput> = {}
): { state: State; account: Account; meter: Meter } {
  const { state, account } = addAccount(emptyState(), { label: 'Test', meters: [input], ...extra }, nowMs);
  return { state, account, meter: account.meters[0] as Meter };
}

function expectReadingError(run: () => unknown, field: string): ReadingError {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ReadingError);
  const error = caught as ReadingError;
  expect(error.field).toBe(field);
  expect(error.message.length).toBeGreaterThan(0);
  return error;
}

describe('nextBoundary and previousBoundary', () => {
  describe('monthly', () => {
    it('ends on day 30 at the configured time when the rule says day 31 and the month has 30 days', () => {
      // Scenario: Monthly day beyond the month's length.
      const rule: ResetRule = { kind: 'monthly', day: 31, time: '09:00', tz: 'UTC' };
      expect(iso(nextBoundary(rule, NOW) as number)).toBe('2026-11-30T09:00:00.000Z');
    });

    it('clamps day 31 to the last day of February, leap years included', () => {
      const rule: ResetRule = { kind: 'monthly', day: 31, time: '00:00', tz: 'UTC' };
      expect(iso(nextBoundary(rule, utc(2026, 2, 10)) as number)).toBe('2026-02-28T00:00:00.000Z');
      expect(iso(nextBoundary(rule, utc(2028, 2, 10)) as number)).toBe('2028-02-29T00:00:00.000Z');
      expect(iso(previousBoundary(rule, utc(2026, 3, 10)) as number)).toBe('2026-02-28T00:00:00.000Z');
    });

    it('walks month ends in order over a year', () => {
      const rule: ResetRule = { kind: 'monthly', day: 31, time: '00:00', tz: 'UTC' };
      const seen: string[] = [];
      let at = NOW;
      for (let n = 0; n < 7; n += 1) {
        at = nextBoundary(rule, at) as number;
        seen.push(iso(at).slice(0, 10));
      }
      expect(seen).toEqual(['2026-11-30', '2026-12-31', '2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30', '2027-05-31']);
    });

    it('is strictly after for next and at-or-before for previous', () => {
      const rule: ResetRule = { kind: 'monthly', day: 31, time: '00:00', tz: 'UTC' };
      const boundary = utc(2026, 11, 30);
      expect(nextBoundary(rule, boundary)).toBe(utc(2026, 12, 31));
      expect(nextBoundary(rule, boundary - 1)).toBe(boundary);
      expect(previousBoundary(rule, boundary)).toBe(boundary);
      expect(previousBoundary(rule, boundary - 1)).toBe(utc(2026, 10, 31));
    });

    it('uses the wall clock of the rule zone', () => {
      const rule: ResetRule = { kind: 'monthly', day: 1, time: '00:00', tz: 'Europe/Stockholm' };
      // Midnight on 1 December in Stockholm (CET) is 23:00 UTC on 30 November.
      expect(iso(nextBoundary(rule, NOW) as number)).toBe('2026-11-30T23:00:00.000Z');
      expect(iso(previousBoundary(rule, NOW) as number)).toBe('2026-10-31T23:00:00.000Z');
    });

    it('rolls over the year end', () => {
      const rule: ResetRule = { kind: 'monthly', day: 1, time: '00:00', tz: 'UTC' };
      expect(iso(nextBoundary(rule, utc(2026, 12, 15)) as number)).toBe('2027-01-01T00:00:00.000Z');
      expect(iso(previousBoundary(rule, utc(2027, 1, 1) - 1) as number)).toBe('2026-12-01T00:00:00.000Z');
    });
  });

  describe('daily', () => {
    const rule: ResetRule = { kind: 'daily', time: '00:00', tz: LA };

    it('stays at 00:00 Los Angeles time across the spring-forward change', () => {
      // Scenario: Daily reset across a daylight-saving change.
      const noonBefore = utc(2026, 3, 7, 20, 0); // 12:00 PST on 7 March
      const first = nextBoundary(rule, noonBefore) as number;
      const second = nextBoundary(rule, first) as number;
      const third = nextBoundary(rule, second) as number;
      expect([iso(first), iso(second), iso(third)]).toEqual([
        '2026-03-08T08:00:00.000Z',
        '2026-03-09T07:00:00.000Z',
        '2026-03-10T07:00:00.000Z'
      ]);
      expect(second - first).toBe(23 * HOUR);
      for (const at of [first, second, third]) {
        expect(zonedParts(at, LA)).toMatchObject({ hour: 0, minute: 0 });
      }
    });

    it('stays at 00:00 Los Angeles time across the fall-back change', () => {
      const first = nextBoundary(rule, utc(2026, 10, 31, 20, 0)) as number;
      const second = nextBoundary(rule, first) as number;
      expect([iso(first), iso(second)]).toEqual(['2026-11-01T07:00:00.000Z', '2026-11-02T08:00:00.000Z']);
      expect(second - first).toBe(25 * HOUR);
      expect(zonedParts(second, LA)).toMatchObject({ day: 2, hour: 0, minute: 0 });
    });

    it('finds the previous boundary on either side of the change', () => {
      expect(iso(previousBoundary(rule, utc(2026, 3, 8, 20, 0)) as number)).toBe('2026-03-08T08:00:00.000Z');
      expect(iso(previousBoundary(rule, utc(2026, 3, 9, 7, 0)) as number)).toBe('2026-03-09T07:00:00.000Z');
      expect(iso(previousBoundary(rule, utc(2026, 3, 9, 7, 0) - 1) as number)).toBe('2026-03-08T08:00:00.000Z');
    });

    it('honours the configured time of day', () => {
      const morning: ResetRule = { kind: 'daily', time: '09:30', tz: 'UTC' };
      expect(iso(nextBoundary(morning, utc(2026, 11, 19, 9, 0)) as number)).toBe('2026-11-19T09:30:00.000Z');
      expect(iso(nextBoundary(morning, utc(2026, 11, 19, 9, 30)) as number)).toBe('2026-11-20T09:30:00.000Z');
      expect(iso(previousBoundary(morning, utc(2026, 11, 19, 9, 0)) as number)).toBe('2026-11-18T09:30:00.000Z');
    });
  });

  it('has no calendar for the other rule kinds', () => {
    const rules: ResetRule[] = [{ kind: 'rolling', hours: 5 }, WEEKLY, { kind: 'once' }, { kind: 'none' }];
    for (const rule of rules) {
      expect(nextBoundary(rule, NOW)).toBeNull();
      expect(previousBoundary(rule, NOW)).toBeNull();
    }
  });
});

describe('window helpers', () => {
  it('nominalWindowMs follows the rule', () => {
    expect(nominalWindowMs({ kind: 'rolling', hours: 5 })).toBe(5 * HOUR);
    expect(nominalWindowMs(WEEKLY)).toBe(WEEK);
    expect(nominalWindowMs({ kind: 'daily', time: '00:00', tz: 'UTC' })).toBe(DAY);
    expect(nominalWindowMs({ kind: 'monthly', day: 1, time: '00:00', tz: 'UTC' })).toBe(MONTH);
    expect(nominalWindowMs({ kind: 'once' })).toBeNull();
    expect(nominalWindowMs({ kind: 'none' })).toBeNull();
  });

  it('windowStartFor is one length back, or the previous wall-clock boundary', () => {
    const end = utc(2026, 11, 30);
    expect(windowStartFor(WEEKLY, end)).toBe(end - WEEK);
    expect(windowStartFor({ kind: 'rolling', hours: 5 }, end)).toBe(end - 5 * HOUR);
    expect(windowStartFor({ kind: 'daily', time: '00:00', tz: 'UTC' }, end)).toBe(end - DAY);
    expect(windowStartFor({ kind: 'monthly', day: 31, time: '00:00', tz: 'UTC' }, end)).toBe(utc(2026, 10, 31));
    expect(windowStartFor({ kind: 'once' }, end)).toBeNull();
    expect(windowStartFor({ kind: 'none' }, end)).toBeNull();
  });

  it('windowStartFor treats a reset shortly after a boundary as that boundary reported late', () => {
    const monthly: ResetRule = { kind: 'monthly', day: 12, time: '00:00', tz: 'UTC' };
    // The provider really resets at 14:37 on the 12th: the window still began on the previous 12th.
    expect(iso(windowStartFor(monthly, utc(2026, 12, 12, 14, 37)) as number)).toBe('2026-11-12T00:00:00.000Z');
    expect(iso(windowStartFor(monthly, utc(2026, 12, 14)) as number)).toBe('2026-11-12T00:00:00.000Z');
    // A reset a little before a boundary is that boundary reported early.
    expect(iso(windowStartFor(monthly, utc(2026, 12, 11, 20, 0)) as number)).toBe('2026-11-12T00:00:00.000Z');
    expect(iso(windowStartFor(monthly, utc(2026, 11, 28, 10, 0)) as number)).toBe('2026-11-12T00:00:00.000Z');
    // On the boundary itself nothing changes.
    expect(iso(windowStartFor(monthly, utc(2026, 12, 12)) as number)).toBe('2026-11-12T00:00:00.000Z');

    const daily: ResetRule = { kind: 'daily', time: '00:00', tz: 'UTC' };
    expect(iso(windowStartFor(daily, utc(2026, 11, 20, 0, 30)) as number)).toBe('2026-11-19T00:00:00.000Z');
    expect(iso(windowStartFor(daily, utc(2026, 11, 20, 20, 0)) as number)).toBe('2026-11-20T00:00:00.000Z');
    expect(iso(windowStartFor(daily, utc(2026, 11, 20)) as number)).toBe('2026-11-19T00:00:00.000Z');
    // A window never starts at or after its own end, wherever the end falls.
    for (let minutes = 0; minutes <= 3 * 24 * 60; minutes += 37) {
      const end = utc(2026, 3, 7) + minutes * MINUTE; // spans the Los Angeles clock change
      const start = windowStartFor({ kind: 'daily', time: '00:00', tz: LA }, end) as number;
      expect(end - start).toBeGreaterThanOrEqual(11 * HOUR);
      expect(end - start).toBeLessThanOrEqual(37 * HOUR);
    }
  });

  it('windowLengthMs is the real span of the current window', () => {
    const monthly = one({ label: 'Monthly', unit: 'credits', limit: 100, reset: { kind: 'monthly', day: 1, time: '00:00', tz: 'UTC' } }).meter;
    expect(windowLengthMs(monthly)).toBe(30 * DAY); // November
    const dstDay = one({ label: 'Daily', reset: { kind: 'daily', time: '00:00', tz: LA } }, utc(2026, 3, 8, 20, 0)).meter;
    expect(windowLengthMs(dstDay)).toBe(23 * HOUR);
    const idle = one({ label: 'Session', role: 'throttle', reset: { kind: 'rolling', hours: 5 } }).meter;
    expect(windowLengthMs(idle)).toBeNull();
  });

  it('staleAfterMs is 20% of the window, never under 30 minutes or over 48 hours', () => {
    const weekly = one({ label: 'Weekly', reset: WEEKLY, resetsAt: iso(NOW + DAY) }).meter;
    expect(staleAfterMs(weekly)).toBeCloseTo(33.6 * HOUR, 3);
    const session = one({ label: 'Session', reset: { kind: 'rolling', hours: 5 }, resetsAt: iso(NOW + HOUR) }).meter;
    expect(staleAfterMs(session)).toBe(HOUR);
    const hourly = one({ label: 'Hourly', reset: { kind: 'interval', hours: 1 }, resetsAt: iso(NOW + 20 * MINUTE) }).meter;
    expect(staleAfterMs(hourly)).toBe(30 * MINUTE);
    const monthly = one({ label: 'Monthly', reset: { kind: 'monthly', day: 1, time: '00:00', tz: 'UTC' } }).meter;
    expect(staleAfterMs(monthly)).toBe(48 * HOUR);
    const balance = one({ label: 'Balance', reset: { kind: 'none' } }).meter;
    expect(staleAfterMs(balance)).toBe(48 * HOUR);
  });
});

describe('anchorMeter', () => {
  it('gives a monthly meter its next reset and the start of its window', () => {
    // Scenario: Create a custom account.
    const { account, meter } = one(
      { label: 'Monthly credits', unit: 'credits', limit: 2500, reset: { kind: 'monthly', day: 12, time: '00:00', tz: 'UTC' } },
      NOW,
      { label: 'Suno Pro' }
    );
    expect(account.label).toBe('Suno Pro');
    expect(meter).toMatchObject({
      label: 'Monthly credits',
      unit: 'credits',
      limit: 2500,
      used: 0,
      role: 'allowance',
      resetsAt: '2026-12-12T00:00:00.000Z',
      windowStartedAt: '2026-11-12T00:00:00.000Z'
    });
  });

  it('gives a daily meter its next reset', () => {
    const { meter } = one({ label: 'Daily', reset: { kind: 'daily', time: '00:00', tz: LA } });
    expect(meter.resetsAt).toBe('2026-11-20T08:00:00.000Z');
    expect(meter.windowStartedAt).toBe('2026-11-19T08:00:00.000Z');
  });

  it('leaves rules whose anchor only the provider knows without a reset time', () => {
    for (const reset of [{ kind: 'rolling', hours: 5 }, WEEKLY, { kind: 'once' }, { kind: 'none' }] as ResetRule[]) {
      const { meter } = one({ label: 'M', reset });
      expect(meter.resetsAt).toBeNull();
      expect(meter.windowStartedAt).toBeNull();
    }
  });

  it('starts the clock of a one-off expiry when it is first tracked', () => {
    const pack = (resetsAt?: string): Meter =>
      one({ label: 'Credit pack', unit: 'credits', limit: 1000, reset: { kind: 'once' }, ...(resetsAt ? { resetsAt } : {}) }).meter;
    // Known expiry: the window runs from now to the expiry.
    expect(pack(iso(NOW + 30 * DAY))).toMatchObject({ windowStartedAt: iso(NOW), resetsAt: iso(NOW + 30 * DAY) });
    expect(windowLengthMs(pack(iso(NOW + 30 * DAY)))).toBe(30 * DAY);
    // No expiry yet, or one that has already passed: nothing to count down.
    expect(pack().windowStartedAt).toBeNull();
    expect(pack(iso(NOW - DAY)).windowStartedAt).toBeNull();
    // A start that is already known is never overwritten.
    const started = pack(iso(NOW + 30 * DAY));
    expect(anchorMeter(started, NOW + 5 * DAY)).toBe(started);
    expect(rollMeter(started, NOW + 5 * DAY).meter).toBe(started);
    const explicit = one({ label: 'Pack', unit: 'credits', limit: 1000, reset: { kind: 'once' }, resetsAt: iso(NOW + 30 * DAY), windowStartedAt: iso(NOW - 10 * DAY) }).meter;
    expect(explicit.windowStartedAt).toBe(iso(NOW - 10 * DAY));
  });

  it('fills in the window start when the reset time is known', () => {
    const { meter } = one({ label: 'Weekly', reset: WEEKLY, resetsAt: '2026-11-20T00:00:00Z' });
    expect(meter.resetsAt).toBe('2026-11-20T00:00:00.000Z');
    expect(meter.windowStartedAt).toBe('2026-11-13T00:00:00.000Z');
  });

  it('returns the same object when there is nothing to anchor', () => {
    const { meter } = one({ label: 'Weekly', reset: WEEKLY, resetsAt: '2026-11-20T00:00:00Z' });
    expect(anchorMeter(meter, NOW)).toBe(meter);
    expect(anchorMeter(meter, NOW + 30 * DAY)).toBe(meter);
  });
});

describe('rollMeter', () => {
  it('leaves a window that has not ended alone', () => {
    const { meter } = one({ label: 'Weekly', reset: WEEKLY, used: 40, resetsAt: iso(NOW + DAY) });
    const rolled = rollMeter(meter, NOW);
    expect(rolled.meter).toBe(meter);
    expect(rolled.closed).toBeNull();
  });

  it('interval: enters the next window with nothing used and an estimated marker', () => {
    // Scenario: Weekly meter passes its reset.
    const reset = NOW + DAY;
    const { meter } = one({ label: 'Weekly', reset: WEEKLY, used: 40, resetsAt: iso(reset) });
    const { meter: rolled, closed } = rollMeter(meter, reset + HOUR);
    expect(rolled).toMatchObject({
      used: 0,
      resetsAt: iso(reset + WEEK),
      windowStartedAt: iso(reset),
      estimated: true,
      samples: [],
      expired: false
    });
    expect(closed).toMatchObject({ endedAt: iso(reset), startedAt: iso(reset - WEEK), used: 40, limit: 100 });
  });

  it('interval: rolls at the reset instant itself', () => {
    const reset = NOW + DAY;
    const { meter } = one({ label: 'Weekly', reset: WEEKLY, used: 40, resetsAt: iso(reset) });
    expect(rollMeter(meter, reset - 1).meter).toBe(meter);
    expect(rollMeter(meter, reset).meter.resetsAt).toBe(iso(reset + WEEK));
  });

  it('interval: lands in the window containing now after several were missed', () => {
    const reset = NOW + DAY;
    const { meter } = one({ label: 'Weekly', reset: WEEKLY, used: 40, resetsAt: iso(reset) });
    const later = reset + 2 * WEEK + 3 * DAY;
    const { meter: rolled, closed } = rollMeter(meter, later);
    expect(rolled.windowStartedAt).toBe(iso(reset + 2 * WEEK));
    expect(rolled.resetsAt).toBe(iso(reset + 3 * WEEK));
    expect(rolled.used).toBe(0);
    // Only the window that was actually observed is offered for recording.
    expect(closed).toMatchObject({ endedAt: iso(reset), used: 40 });
  });

  it('daily: three missed windows place the meter in the current one and offer only the first for recording', () => {
    // Scenario: Several windows pass while nothing is running.
    const { state, meter } = one({ label: 'Daily', unit: 'requests', limit: 50, used: 20, reset: { kind: 'daily', time: '00:00', tz: 'UTC' } });
    expect(meter.resetsAt).toBe('2026-11-20T00:00:00.000Z');
    const later = utc(2026, 11, 22, 6, 0); // the windows ending on the 20th, 21st and 22nd have passed
    const { meter: rolled, closed } = rollMeter(meter, later);
    expect(rolled).toMatchObject({
      windowStartedAt: '2026-11-22T00:00:00.000Z',
      resetsAt: '2026-11-23T00:00:00.000Z',
      used: 0,
      estimated: true
    });
    expect(closed).toMatchObject({ endedAt: '2026-11-20T00:00:00.000Z', startedAt: '2026-11-19T00:00:00.000Z', used: 20 });

    const next = rollState(state, later);
    expect(next.cycles).toHaveLength(1);
    expect(next.cycles[0]).toMatchObject({ endedAt: '2026-11-20T00:00:00.000Z', used: 20 });
  });

  it('daily: keeps wall-clock midnight when the missed windows span a clock change', () => {
    const { meter } = one({ label: 'Daily', reset: { kind: 'daily', time: '00:00', tz: LA } }, utc(2026, 3, 7, 20, 0));
    const { meter: rolled } = rollMeter(meter, utc(2026, 3, 9, 20, 0));
    expect(rolled.windowStartedAt).toBe('2026-03-09T07:00:00.000Z');
    expect(rolled.resetsAt).toBe('2026-03-10T07:00:00.000Z');
  });

  it('monthly: enters the next calendar window', () => {
    const { meter } = one({ label: 'Monthly', unit: 'requests', limit: 300, used: 120, reset: { kind: 'monthly', day: 1, time: '00:00', tz: 'UTC' } });
    const { meter: rolled, closed } = rollMeter(meter, utc(2026, 12, 3));
    expect(rolled).toMatchObject({
      used: 0,
      windowStartedAt: '2026-12-01T00:00:00.000Z',
      resetsAt: '2027-01-01T00:00:00.000Z',
      estimated: true
    });
    expect(closed).toMatchObject({ startedAt: '2026-11-01T00:00:00.000Z', endedAt: '2026-12-01T00:00:00.000Z', used: 120 });
  });

  it('monthly: a reset reported a little before the boundary does not leave a sliver of a window behind', () => {
    // The provider resets at 20:00 on the 11th; the rule says the 12th. The reported reset wins, and the
    // rule follows it, so the next window is a whole month and not the four hours up to the old boundary.
    let meter = one({ label: 'Monthly credits', unit: 'credits', limit: 2500, reset: { kind: 'monthly', day: 12, time: '00:00', tz: 'UTC' } }).meter;
    meter = applyReading(meter, { remaining: 1200, resetsAt: '2026-12-11T20:00:00Z' }, utc(2026, 12, 11, 19, 0)).meter;
    const { meter: rolled, closed } = rollMeter(meter, utc(2026, 12, 11, 21, 0));
    expect(closed).toMatchObject({ endedAt: '2026-12-11T20:00:00.000Z', used: 1300 });
    expect(rolled.windowStartedAt).toBe('2026-12-11T20:00:00.000Z');
    expect(rolled.reset).toEqual({ kind: 'monthly', day: 11, time: '20:00', tz: 'UTC' });
    expect(rolled.resetsAt).toBe('2027-01-11T20:00:00.000Z');
    // Nothing more happens when the old boundary passes four hours later.
    const later = rollMeter(rolled, utc(2026, 12, 12, 1, 0));
    expect(later.meter).toBe(rolled);
    expect(later.closed).toBeNull();
  });

  it('a billing-cycle placeholder becomes a monthly rule on the day the provider reports', () => {
    let meter = one({ label: 'Monthly credits', unit: 'credits', limit: 2500, reset: { kind: 'interval', hours: BILLING_MONTH_HOURS } }).meter;
    expect(meter.resetsAt).toBeNull();
    meter = applyReading(meter, { remaining: 1200, resetsAt: '2026-11-28T10:00:00Z' }, NOW).meter;
    expect(meter.reset.kind).toBe('monthly');
    const adopted = adoptSchedule({ kind: 'monthly', day: 1, time: '00:00', tz: 'UTC' }, Date.parse('2026-11-28T10:00:00Z'));
    expect(adopted).toEqual({ kind: 'monthly', day: 28, time: '10:00', tz: 'UTC' });
    // After the reset the next window ends a calendar month later, not 730.5 hours later.
    const rolled = rollMeter(meter, Date.parse('2026-11-28T10:00:01Z')).meter;
    expect(Date.parse(rolled.resetsAt as string) - Date.parse('2026-11-28T10:00:00Z')).toBe(30 * DAY);
  });
  it('a reset on the last day of a short month does not shorten a day-31 rule', () => {
    const rule = { kind: 'monthly', day: 31, time: '00:00', tz: 'UTC' } as const;
    expect(adoptSchedule(rule, Date.parse('2027-02-28T09:15:00Z'))).toEqual({ kind: 'monthly', day: 31, time: '09:15', tz: 'UTC' });
    expect(adoptSchedule(rule, Date.parse('2027-02-20T09:15:00Z'))).toEqual({ kind: 'monthly', day: 20, time: '09:15', tz: 'UTC' });
  });
  it('rules without a calendar are left alone by a reported reset', () => {
    for (const rule of [{ kind: 'rolling', hours: 5 }, { kind: 'interval', hours: 168 }, { kind: 'once' }, { kind: 'none' }] as const) {
      expect(adoptSchedule(rule, NOW + DAY)).toBe(rule);
    }
  });
  it('daily: a reset reported a little before the boundary does not leave a sliver of a window behind', () => {
    let meter = one({ label: 'Daily', unit: 'requests', limit: 50, reset: { kind: 'daily', time: '00:00', tz: 'UTC' } }).meter;
    meter = applyReading(meter, { used: 20, resetsAt: '2026-11-19T23:30:00Z' }, NOW).meter;
    const { meter: rolled } = rollMeter(meter, utc(2026, 11, 19, 23, 45));
    expect(rolled.reset).toEqual({ kind: 'daily', time: '23:30', tz: 'UTC' });
    expect(rolled.resetsAt).toBe('2026-11-20T23:30:00.000Z');
    expect(rolled.windowStartedAt).toBe('2026-11-19T23:30:00.000Z');
  });

  it('rolling: becomes idle', () => {
    const { meter } = one({ label: 'Session', role: 'throttle', reset: { kind: 'rolling', hours: 5 }, used: 80, resetsAt: iso(NOW + HOUR) });
    expect(meter.windowStartedAt).toBe(iso(NOW - 4 * HOUR));
    const { meter: rolled, closed } = rollMeter(meter, NOW + 2 * HOUR);
    expect(rolled).toMatchObject({ used: 0, resetsAt: null, windowStartedAt: null, samples: [] });
    expect(closed).toBeNull(); // a throttle is never recorded
    // Idle means idle: more time passing changes nothing.
    expect(rollMeter(rolled, NOW + 10 * DAY).meter).toBe(rolled);
  });

  it('once: is marked expired and is no longer advanced', () => {
    // Scenario: Prepaid credits expire.
    const expiry = NOW + 3 * DAY;
    const { meter } = one({ label: 'Credit pack', unit: 'credits', limit: 1000, used: 600, reset: { kind: 'once' }, resetsAt: iso(expiry) });
    const first = rollMeter(meter, expiry + MINUTE);
    expect(first.meter).toMatchObject({ expired: true, resetsAt: iso(expiry), used: 600 });
    expect(first.closed).toMatchObject({ endedAt: iso(expiry), used: 600, limit: 1000 });
    const second = rollMeter(first.meter, expiry + 400 * DAY);
    expect(second.meter).toBe(first.meter);
    expect(second.closed).toBeNull();
  });

  it('none: has no clock to pass', () => {
    const { meter } = one({ label: 'Balance', unit: 'usd', limit: 20, used: 5, reset: { kind: 'none' } });
    const rolled = rollMeter(meter, NOW + 400 * DAY);
    expect(rolled.meter).toBe(meter);
    expect(rolled.closed).toBeNull();
  });
});

describe('applyReading', () => {
  const credits = (): Meter =>
    one({ label: 'Monthly credits', unit: 'credits', limit: 2500, reset: { kind: 'monthly', day: 12, time: '00:00', tz: 'UTC' } }).meter;
  const requests = (): Meter =>
    one({ label: 'Premium requests', unit: 'requests', limit: 300, reset: { kind: 'monthly', day: 1, time: '00:00', tz: 'UTC' } }).meter;
  const percent = (): Meter => one({ label: 'Weekly', reset: WEEKLY, resetsAt: iso(NOW + 2 * DAY) }).meter;

  it('turns a remaining amount into an amount used', () => {
    // Scenario: Remaining amount.
    expect(applyReading(credits(), { remaining: 1200 }, NOW).meter.used).toBe(1300);
  });

  it('turns a percentage into the unit of a counted meter', () => {
    // Scenario: Percentage on a counted meter.
    expect(applyReading(requests(), { usedPercent: 40 }, NOW).meter.used).toBe(120);
    expect(applyReading(requests(), { remainingPercent: 40 }, NOW).meter.used).toBe(180);
  });

  it('stores 62 for "62% used" on a percentage-only meter with limit 100', () => {
    // Scenario: Percentage-only meter.
    const meter = percent();
    expect(meter.unit).toBe('percent');
    expect(meter.limit).toBe(100);
    expect(applyReading(meter, { usedPercent: 62 }, NOW).meter.used).toBe(62);
    expect(applyReading(meter, { remainingPercent: 38 }, NOW).meter.used).toBe(62);
  });

  it('stores every whole percentage exactly, without floating-point residue', () => {
    const meter = percent();
    for (let n = 0; n <= 100; n += 1) {
      expect(applyReading(meter, { usedPercent: n }, NOW).meter.used).toBe(n);
      expect(applyReading(meter, { remainingPercent: n }, NOW).meter.used).toBe(100 - n);
    }
    expect(applyReading(meter, { usedPercent: 62.5 }, NOW).meter.used).toBe(62.5);
  });

  it('keeps an over-limit amount as reported and treats the meter as fully used', () => {
    // Scenario: Usage beyond the limit.
    const { state, account, meter } = one({ label: 'Premium requests', unit: 'requests', limit: 300, reset: { kind: 'monthly', day: 1, time: '00:00', tz: 'UTC' } });
    const next = applyReadingToState(state, account.id, meter.id, { used: 340 }, NOW);
    const stored = (next.accounts[0] as Account).meters[0] as Meter;
    expect(stored.used).toBe(340);
    const view = viewMeter(next.accounts[0] as Account, stored, NOW);
    expect(view.usedFraction).toBe(1);
    expect(view.remaining).toBe(0);
    expect(view.tier).toBe('spent');
  });

  it('says so when more is left than the limit, instead of quietly calling it "nothing used"', () => {
    // 3,000 left of a 2,500 limit: the limit is stale, and the answer names it.
    expectReadingError(() => applyReading(credits(), { remaining: 3000 }, NOW), 'remaining');
    // With the new limit alongside, it is a reading like any other.
    expect(applyReading(credits(), { remaining: 3000, limit: 5000 }, NOW).meter).toMatchObject({ used: 2000, limit: 5000 });
    // Quota that carries over can hold more than one grant: the balance is what is available.
    const banked = applyReading({ ...credits(), rollover: 'carries' }, { remaining: 3000 }, NOW).meter;
    expect(banked).toMatchObject({ used: 0, limit: 3000 });
    expect(applyReading(banked, { remaining: 2400 }, NOW + HOUR).meter).toMatchObject({ used: 600, limit: 3000 });
  });

  it('stores the time of the reading, clears the estimated marker and keeps a sample', () => {
    const { meter } = one({ label: 'Weekly', reset: WEEKLY, resetsAt: iso(NOW + 2 * DAY) });
    expect(meter.updatedAt).toBeNull();
    const first = applyReading({ ...meter, estimated: true }, { usedPercent: 10 }, NOW).meter;
    expect(first).toMatchObject({ updatedAt: iso(NOW), estimated: false, samples: [{ t: iso(NOW), used: 10 }] });
    const second = applyReading(first, { usedPercent: 25 }, NOW + HOUR).meter;
    expect(second.samples).toEqual([
      { t: iso(NOW), used: 10 },
      { t: iso(NOW + HOUR), used: 25 }
    ]);
    expect(second.updatedAt).toBe(iso(NOW + HOUR));
  });

  it('replaces the last sample when readings arrive within a minute of each other', () => {
    let meter = percent();
    meter = applyReading(meter, { usedPercent: 10 }, NOW).meter;
    meter = applyReading(meter, { usedPercent: 11 }, NOW + 20_000).meter;
    meter = applyReading(meter, { usedPercent: 12 }, NOW + 40_000).meter;
    expect(meter.samples).toEqual([{ t: iso(NOW + 40_000), used: 12 }]);
    expect(meter.used).toBe(12);
  });

  it('bounds the samples of one window', () => {
    let meter = one({ label: 'Monthly', reset: { kind: 'monthly', day: 1, time: '00:00', tz: 'UTC' } }, utc(2026, 11, 1, 1, 0)).meter;
    const start = utc(2026, 11, 1, 1, 0);
    for (let n = 0; n < 600; n += 1) {
      meter = applyReading(meter, { usedPercent: n / 10 }, start + n * 10 * MINUTE).meter;
    }
    expect(meter.samples.length).toBeLessThanOrEqual(MAX_SAMPLES);
    expect(meter.samples[0]).toEqual({ t: iso(start), used: 0 });
    expect(meter.samples[meter.samples.length - 1]).toEqual({ t: iso(start + 599 * 10 * MINUTE), used: 59.9 });
    const times = meter.samples.map((sample) => sample.t);
    expect(times).toEqual(times.slice().sort());
  });

  it('records where the reading came from', () => {
    const next = applyReading(percent(), { usedPercent: 10, source: { kind: 'agent', id: 'claude-code' } }, NOW).meter;
    expect(next.source).toEqual({ kind: 'agent', id: 'claude-code' });
  });

  it('accepts a new limit, except on percentage-only meters', () => {
    expect(applyReading(credits(), { used: 100, limit: 10_000 }, NOW).meter).toMatchObject({ used: 100, limit: 10_000 });
    expect(applyReading(credits(), { usedPercent: 50, limit: 10_000 }, NOW).meter).toMatchObject({ used: 5000, limit: 10_000 });
    expect(applyReading(percent(), { usedPercent: 50, limit: 500 }, NOW).meter).toMatchObject({ used: 50, limit: 100 });
  });

  it('converts a count with its own limit into the unit of a percentage-only meter', () => {
    // "45 of 200" read off a usage page is 22.5% of the allowance, not 45%.
    expect(applyReading(percent(), { used: 45, limit: 200 }, NOW).meter).toMatchObject({ used: 22.5, limit: 100 });
    expect(applyReading(percent(), { remaining: 150, limit: 200 }, NOW).meter).toMatchObject({ used: 25, limit: 100 });
    expect(applyReading(percent(), { usedPercent: 25, limit: 200 }, NOW).meter).toMatchObject({ used: 25, limit: 100 });
    expect(applyReading(percent(), { remainingPercent: 25, limit: 200 }, NOW).meter).toMatchObject({ used: 75, limit: 100 });
    expect(applyReading(percent(), { used: 62, limit: 100 }, NOW).meter).toMatchObject({ used: 62, limit: 100 });
  });

  it('can move the reset time without touching the amount or the reading time', () => {
    let meter = percent();
    meter = applyReading(meter, { usedPercent: 30 }, NOW - HOUR).meter;
    const moved = applyReading(meter, { resetsAt: iso(NOW + 2 * DAY + 3 * HOUR) }, NOW).meter;
    expect(moved.resetsAt).toBe(iso(NOW + 2 * DAY + 3 * HOUR));
    expect(moved.used).toBe(30);
    expect(moved.updatedAt).toBe(iso(NOW - HOUR));
    expect(moved.samples).toEqual(meter.samples);
  });

  describe('invalid readings', () => {
    // Scenario: Invalid reading.
    const cases: [string, Reading, string][] = [
      ['a negative amount used', { used: -1 }, 'used'],
      ['a negative amount remaining', { remaining: -5 }, 'remaining'],
      ['a percentage above 100', { usedPercent: 101 }, 'usedPercent'],
      ['a percentage below 0', { usedPercent: -0.5 }, 'usedPercent'],
      ['a remaining percentage above 100', { remainingPercent: 140 }, 'remainingPercent'],
      ['a remaining percentage below 0', { remainingPercent: -1 }, 'remainingPercent'],
      ['an amount that is not a number', { used: Number.NaN }, 'used'],
      ['an unparseable reset time', { usedPercent: 10, resetsAt: 'next tuesday-ish' }, 'resetsAt'],
      ['a reset time in the past', { usedPercent: 10, resetsAt: '2026-11-01T00:00:00Z' }, 'resetsAt'],
      ['an unparseable window start', { usedPercent: 10, windowStartedAt: 'yesterday' }, 'windowStartedAt'],
      ['a limit of zero', { used: 5, limit: 0 }, 'limit'],
      ['nothing at all', {}, 'used']
    ];

    it.each(cases)('rejects %s, naming the field, and leaves the meter unchanged', (_name, reading, field) => {
      const { state, account, meter } = one({ label: 'Premium requests', unit: 'requests', limit: 300, used: 12, reset: { kind: 'monthly', day: 1, time: '00:00', tz: 'UTC' } });
      const before = JSON.stringify(state);
      const error = expectReadingError(() => applyReadingToState(state, account.id, meter.id, reading, NOW), field);
      expect(error.message).toContain(field);
      expect(JSON.stringify(state)).toBe(before);
      expectReadingError(() => applyReading(meter, reading, NOW), field);
    });

    it('rejects more than one amount, naming the amount fields', () => {
      const { meter } = one({ label: 'Premium requests', unit: 'requests', limit: 300, reset: { kind: 'monthly', day: 1, time: '00:00', tz: 'UTC' } });
      let caught: unknown;
      try {
        applyReading(meter, { remaining: 100, usedPercent: 40 }, NOW);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ReadingError);
      expect((caught as ReadingError).message).toMatch(/remaining/);
      expect((caught as ReadingError).message).toMatch(/usedPercent/);
      expect(['used', 'remaining', 'usedPercent']).toContain((caught as ReadingError).field);
    });

    it('rejects a reading for a meter that does not exist', () => {
      const { state, account } = one({ label: 'Weekly', reset: WEEKLY });
      expectReadingError(() => applyReadingToState(state, account.id, 'test:nope', { usedPercent: 1 }, NOW), 'meter');
      expectReadingError(() => applyReadingToState(state, 'nope', 'test:weekly', { usedPercent: 1 }, NOW), 'meter');
    });
  });

  describe('readings that move the window', () => {
    it('closes the window ending on the 20th when the provider reports a reset on the 27th', () => {
      // Scenario: Provider reports a later reset.
      const { state, account, meter } = one(
        { label: 'Weekly', reset: WEEKLY, resetsAt: '2026-11-20T00:00:00Z' },
        utc(2026, 11, 14),
        { price: { amount: 100, currency: 'USD', period: 'month' } }
      );
      const read = applyReadingToState(state, account.id, meter.id, { usedPercent: 55 }, utc(2026, 11, 19, 6, 0));
      expect(read.cycles).toHaveLength(0);

      const next = applyReadingToState(read, account.id, meter.id, { usedPercent: 4, resetsAt: '2026-11-27T00:00:00Z' }, NOW);
      expect(next.cycles).toHaveLength(1);
      expect(next.cycles[0]).toMatchObject({
        meterId: meter.id,
        accountId: account.id,
        startedAt: '2026-11-13T00:00:00.000Z',
        // The 20th has not come yet. The window ended early, when the reading found the next one running.
        endedAt: iso(NOW),
        limit: 100,
        used: 55,
        confidence: 'measured',
        currency: 'USD'
      });
      expect(next.cycles[0]?.wastedFraction).toBeCloseTo(0.45, 12);
      const continued = (next.accounts[0] as Account).meters[0] as Meter;
      expect(continued).toMatchObject({
        windowStartedAt: '2026-11-20T00:00:00.000Z',
        resetsAt: '2026-11-27T00:00:00.000Z',
        used: 4,
        estimated: false,
        samples: [{ t: iso(NOW), used: 4 }]
      });
    });

    it('treats a reset exactly half a window later as a new window', () => {
      const { meter } = one({ label: 'Weekly', reset: WEEKLY, used: 30, resetsAt: '2026-11-20T00:00:00Z' });
      const halfLater = utc(2026, 11, 20) + WEEK / 2;
      const moved = applyReading(meter, { usedPercent: 5, resetsAt: iso(halfLater) }, NOW);
      // The new window began a week before its end, which is where the old one stopped.
      expect(moved.closed).toMatchObject({ endedAt: iso(halfLater - WEEK), used: 30 });
      expect(moved.meter.samples).toHaveLength(1);
      expect(moved.meter.windowStartedAt).toBe(iso(halfLater - WEEK));
    });

    it('corrects the reset time and keeps the samples when the difference is under half a window', () => {
      // Scenario: Small correction to the reset time.
      let meter = one({ label: 'Weekly', reset: WEEKLY, resetsAt: '2026-11-20T00:00:00Z' }, utc(2026, 11, 14)).meter;
      meter = applyReading(meter, { usedPercent: 20 }, utc(2026, 11, 15)).meter;
      meter = applyReading(meter, { usedPercent: 35 }, utc(2026, 11, 17)).meter;
      const corrected = applyReading(meter, { usedPercent: 50, resetsAt: '2026-11-20T05:00:00Z' }, NOW);
      expect(corrected.closed).toBeNull();
      expect(corrected.meter.resetsAt).toBe('2026-11-20T05:00:00.000Z');
      expect(corrected.meter.windowStartedAt).toBe('2026-11-13T05:00:00.000Z');
      expect(corrected.meter.samples.map((sample) => sample.used)).toEqual([20, 35, 50]);

    });

    it('still calls it a correction just under half a window away, in either direction', () => {
      let meter = one({ label: 'Weekly', reset: WEEKLY, resetsAt: '2026-11-24T00:00:00Z' }, utc(2026, 11, 17, 6, 0)).meter;
      meter = applyReading(meter, { usedPercent: 20 }, utc(2026, 11, 18)).meter;
      const almost = WEEK / 2 - MINUTE;
      for (const shift of [almost, -almost]) {
        const moved = utc(2026, 11, 24) + shift;
        const again = applyReading(meter, { usedPercent: 30, resetsAt: iso(moved) }, NOW);
        expect(again.closed).toBeNull();
        expect(again.meter.resetsAt).toBe(iso(moved));
        expect(again.meter.samples.map((sample) => sample.used)).toEqual([20, 30]);
      }
    });

    it('keeps a month-long window when a monthly meter is given its exact reset time', () => {
      // Suno really resets at 14:37 on the 12th; the rule only knows "the 12th".
      const { meter } = one(
        { label: 'Monthly credits', unit: 'credits', limit: 2500, used: 300, reset: { kind: 'monthly', day: 12, time: '00:00', tz: 'UTC' } },
        NOW - 2 * DAY
      );
      const { meter: corrected, closed } = applyReading(meter, { remaining: 1200, resetsAt: '2026-12-12T14:37:00Z' }, NOW);
      expect(closed).toBeNull();
      expect(corrected.resetsAt).toBe('2026-12-12T14:37:00.000Z');
      // The rule learns the time of day, so this window and every later one run 14:37 to 14:37.
      expect(corrected.reset).toEqual({ kind: 'monthly', day: 12, time: '14:37', tz: 'UTC' });
      expect(corrected.windowStartedAt).toBe('2026-11-12T14:37:00.000Z');
      expect(corrected.samples.map((sample) => sample.used)).toEqual([300, 1300]);
      // The window is still a month long and already a quarter gone, not a few hours long and unstarted.
      expect(windowLengthMs(corrected) as number).toBeGreaterThanOrEqual(30 * DAY);
      expect(Date.parse(corrected.windowStartedAt as string)).toBeLessThan(NOW);
    });

    it('keeps the usage when the provider reports an earlier reset than the one stored', () => {
      const { meter } = one({ label: 'Weekly', reset: WEEKLY, used: 30, resetsAt: '2026-11-25T00:00:00Z' });
      const moved = applyReading(meter, { resetsAt: '2026-11-20T00:00:00Z' }, NOW);
      expect(moved.closed).toBeNull();
      expect(moved.meter).toMatchObject({ used: 30, resetsAt: '2026-11-20T00:00:00.000Z', windowStartedAt: '2026-11-13T00:00:00.000Z' });
    });

    it('rolls a passed window first, so a reading after the reset lands in the new window', () => {
      const { meter } = one({ label: 'Weekly', reset: WEEKLY, used: 70, resetsAt: '2026-11-20T00:00:00Z' });
      const after = utc(2026, 11, 20, 8, 0);
      const { meter: next, closed } = applyReading(meter, { usedPercent: 3, resetsAt: '2026-11-27T00:00:00Z' }, after);
      expect(closed).toMatchObject({ endedAt: '2026-11-20T00:00:00.000Z', used: 70 });
      expect(next).toMatchObject({ used: 3, resetsAt: '2026-11-27T00:00:00.000Z', windowStartedAt: '2026-11-20T00:00:00.000Z', estimated: false });
    });

    it('starts a rolling window at the reading and ends it one window length later', () => {
      // Scenario: First use of a rolling window.
      const { meter } = one({ label: 'Session', role: 'throttle', reset: { kind: 'rolling', hours: 5 } });
      expect(meter.resetsAt).toBeNull();
      const { meter: started, closed } = applyReading(meter, { usedPercent: 10 }, NOW);
      expect(closed).toBeNull();
      expect(started).toMatchObject({ used: 10, windowStartedAt: iso(NOW), resetsAt: iso(NOW + 5 * HOUR) });
    });

    it('ends a rolling window at the reading\'s own reset time when it has one', () => {
      const { meter } = one({ label: 'Session', role: 'throttle', reset: { kind: 'rolling', hours: 5 } });
      const { meter: started } = applyReading(meter, { usedPercent: 10, resetsAt: iso(NOW + 3 * HOUR) }, NOW);
      expect(started.resetsAt).toBe(iso(NOW + 3 * HOUR));
      expect(started.windowStartedAt).toBe(iso(NOW - 2 * HOUR));
    });

    it('does not start a rolling window on a reading that shows no use', () => {
      const { meter } = one({ label: 'Session', role: 'throttle', reset: { kind: 'rolling', hours: 5 } });
      const { meter: still } = applyReading(meter, { usedPercent: 0 }, NOW);
      expect(still.resetsAt).toBeNull();
      expect(still.updatedAt).toBe(iso(NOW));
    });

    it('starts a new rolling window on the first reading after the previous one ended', () => {
      let meter = one({ label: 'Session', role: 'throttle', reset: { kind: 'rolling', hours: 5 } }).meter;
      meter = applyReading(meter, { usedPercent: 90 }, NOW).meter;
      const later = NOW + 8 * HOUR;
      const again = applyReading(meter, { usedPercent: 5 }, later).meter;
      expect(again).toMatchObject({ used: 5, windowStartedAt: iso(later), resetsAt: iso(later + 5 * HOUR), estimated: false });
      expect(again.samples).toEqual([{ t: iso(later), used: 5 }]);
    });

    it('gives an interval meter its missing anchor from a reading', () => {
      const { meter } = one({ label: 'Weekly', reset: WEEKLY });
      const { meter: anchored } = applyReading(meter, { usedPercent: 10, resetsAt: '2026-11-23T09:00:00Z' }, NOW);
      expect(anchored.resetsAt).toBe('2026-11-23T09:00:00.000Z');
      expect(anchored.windowStartedAt).toBe('2026-11-16T09:00:00.000Z');
    });

    it('remembers when tracking of a one-off expiry began', () => {
      const { meter } = one({ label: 'Credit pack', unit: 'credits', limit: 1000, reset: { kind: 'once' } });
      const { meter: tracked } = applyReading(meter, { remaining: 900, resetsAt: iso(NOW + 30 * DAY) }, NOW);
      expect(tracked).toMatchObject({ used: 100, resetsAt: iso(NOW + 30 * DAY), windowStartedAt: iso(NOW), expired: false });
    });

    it('honours an explicit window start', () => {
      const { meter } = one({ label: 'Weekly', reset: WEEKLY });
      const { meter: next } = applyReading(
        meter,
        { usedPercent: 10, resetsAt: '2026-11-23T09:00:00Z', windowStartedAt: '2026-11-17T09:00:00Z' },
        NOW
      );
      expect(next.windowStartedAt).toBe('2026-11-17T09:00:00.000Z');
      expect(windowLengthMs(next)).toBe(6 * DAY);
    });
  });
});

describe('rollState', () => {
  function fixture(): State {
    let state = emptyState();
    state = addAccount(
      state,
      {
        label: 'Claude Max',
        providerId: 'claude',
        price: { amount: 100, currency: 'USD', period: 'month' },
        meters: [
          { label: 'Weekly', reset: WEEKLY, used: 70, resetsAt: iso(NOW + DAY) },
          { label: 'Session', role: 'throttle', reset: { kind: 'rolling', hours: 5 }, used: 100, resetsAt: iso(NOW + HOUR) }
        ]
      },
      NOW
    ).state;
    state = addAccount(
      state,
      { label: 'Copilot', meters: [{ label: 'Premium requests', unit: 'requests', limit: 300, used: 90, reset: { kind: 'monthly', day: 1, time: '00:00', tz: 'UTC' } }] },
      NOW
    ).state;
    state = addAccount(
      state,
      { label: 'Credit pack', meters: [{ label: 'Credits', unit: 'credits', limit: 1000, used: 250, reset: { kind: 'once' }, resetsAt: iso(NOW + 2 * DAY) }] },
      NOW
    ).state;
    return state;
  }

  it('returns the same object while nothing is due', () => {
    const state = fixture();
    expect(rollState(state, NOW)).toBe(state);
    expect(rollState(state, NOW + 30 * MINUTE)).toBe(state);
  });

  it('is idempotent: rolling twice to the same instant changes nothing more', () => {
    const state = fixture();
    const later = utc(2026, 12, 20);
    const once = rollState(state, later);
    expect(once).not.toBe(state);
    expect(once.cycles).toHaveLength(3); // weekly, monthly, one-off; the throttle is not recorded
    const twice = rollState(once, later);
    expect(twice).toBe(once);
    expect(JSON.stringify(rollState(JSON.parse(JSON.stringify(once)) as State, later))).toBe(JSON.stringify(once));
  });

  it('gives the same result in one step as in many', () => {
    const state = fixture();
    const later = utc(2026, 12, 20);
    let stepped = state;
    for (let at = NOW; at <= later; at += 6 * HOUR) stepped = rollState(stepped, at);
    stepped = rollState(stepped, later);
    const direct = rollState(state, later);
    expect(stepped.accounts).toEqual(direct.accounts);
    expect(stepped.cycles.map((cycle) => [cycle.meterId, cycle.endedAt, cycle.used])).toEqual(
      direct.cycles.map((cycle) => [cycle.meterId, cycle.endedAt, cycle.used])
    );
  });

  it('records a window once when two processes roll the same stale state', () => {
    const state = fixture();
    const later = NOW + 2 * DAY + HOUR;
    const first = rollState(state, later);
    // A second process still holds the unrolled meters but reads the cycles the first one saved.
    const second = rollState({ ...state, cycles: first.cycles }, later + MINUTE);
    expect(second.cycles).toHaveLength(first.cycles.length);
    expect(new Set(second.cycles.map((cycle) => `${cycle.meterId}|${cycle.endedAt}`)).size).toBe(second.cycles.length);
  });

  it('does not mutate its input', () => {
    const state = fixture();
    const before = JSON.stringify(state);
    rollState(state, utc(2027, 3, 1));
    expect(JSON.stringify(state)).toBe(before);
  });

  it('keeps cycles sorted by the time they ended', () => {
    const rolled = rollState(fixture(), utc(2026, 12, 20));
    const ends = rolled.cycles.map((cycle) => cycle.endedAt);
    expect(ends).toEqual(ends.slice().sort());
  });
});

describe('numbers that would not survive being stored', () => {
  it('refuses a reading whose amount overflows once it is scaled to the meter', () => {
    const { state, account, meter } = one({ label: 'Weekly', reset: WEEKLY });
    // 1e12 out of 1e-6 on a percent meter is 1e20 percent: each input is in range, the result is not.
    expectReadingError(() => applyReadingToState(state, account.id, meter.id, { used: 1e12, limit: 1e-6 }, NOW), 'used');
    // The reviewer's case: a limit that small is refused before anything is divided by it.
    expectReadingError(() => applyReadingToState(state, account.id, meter.id, { used: 1e308, limit: 1e-300 }, NOW), 'limit');
    expectReadingError(() => applyReadingToState(state, account.id, meter.id, { used: 5, limit: 1e308 }, NOW), 'limit');
    expectReadingError(() => applyReadingToState(state, account.id, meter.id, { used: Number.POSITIVE_INFINITY }, NOW), 'used');
    expectReadingError(() => applyReadingToState(state, account.id, meter.id, { remaining: Number.NaN }, NOW), 'remaining');
    const counted = one({ label: 'Credits', unit: 'credits', limit: 1000, reset: WEEKLY });
    expectReadingError(() => applyReadingToState(counted.state, counted.account.id, counted.meter.id, { usedPercent: 100, limit: 1e308 }, NOW), 'limit');
  });

  it('refuses a reset time that is not an ISO 8601 date and time, or is outside any sensible range', () => {
    const { state, account, meter } = one({ label: 'Weekly', reset: WEEKLY });
    for (const bad of ['1', 'next friday', '275760-09-13T00:00:00Z', '0001-01-01T00:00:00Z']) {
      expectReadingError(() => applyReadingToState(state, account.id, meter.id, { usedPercent: 10, resetsAt: bad }, NOW), 'resetsAt');
    }
    expectReadingError(() => applyReadingToState(state, account.id, meter.id, { usedPercent: 10, windowStartedAt: '7' }, NOW), 'windowStartedAt');
  });

  it('does not let a window of no length in a stored file take every read down', () => {
    // Validation refuses this rule now. A file written before that, or edited by hand, may still hold it.
    const { state, meter } = one({ label: 'Tiny', reset: { kind: 'interval', hours: 1 }, resetsAt: iso(NOW + HOUR) });
    const broken: State = {
      ...state,
      accounts: state.accounts.map((account) => ({
        ...account,
        meters: account.meters.map((entry) => (entry.id === meter.id ? { ...entry, reset: { kind: 'interval' as const, hours: 1e-320 } } : entry))
      }))
    };
    const rolled = rollState(broken, NOW + 2 * HOUR);
    const after = rolled.accounts[0]?.meters[0] as Meter;
    expect(after.resetsAt).toBeNull();
    expect(JSON.parse(JSON.stringify(rolled))).toEqual(rolled);
  });
});

describe('a reading that moves the reset (review findings)', () => {
  const price = { price: { amount: 100, currency: 'USD', period: 'month' as const } };
  const weeklyAt = (resetsAt: string, createdAt: number): { state: State; account: Account; meter: Meter } =>
    one({ label: 'Weekly', reset: WEEKLY, resetsAt }, createdAt, price);
  const only = (state: State): Meter => (state.accounts[0] as Account).meters[0] as Meter;

  it('takes a later date on its own as a corrected date: usage stays, nothing is recorded', () => {
    const { state, account, meter } = weeklyAt('2026-11-21T10:00:00Z', utc(2026, 11, 15));
    const read = applyReadingToState(state, account.id, meter.id, { usedPercent: 62 }, utc(2026, 11, 18));
    const corrected = applyReadingToState(read, account.id, meter.id, { resetsAt: '2026-11-25T10:00:00Z' }, NOW);
    expect(corrected.cycles).toEqual([]);
    expect(only(corrected)).toMatchObject({
      used: 62,
      estimated: false,
      resetsAt: '2026-11-25T10:00:00.000Z',
      windowStartedAt: '2026-11-18T10:00:00.000Z',
      updatedAt: iso(utc(2026, 11, 18))
    });
    expect(only(corrected).samples).toHaveLength(1);
    // When that window ends with nothing typed since the 18th, a real, measured-then-stale figure is closed once.
    const later = rollState(corrected, utc(2026, 11, 25, 11, 0));
    expect(later.cycles).toHaveLength(1);
    expect(later.cycles[0]).toMatchObject({ used: 62, endedAt: '2026-11-25T10:00:00.000Z' });
  });

  it('takes a later date with the same usage or more as the same window', () => {
    const { state, account, meter } = weeklyAt('2026-11-21T10:00:00Z', utc(2026, 11, 15));
    const read = applyReadingToState(state, account.id, meter.id, { usedPercent: 62 }, utc(2026, 11, 18));
    const same = applyReadingToState(read, account.id, meter.id, { usedPercent: 70, resetsAt: '2026-11-25T10:00:00Z' }, NOW);
    expect(same.cycles).toEqual([]);
    expect(only(same)).toMatchObject({ used: 70, resetsAt: '2026-11-25T10:00:00.000Z' });
    expect(only(same).samples.map((sample) => sample.used)).toEqual([62, 70]);
  });

  it('takes a later date with less usage as a new window, and closes the old one no later than now', () => {
    const { state, account, meter } = weeklyAt('2026-11-21T10:00:00Z', utc(2026, 11, 15));
    const read = applyReadingToState(state, account.id, meter.id, { usedPercent: 62 }, utc(2026, 11, 18));
    const restarted = applyReadingToState(read, account.id, meter.id, { usedPercent: 4, resetsAt: '2026-11-26T08:00:00Z' }, NOW);
    expect(restarted.cycles).toHaveLength(1);
    // A week before the 26th at 08:00 is the 19th at 08:00, two hours before now.
    expect(restarted.cycles[0]).toMatchObject({ used: 62, endedAt: '2026-11-19T08:00:00.000Z', confidence: 'measured' });
    expect(Date.parse(restarted.cycles[0]?.endedAt ?? '')).toBeLessThanOrEqual(NOW);
    expect(only(restarted)).toMatchObject({ used: 4, estimated: false, windowStartedAt: '2026-11-19T08:00:00.000Z' });
  });

  it('extends or shortens a one-off expiry without ever closing it', () => {
    const { state, account, meter } = one({ label: 'Prepaid credits', unit: 'usd', limit: 50, reset: { kind: 'once' } }, utc(2026, 11, 1));
    let next = applyReadingToState(state, account.id, meter.id, { used: 10, resetsAt: '2026-12-19T00:00:00Z' }, utc(2026, 11, 2));
    const started = only(next).windowStartedAt;
    expect(started).toBe(iso(utc(2026, 11, 2)));
    // A top-up pushes the expiry out by a year; a typo fix pulls it back. Less "used" changes nothing either.
    for (const reading of [
      { used: 12, resetsAt: '2027-11-19T00:00:00Z' },
      { used: 12, resetsAt: '2026-12-01T00:00:00Z' },
      { used: 3, resetsAt: '2027-06-01T00:00:00Z' },
      { resetsAt: '2027-11-19T00:00:00Z' }
    ]) {
      next = applyReadingToState(next, account.id, meter.id, reading, NOW);
      expect(next.cycles, JSON.stringify(reading)).toEqual([]);
      expect(only(next)).toMatchObject({ expired: false, windowStartedAt: started, resetsAt: new Date(reading.resetsAt).toISOString() });
    }
    expect(only(next).used).toBe(3);
  });

  it('takes back a finished window that a too-early reset time wrote, once the real reset is known', () => {
    // Typed as Wednesday 12:00; the real reset is Thursday 09:00.
    const { state, account, meter } = weeklyAt('2026-11-18T12:00:00Z', utc(2026, 11, 12));
    const read = applyReadingToState(state, account.id, meter.id, { usedPercent: 62 }, utc(2026, 11, 17));
    const rolled = rollState(read, utc(2026, 11, 18, 12, 30));
    expect(rolled.cycles).toHaveLength(1);
    expect(only(rolled)).toMatchObject({ used: 0, estimated: true });

    const corrected = applyReadingToState(rolled, account.id, meter.id, { usedPercent: 70, resetsAt: '2026-11-19T09:00:00Z' }, utc(2026, 11, 18, 13, 0));
    expect(corrected.cycles).toEqual([]);
    expect(only(corrected)).toMatchObject({ used: 70, estimated: false, windowStartedAt: '2026-11-12T09:00:00.000Z', resetsAt: '2026-11-19T09:00:00.000Z' });

    const ended = rollState(corrected, utc(2026, 11, 19, 9, 30));
    expect(ended.cycles).toHaveLength(1);
    expect(ended.cycles[0]).toMatchObject({ used: 70, startedAt: '2026-11-12T09:00:00.000Z', endedAt: '2026-11-19T09:00:00.000Z' });
  });

  it('gives the usage back when only the date is corrected after such a roll', () => {
    const { state, account, meter } = weeklyAt('2026-11-18T12:00:00Z', utc(2026, 11, 12));
    const read = applyReadingToState(state, account.id, meter.id, { usedPercent: 62 }, utc(2026, 11, 17));
    const rolled = rollState(read, utc(2026, 11, 18, 12, 30));
    const corrected = applyReadingToState(rolled, account.id, meter.id, { resetsAt: '2026-11-19T09:00:00Z' }, utc(2026, 11, 18, 13, 0));
    expect(corrected.cycles).toEqual([]);
    expect(only(corrected)).toMatchObject({ used: 62, estimated: false, resetsAt: '2026-11-19T09:00:00.000Z' });
  });

  it('does the same when the roll and the correction happen in one call', () => {
    const { state, account, meter } = weeklyAt('2026-11-18T12:00:00Z', utc(2026, 11, 12));
    const read = applyReadingToState(state, account.id, meter.id, { usedPercent: 62 }, utc(2026, 11, 17));
    // Nothing looked at the state between the wrong reset passing and the correction.
    const corrected = applyReadingToState(read, account.id, meter.id, { usedPercent: 70, resetsAt: '2026-11-19T09:00:00Z' }, utc(2026, 11, 18, 13, 0));
    expect(corrected.cycles).toEqual([]);
    expect(only(corrected)).toMatchObject({ used: 70, windowStartedAt: '2026-11-12T09:00:00.000Z' });
  });

  it('turns a balance that is given an expiry into a one-off expiry, with a forecast and one honest ledger entry', () => {
    const { state, account, meter } = one({ label: 'Credit balance', unit: 'usd', limit: 20, reset: { kind: 'none' } }, utc(2026, 11, 10));
    const read = applyReadingToState(state, account.id, meter.id, { used: 6, resetsAt: iso(NOW + 3 * DAY) }, NOW);
    expect(only(read).reset).toEqual({ kind: 'once' });
    expect(only(read)).toMatchObject({ windowStartedAt: iso(NOW), resetsAt: iso(NOW + 3 * DAY), expired: false });
    const view = viewMeter(read.accounts[0] as Account, only(read), NOW + 2 * DAY);
    expect(view.tier).not.toBe('balance');
    expect(view.msLeft).toBe(DAY);

    const after = rollState(read, NOW + 3 * DAY + HOUR);
    expect(only(after).expired).toBe(true);
    expect(after.cycles).toHaveLength(1);
    expect(after.cycles[0]).toMatchObject({ used: 6, limit: 20 });
    expect(viewMeter(after.accounts[0] as Account, only(after), NOW + 4 * DAY).tier).toBe('expired');
  });

  it('records nothing for a balance that a file still holds with a reset time on it', () => {
    const { state } = one({ label: 'Credit balance', unit: 'usd', limit: 20, used: 6, reset: { kind: 'none' } }, utc(2026, 11, 10));
    const leftover: State = {
      ...state,
      accounts: state.accounts.map((account) => ({ ...account, meters: account.meters.map((meter) => ({ ...meter, resetsAt: iso(NOW - HOUR) })) }))
    };
    const rolled = rollState(leftover, NOW);
    expect(rolled.cycles).toEqual([]);
    expect(only(rolled)).toMatchObject({ resetsAt: null, used: 6, expired: false });
  });
});
