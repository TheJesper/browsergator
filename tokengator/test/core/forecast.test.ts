import { describe, expect, it } from 'vitest';

import { addAccount, updateAccount, type AccountInput, type MeterInput } from '../../src/core/accounts.js';
import {
  PACE_PRIOR,
  SORT_ORDERS,
  TIER_ORDER,
  allowanceQueue,
  horizonFor,
  projectUse,
  sortViews,
  summarise,
  viewAccount,
  viewMeter,
  viewState,
  type MeterView,
  type Tier
} from '../../src/core/forecast.js';
import { formatMoneyTotals } from '../../src/core/format.js';
import { applyReadingToState, rollState } from '../../src/core/reset.js';
import { DAY, HOUR, MINUTE, MONTH, iso } from '../../src/core/time.js';
import { emptyState, type Account, type Price, type State } from '../../src/core/types.js';
import { explain, recommend, statusLine } from '../../src/core/wording.js';

const utc = (y: number, mo: number, d: number, h = 0, mi = 0): number => Date.UTC(y, mo - 1, d, h, mi, 0);
/** Thursday 19 November 2026, 10:00 UTC. */
const NOW = utc(2026, 11, 19, 10, 0);
const WEEK = 7 * DAY;
const USD_100: Price = { amount: 100, currency: 'USD', period: 'month' };
/** What one week of a 100-a-month plan is worth: 100 x 7 / 30.436875. */
const WEEK_OF_100 = (100 * WEEK) / MONTH;

/** An interval meter that is `elapsed` (0..1) through a window of `hours`, with `usedPercent` of it used. */
function windowed(hours: number, elapsed: number, usedPercent: number, extra: Partial<MeterInput> = {}): MeterInput {
  const length = hours * HOUR;
  return {
    label: 'Weekly',
    reset: { kind: 'interval', hours },
    used: usedPercent,
    resetsAt: iso(NOW + Math.round((1 - elapsed) * length)),
    ...extra
  };
}

const weekly = (elapsed: number, usedPercent: number, extra: Partial<MeterInput> = {}): MeterInput =>
  windowed(168, elapsed, usedPercent, extra);

/** A weekly meter that resets in `hours` from now. */
const weeklyResettingIn = (hours: number, usedPercent: number, extra: Partial<MeterInput> = {}): MeterInput =>
  weekly(1 - hours / 168, usedPercent, extra);

function add(state: State, label: string, meters: MeterInput[], extra: Partial<AccountInput> = {}, nowMs = NOW): State {
  return addAccount(state, { label, meters, ...extra }, nowMs).state;
}

function views(meters: MeterInput[], extra: Partial<AccountInput> = {}, nowMs = NOW): MeterView[] {
  const state = add(emptyState(), 'Claude Max', meters, extra);
  return viewAccount(state.accounts[0] as Account, nowMs);
}

function view(meter: MeterInput, extra: Partial<AccountInput> = {}, nowMs = NOW): MeterView {
  return views([meter], extra, nowMs)[0] as MeterView;
}

/** The D4 formula, written out independently of the implementation. */
function d4Projected(u: number, e: number): number {
  const k = 0.05;
  const rate = (u + k) / (e + k);
  return Math.min(1, u + (1 - e) * rate);
}

describe('projectUse', () => {
  it('uses a prior of 5% of a window', () => {
    expect(PACE_PRIOR).toBe(0.05);
  });

  it('projects 55-60% unused when half the window has passed with 20% used', () => {
    // Scenario: Behind pace halfway through.
    const unused = 1 - projectUse(0.2, 0.5);
    expect(unused).toBeGreaterThanOrEqual(0.55);
    expect(unused).toBeLessThanOrEqual(0.6);
    expect(unused).toBeCloseTo(1 - (0.2 + 0.5 * (0.25 / 0.55)), 12);
  });

  it('projects under 20% unused when 1% has passed and nothing is used', () => {
    // Scenario: Window just started.
    const unused = 1 - projectUse(0, 0.01);
    expect(unused).toBeLessThan(0.2);
    expect(unused).toBeCloseTo(0.175, 12);
  });

  it('projects nothing unused when half the window has passed with 80% used', () => {
    // Scenario: Ahead of pace.
    expect(1 - projectUse(0.8, 0.5)).toBe(0);
  });

  it('predicts full use at the very start of a window', () => {
    expect(projectUse(0, 0)).toBe(1);
    expect(projectUse(0.3, 0)).toBe(1);
  });

  it('is exactly what is used once the window is over', () => {
    expect(projectUse(0.37, 1)).toBeCloseTo(0.37, 12);
    expect(projectUse(0, 1)).toBe(0);
  });

  it('matches the D4 formula across the whole range', () => {
    for (let u = 0; u <= 1.0001; u += 0.05) {
      for (let e = 0; e <= 1.0001; e += 0.05) {
        expect(projectUse(u, e)).toBeCloseTo(d4Projected(Math.min(u, 1), Math.min(e, 1)), 10);
      }
    }
  });

  it('stays within 0..1 for out-of-range input and never projects less than is already used', () => {
    expect(projectUse(1.4, 0.5)).toBe(1);
    expect(projectUse(-0.2, 0.5)).toBeCloseTo(d4Projected(0, 0.5), 12);
    expect(projectUse(0.2, 1.7)).toBeCloseTo(0.2, 12);
    for (const e of [0, 0.1, 0.5, 0.9, 1]) {
      let previous = -1;
      for (let u = 0; u <= 1.0001; u += 0.1) {
        const projected = projectUse(u, e);
        expect(projected).toBeGreaterThanOrEqual(Math.min(u, 1) - 1e-12);
        expect(projected).toBeGreaterThanOrEqual(previous);
        previous = projected;
      }
    }
  });

  it('has almost no prior left by mid-window', () => {
    // On pace at the halfway point projects full use; the naive u/e would say the same.
    expect(projectUse(0.5, 0.5)).toBeCloseTo(1, 12);
    expect(Math.abs(projectUse(0.3, 0.5) - 0.3 / 0.5)).toBeLessThan(0.05);
  });
});

describe('horizonFor', () => {
  it('is about 25 hours for a 7-day window', () => {
    // Scenario: Weekly window.
    expect(horizonFor(WEEK)).toBeCloseTo(25.2 * HOUR, 3);
  });

  it('is 72 hours for a 30-day window', () => {
    // Scenario: Monthly window.
    expect(horizonFor(30 * DAY)).toBe(72 * HOUR);
  });

  it('is 15% of the window between the bounds, never under 2 hours or over 72', () => {
    expect(horizonFor(5 * HOUR)).toBe(2 * HOUR);
    expect(horizonFor(DAY)).toBeCloseTo(3.6 * HOUR, 3);
    expect(horizonFor(10 * DAY)).toBeCloseTo(36 * HOUR, 3);
    expect(horizonFor(365 * DAY)).toBe(72 * HOUR);
    expect(horizonFor(HOUR)).toBe(2 * HOUR);
  });

  it('is exposed on the view of a meter', () => {
    expect(view(weekly(0.5, 50)).horizonMs).toBeCloseTo(25.2 * HOUR, 3);
    expect(view(windowed(5, 0.5, 50)).horizonMs).toBe(2 * HOUR);
  });
});

describe('viewMeter basics', () => {
  it('derives the shares of the limit and of the window', () => {
    const v = view(weekly(0.25, 40));
    expect(v.usedFraction).toBe(0.4);
    expect(v.remainingFraction).toBeCloseTo(0.6, 12);
    expect(v.remaining).toBe(60);
    expect(v.elapsedFraction).toBeCloseTo(0.25, 6);
    expect(v.windowMs).toBe(WEEK);
    expect(v.msLeft).toBe(0.75 * WEEK);
    expect(v.projectedFraction).toBeCloseTo(d4Projected(0.4, 0.25), 6);
    expect(v.projectedUnused).toBeCloseTo(1 - d4Projected(0.4, 0.25), 6);
    expect(v.throttle).toBeNull();
    expect(v.id).toBe(v.meter.id);
  });

  it('never stores what it derives', () => {
    const state = add(emptyState(), 'Claude Max', [weekly(0.5, 20)], { price: USD_100 });
    const before = JSON.stringify(state);
    viewState(state, NOW);
    summarise(state, NOW);
    allowanceQueue(state, NOW);
    expect(JSON.stringify(state)).toBe(before);
    const meter = (state.accounts[0] as Account).meters[0] as object;
    for (const derived of ['tier', 'projectedUnused', 'valueAtRisk', 'stale', 'headline']) {
      expect(meter).not.toHaveProperty(derived);
    }
  });
});

describe('urgency tiers', () => {
  it('use-now: a weekly meter with 38% left that resets in 14 hours', () => {
    // Scenario: Weekly meter on its last day.
    const v = view(weeklyResettingIn(14, 62));
    expect(v.msLeft).toBe(14 * HOUR);
    expect(v.remainingFraction).toBeCloseTo(0.38, 12);
    expect(v.tier).toBe('use-now');
  });

  it('on-pace: a weekly meter with 12% left that resets in 20 hours after even use', () => {
    // Scenario: Last day but on pace.
    const v = view(weeklyResettingIn(20, 88));
    expect(v.msLeft).toBeLessThan(v.horizonMs as number);
    expect(v.projectedUnused).toBeLessThan(0.05);
    expect(v.tier).toBe('on-pace');
  });

  it('behind: a monthly meter half-way through its window with 20% used', () => {
    // Scenario: Monthly meter mid-cycle and behind.
    const halfway = utc(2026, 11, 16); // November has 30 days
    const state = add(
      emptyState(),
      'Copilot',
      [{ label: 'Premium requests', unit: 'requests', limit: 300, used: 60, reset: { kind: 'monthly', day: 1, time: '00:00', tz: 'UTC' } }],
      {},
      halfway
    );
    const v = viewState(state, halfway)[0] as MeterView;
    expect(v.elapsedFraction).toBeCloseTo(0.5, 12);
    expect(v.usedFraction).toBe(0.2);
    expect(v.tier).toBe('behind');
    expect(v.projectedUnused).toBeGreaterThanOrEqual(0.55);
    expect(v.projectedUnused).toBeLessThanOrEqual(0.6);
  });

  it('spent: 99% used with two days to the reset, and no value at risk', () => {
    // Scenario: Fully used is a success state.
    const state = add(emptyState(), 'Claude Max', [weeklyResettingIn(48, 99)], { price: USD_100 });
    const v = viewState(state, NOW)[0] as MeterView;
    expect(v.tier).toBe('spent');
    expect(v.valueAtRisk ?? 0).toBe(0);
    expect(summarise(state, NOW).atRisk).toEqual({});
    expect(statusLine(v, NOW)).not.toMatch(/at risk/);
  });

  it('hot: 30% of the window gone with 75% used, with the time it runs out', () => {
    // Scenario: Burning too fast.
    const v = view(weekly(0.3, 75));
    expect(v.tier).toBe('hot');
    // 75% in 30% of a window means 100% at 40% of the window.
    expect(v.runsOutAtMs).not.toBeNull();
    expect(v.runsOutAtMs as number).toBeCloseTo((v.windowStartMs as number) + 0.4 * WEEK, -1);
    expect(v.runsOutAtMs as number).toBeGreaterThan(NOW);
    expect(v.runsOutAtMs as number).toBeLessThan(v.resetsAtMs as number);
    expect(v.projectedUnused).toBe(0);
  });

  it('fresh: under 5% of the window has passed', () => {
    const v = view(weekly(0.02, 0));
    expect(v.tier).toBe('fresh');
    expect(view(weekly(0.049, 0)).tier).toBe('fresh');
    expect(view(weekly(0.06, 0)).tier).toBe('behind');
  });

  it('idle: a rolling window that has not started is not wasting anything', () => {
    // Scenario: Rolling window is idle until used.
    const state = add(emptyState(), 'Claude Max', [{ label: 'Five hours', reset: { kind: 'rolling', hours: 5 } }], { price: USD_100 });
    const v = viewState(state, NOW)[0] as MeterView;
    expect(v.meter.resetsAt).toBeNull();
    expect(v.resetsAtMs).toBeNull();
    expect(v.msLeft).toBeNull();
    expect(v.tier).toBe('idle');
    expect(v.projectedUnused).toBe(0);
    expect(v.valueAtRisk ?? 0).toBe(0);
    expect(v.needsReset).toBe(false);
    expect(summarise(state, NOW).atRisk).toEqual({});
  });

  it('idle: an interval meter whose reset time is not known yet is flagged as needing it', () => {
    // Scenario: Reset anchor still needed.
    let state = add(emptyState(), 'ChatGPT Plus', [{ label: 'Weekly', reset: { kind: 'interval', hours: 168 } }]);
    let v = viewState(state, NOW)[0] as MeterView;
    expect(v.tier).toBe('idle');
    expect(v.needsReset).toBe(true);

    // A reading that carries the reset time settles it.
    const account = state.accounts[0] as Account;
    state = applyReadingToState(state, account.id, v.meter.id, { usedPercent: 20, resetsAt: iso(NOW + 3 * DAY) }, NOW);
    v = viewState(state, NOW)[0] as MeterView;
    expect(v.needsReset).toBe(false);
    expect(v.tier).not.toBe('idle');
    expect(v.msLeft).toBe(3 * DAY);
  });

  it('idle: a one-off expiry that has not been given is flagged too', () => {
    const v = view({ label: 'Credit pack', unit: 'credits', limit: 1000, reset: { kind: 'once' } });
    expect(v.tier).toBe('idle');
    expect(v.needsReset).toBe(true);
  });

  it('balance: no clock', () => {
    const v = view({ label: 'Balance', unit: 'credits', limit: 500, used: 100, reset: { kind: 'none' } });
    expect(v.tier).toBe('balance');
    expect(v.projectedUnused).toBe(0);
    expect(v.msLeft).toBeNull();
    expect(v.needsReset).toBe(false);
  });

  it('expired: a one-off meter past its expiry', () => {
    const expiry = NOW + 2 * DAY;
    const state = add(
      emptyState(),
      'Credit pack',
      [{ label: 'Credits', unit: 'credits', limit: 1000, used: 600, reset: { kind: 'once' }, resetsAt: iso(expiry) }],
      { price: { amount: 50, currency: 'USD', period: 'month' } }
    );
    const rolled = rollState(state, expiry + HOUR);
    const v = viewState(rolled, expiry + HOUR)[0] as MeterView;
    expect(v.tier).toBe('expired');
    expect(v.valueAtRisk ?? 0).toBe(0);
    expect(v.projectedUnused).toBe(0);
  });

  it('gives every allowance meter exactly one tier from the list and throttles none', () => {
    const state = tierZoo();
    const all = viewState(state, NOW);
    for (const v of all) {
      if (v.meter.role === 'allowance') {
        expect(TIER_ORDER).toContain(v.tier);
        expect(v.throttle).toBeNull();
      } else {
        expect(v.tier).toBeNull();
        expect(['open', 'blocked', 'idle']).toContain(v.throttle);
      }
    }
    const seen = new Set(all.filter((v) => v.tier !== null).map((v) => v.tier));
    expect([...seen].sort()).toEqual([...TIER_ORDER].sort());
  });

  describe('thresholds', () => {
    it('spent starts at 98% used', () => {
      expect(view(weekly(0.5, 98)).tier).toBe('spent');
      expect(view(weekly(0.5, 97.9)).tier).not.toBe('spent');
      expect(view(weekly(0.5, 140)).tier).toBe('spent');
    });

    it('spent wins over use-now in the last hours', () => {
      expect(view(weeklyResettingIn(3, 99)).tier).toBe('spent');
    });

    it('use-now needs the reset inside the action horizon', () => {
      // Half used all week: far behind, but only "use now" once the last ~25 hours begin.
      expect(view(weeklyResettingIn(26, 50)).tier).toBe('behind');
      expect(view(weeklyResettingIn(25, 50)).tier).toBe('use-now');
      expect(view(weeklyResettingIn(1, 50)).tier).toBe('use-now');
    });

    it('use-now needs at least 10% left', () => {
      // One hour before the reset nearly everything left will expire, so only the 10% rule separates these.
      const nine = view(weeklyResettingIn(1, 91));
      expect(nine.projectedUnused).toBeGreaterThanOrEqual(0.05);
      expect(nine.tier).toBe('on-pace');
      const ten = view(weeklyResettingIn(1, 90));
      expect(ten.projectedUnused).toBeGreaterThanOrEqual(0.05);
      expect(ten.tier).toBe('use-now');
      expect(view(weeklyResettingIn(1, 89)).tier).toBe('use-now');
    });

    it('use-now needs at least 5% projected to expire', () => {
      const v = view(weeklyResettingIn(20, 88));
      expect(v.remainingFraction).toBeGreaterThanOrEqual(0.1);
      expect(v.tier).not.toBe('use-now');
    });

    it('behind starts at 15% projected to expire', () => {
      const justBehind = view(weekly(0.5, 42));
      expect(justBehind.projectedUnused).toBeGreaterThanOrEqual(0.15);
      expect(justBehind.tier).toBe('behind');
      const justFine = view(weekly(0.5, 44));
      expect(justFine.projectedUnused).toBeLessThan(0.15);
      expect(justFine.tier).toBe('on-pace');
    });

    it('hot needs a pace of 1.2 or more and at least a tenth of the window behind it', () => {
      expect(view(weekly(0.5, 61)).tier).toBe('hot');
      expect(view(weekly(0.5, 59)).tier).toBe('on-pace');
      // A burst in the first hours of a week says little: 8% elapsed is too early to call it hot.
      expect(view(weekly(0.08, 50)).tier).toBe('on-pace');
      expect(view(weekly(0.11, 50)).tier).toBe('hot');
    });

    it('a meter over its limit counts as fully used, not as negative quota', () => {
      const v = view({ label: 'Requests', unit: 'requests', limit: 300, used: 340, reset: { kind: 'monthly', day: 1, time: '00:00', tz: 'UTC' } });
      expect(v.usedFraction).toBe(1);
      expect(v.remaining).toBe(0);
      expect(v.remainingFraction).toBe(0);
      expect(v.tier).toBe('spent');
    });
  });
});

describe('required pace', () => {
  it('is 3.5 times the current pace with 60% of the window gone and 30% used', () => {
    // Scenario: Catching up.
    const v = view(weekly(0.6, 30));
    expect(v.tier).toBe('behind');
    expect(v.requiredMultiple).toBeCloseTo(3.5, 6);
    expect(explain(v, NOW)).toContain('3.5× the pace so far');
  });

  it('reports the amount per day instead of a multiple when nothing is used yet', () => {
    // Scenario: Nothing used yet.
    const halfway = utc(2026, 11, 16);
    const state = add(
      emptyState(),
      'Copilot',
      [{ label: 'Premium requests', unit: 'requests', limit: 300, used: 0, reset: { kind: 'monthly', day: 1, time: '00:00', tz: 'UTC' } }],
      {},
      halfway
    );
    const v = viewState(state, halfway)[0] as MeterView;
    expect(v.tier).toBe('behind');
    expect(v.requiredMultiple).toBeNull();
    expect(v.perDayToFinish).toBeCloseTo(20, 9); // 300 requests over the 15 days left
    expect(explain(v, halfway)).toContain('about 20 requests a day');
  });

  it('is reported for use-now as well', () => {
    const v = view(weeklyResettingIn(14, 62));
    expect(v.tier).toBe('use-now');
    const e = 1 - 14 / 168;
    expect(v.requiredMultiple).toBeCloseTo(0.38 / (1 - e) / (0.62 / e), 6);
    expect(v.perDayToFinish).toBeCloseTo(38 / (14 / 24), 6);
  });

  it('is not reported for meters that are not behind', () => {
    for (const input of [weekly(0.5, 50), weekly(0.3, 75), weekly(0.5, 99), weekly(0.02, 0)]) {
      const v = view(input);
      expect(['on-pace', 'hot', 'spent', 'fresh']).toContain(v.tier);
      expect(v.requiredMultiple).toBeNull();
      expect(v.perDayToFinish).toBeNull();
    }
  });
});

describe('throttle state', () => {
  const session = (usedPercent: number, minutesLeft: number | null): MeterInput => ({
    label: 'Session',
    role: 'throttle',
    reset: { kind: 'rolling', hours: 5 },
    ...(minutesLeft === null ? {} : { used: usedPercent, resetsAt: iso(NOW + minutesLeft * MINUTE) })
  });

  it('is open, blocked from 98% used, or idle without a window', () => {
    expect(view(session(40, 120)).throttle).toBe('open');
    expect(view(session(97, 120)).throttle).toBe('open');
    expect(view(session(98, 120)).throttle).toBe('blocked');
    expect(view(session(100, 120)).throttle).toBe('blocked');
    expect(view(session(0, null)).throttle).toBe('idle');
  });

  it('tells the weekly meter that the account is blocked for 70 minutes', () => {
    // Scenario: Session cap reached.
    const [weeklyView, sessionView] = views([weeklyResettingIn(14, 62), session(100, 70)], { price: USD_100 }) as [MeterView, MeterView];
    expect(sessionView.throttle).toBe('blocked');
    expect(sessionView.msLeft).toBe(70 * MINUTE);
    expect(weeklyView.tier).toBe('use-now');
    expect(weeklyView.blockedBy).toBe('Session');
    expect(weeklyView.blockedUntilMs).toBe(NOW + 70 * MINUTE);
    expect(explain(weeklyView, NOW)).toContain('Blocked by Session for 1h 10m.');
    expect(recommend(weeklyView, NOW)).toContain('blocked by Session for another 1h 10m');
  });

  it('is never counted as waste', () => {
    const state = add(emptyState(), 'Claude Max', [session(10, 30), weeklyResettingIn(14, 62)], { price: USD_100 });
    const [sessionView, weeklyView] = viewState(state, NOW) as [MeterView, MeterView];
    expect(sessionView).toMatchObject({
      tier: null,
      projectedUnused: 0,
      projectedFraction: null,
      valueAtRisk: null,
      windowValue: null,
      remainingValue: null,
      currency: null,
      requiredMultiple: null
    });
    const summary = summarise(state, NOW);
    expect(summary.useNow).toBe(1);
    expect(summary.atRisk['USD']).toBeCloseTo(weeklyView.valueAtRisk as number, 9);
    expect(allowanceQueue(state, NOW).map((v) => v.meter.label)).toEqual(['Weekly']);
    // A throttle takes no share of the plan price even when listed first.
    expect(sessionView.meter.valueShare).toBe(0);
    expect(weeklyView.meter.valueShare).toBe(1);
  });

  it('attaches nothing while the throttle is open or idle', () => {
    for (const throttle of [session(40, 70), session(0, null)]) {
      const [weeklyView] = views([weeklyResettingIn(14, 62), throttle]) as [MeterView];
      expect(weeklyView.blockedBy).toBeNull();
      expect(weeklyView.blockedUntilMs).toBeNull();
    }
  });

  it('reports the longest block when several gates are closed', () => {
    const [weeklyView] = views([
      weeklyResettingIn(14, 62),
      session(100, 70),
      { ...session(100, 200), label: 'Opus session' }
    ]) as [MeterView];
    expect(weeklyView.blockedUntilMs).toBe(NOW + 200 * MINUTE);
    expect(weeklyView.blockedBy).toBe('Opus session');
  });

  it('does not block other accounts', () => {
    let state = add(emptyState(), 'Claude Max', [weeklyResettingIn(14, 62), session(100, 70)]);
    state = add(state, 'ChatGPT Plus', [weeklyResettingIn(10, 40)]);
    const other = viewState(state, NOW).find((v) => v.account.label === 'ChatGPT Plus') as MeterView;
    expect(other.blockedBy).toBeNull();
  });

  it('does not put the block marker on the throttle itself', () => {
    const [, sessionView] = views([weeklyResettingIn(14, 62), session(100, 70)]) as [MeterView, MeterView];
    expect(sessionView.blockedBy).toBeNull();
  });
});

describe('staleness', () => {
  function weeklyReadAgo(ageMs: number): { state: State; v: MeterView } {
    const readAt = NOW - ageMs;
    const state = addAccount(
      emptyState(),
      { label: 'Claude Max', meters: [{ label: 'Weekly', reset: { kind: 'interval', hours: 168 }, used: 30, resetsAt: iso(NOW + 2 * DAY) }] },
      readAt
    ).state;
    return { state, v: viewState(state, NOW)[0] as MeterView };
  }

  it('marks a weekly meter last read 3 days ago and says so in its summary', () => {
    // Scenario: Old weekly reading.
    const { state, v } = weeklyReadAgo(3 * DAY);
    expect(v.stale).toBe(true);
    expect(v.ageMs).toBe(3 * DAY);
    expect(statusLine(v, NOW)).toContain('updated 3d ago');
    expect(explain(v, NOW)).toContain('Last updated 3d ago');
    expect(recommend(v, NOW)).toMatch(/stale/);
    expect(summarise(state, NOW).stale).toBe(1);
  });

  it('uses 20% of the window as the limit', () => {
    // 20% of a week is 33.6 hours.
    expect(weeklyReadAgo(33 * HOUR).v.stale).toBe(false);
    expect(weeklyReadAgo(34 * HOUR).v.stale).toBe(true);
    expect(weeklyReadAgo(DAY).v.stale).toBe(false);
  });

  it('never calls a reading stale within 30 minutes, and always after 48 hours', () => {
    const hourly = (ageMs: number): MeterView => {
      const state = addAccount(
        emptyState(),
        { label: 'A', meters: [{ label: 'Hourly', reset: { kind: 'interval', hours: 1 }, used: 5, resetsAt: iso(NOW + 20 * MINUTE) }] },
        NOW - ageMs
      ).state;
      return viewState(state, NOW)[0] as MeterView;
    };
    // 20% of an hour would be 12 minutes; the floor is 30.
    expect(hourly(20 * MINUTE).stale).toBe(false);
    expect(hourly(31 * MINUTE).stale).toBe(true);

    const monthly = (ageMs: number): MeterView => {
      const state = addAccount(
        emptyState(),
        { label: 'A', meters: [{ label: 'Monthly', used: 5, reset: { kind: 'monthly', day: 1, time: '00:00', tz: 'UTC' } }] },
        NOW - ageMs
      ).state;
      return viewState(state, NOW)[0] as MeterView;
    };
    // 20% of a month would be six days; the ceiling is 48 hours.
    expect(monthly(47 * HOUR).stale).toBe(false);
    expect(monthly(49 * HOUR).stale).toBe(true);
  });

  it('marks a meter that never had a reading', () => {
    const v = view({ label: 'Weekly', reset: { kind: 'interval', hours: 168 }, resetsAt: iso(NOW + 2 * DAY) });
    expect(v.meter.updatedAt).toBeNull();
    expect(v.ageMs).toBeNull();
    expect(v.stale).toBe(true);
    expect(explain(v, NOW)).toContain('No reading yet.');
  });

  it('is cleared by a new reading', () => {
    const { state } = weeklyReadAgo(3 * DAY);
    const account = state.accounts[0] as Account;
    const next = applyReadingToState(state, account.id, `${account.id}:weekly`, { usedPercent: 35 }, NOW);
    const v = viewState(next, NOW)[0] as MeterView;
    expect(v.stale).toBe(false);
    expect(v.ageMs).toBe(0);
    expect(statusLine(v, NOW)).not.toMatch(/updated/);
  });
});

describe('value at risk', () => {
  it('is 9.20 USD for a weekly meter projecting 40% unused on a 100 USD monthly plan', () => {
    // Scenario: Weekly window on a monthly price. 21% used after 37% of the week projects exactly 60%.
    const v = view(weekly(0.37, 21), { price: USD_100 });
    expect(v.meter.valueShare).toBe(1);
    expect(v.projectedUnused).toBeCloseTo(0.4, 6);
    expect(Math.abs((v.valueAtRisk as number) - 9.2)).toBeLessThan(0.01);
    expect(v.currency).toBe('USD');
    expect(v.windowValue).toBeCloseTo(WEEK_OF_100, 9);
  });

  it('follows price per month x window share of a month x value share x unused', () => {
    const v = view(weekly(0.5, 20, { valueShare: 0.5 }), { price: USD_100 });
    expect(v.valueAtRisk).toBeCloseTo(100 * (WEEK / MONTH) * 0.5 * (1 - d4Projected(0.2, 0.5)), 6);
    expect(v.remainingValue).toBeCloseTo(100 * (WEEK / MONTH) * 0.5 * 0.8, 6);
  });

  it('divides a yearly price by 12', () => {
    const monthlyPriced = view(weekly(0.37, 21), { price: USD_100 });
    const yearlyPriced = view(weekly(0.37, 21), { price: { amount: 1200, currency: 'USD', period: 'year' } });
    expect(yearlyPriced.valueAtRisk).toBeCloseTo(monthlyPriced.valueAtRisk as number, 9);
  });

  it('never values a window above one month of the plan', () => {
    const state = add(
      emptyState(),
      'Copilot',
      [{ label: 'Premium requests', unit: 'requests', limit: 300, used: 0, reset: { kind: 'monthly', day: 1, time: '00:00', tz: 'UTC' } }],
      { price: { amount: 10, currency: 'USD', period: 'month' } },
      utc(2026, 12, 16)
    );
    // December has 31 days, more than the mean month.
    const december = viewState(state, utc(2026, 12, 16))[0] as MeterView;
    expect(december.windowMs).toBe(31 * DAY);
    expect(december.windowValue).toBe(10);
    const sixtyDays = view(windowed(1440, 0.5, 20), { price: USD_100 });
    expect(sixtyDays.windowValue).toBe(100);
  });

  it('is absent without a price, and such meters stay out of money totals', () => {
    // Scenario: No price.
    const state = add(emptyState(), 'Free tier', [weeklyResettingIn(14, 62)]);
    const v = viewState(state, NOW)[0] as MeterView;
    expect(v.tier).toBe('use-now');
    expect(v.valueAtRisk).toBeNull();
    expect(v.currency).toBeNull();
    expect(v.windowValue).toBeNull();
    const summary = summarise(state, NOW);
    expect(summary.useNow).toBe(1);
    expect(summary.atRisk).toEqual({});
    expect(summary.atRiskNow).toEqual({});
    expect(statusLine(v, NOW)).not.toMatch(/at risk/);
  });

  it('keeps totals apart for USD and SEK', () => {
    // Scenario: Mixed currencies.
    let state = add(emptyState(), 'Claude Max', [weekly(0.37, 21)], { price: USD_100 });
    state = add(state, 'Svensk tjänst', [weekly(0.37, 21)], { price: { amount: 249, currency: 'SEK', period: 'month' } });
    const summary = summarise(state, NOW);
    expect(Object.keys(summary.atRisk).sort()).toEqual(['SEK', 'USD']);
    expect(Math.abs((summary.atRisk['USD'] as number) - 9.2)).toBeLessThan(0.01);
    expect(summary.atRisk['SEK']).toBeCloseTo(249 * (WEEK / MONTH) * 0.4, 3);
    const text = formatMoneyTotals(summary.atRisk, 'USD');
    expect(text).toContain('$9.20');
    expect(text).toContain('22.91');
    expect(text).toContain(' + ');
  });

  it('values a meter counted in dollars as its own amount, in USD', () => {
    const state = add(
      emptyState(),
      'API credits',
      [{ label: 'Monthly credit', unit: 'usd', limit: 20, used: 4, resetsAt: iso(NOW + 15 * DAY), windowStartedAt: iso(NOW - 15 * DAY), reset: { kind: 'interval', hours: 720 } }],
      { price: { amount: 249, currency: 'SEK', period: 'month' } }
    );
    const v = viewState(state, NOW)[0] as MeterView;
    expect(v.windowValue).toBe(20);
    expect(v.currency).toBe('USD');
    expect(v.valueAtRisk).toBeCloseTo(20 * (1 - d4Projected(0.2, 0.5)), 6);
    expect(summarise(state, NOW).atRisk).toEqual({ USD: v.valueAtRisk });

    const unpriced = view({ label: 'Monthly credit', unit: 'usd', limit: 20, used: 4, resetsAt: iso(NOW + 15 * DAY), reset: { kind: 'interval', hours: 720 } });
    expect(unpriced.currency).toBe('USD');
    expect(unpriced.valueAtRisk).toBeCloseTo(v.valueAtRisk as number, 9);
  });

  it('counts only the first allowance of an account unless value shares say otherwise', () => {
    const state = add(
      emptyState(),
      'Claude Max',
      [
        { label: 'Session', role: 'throttle', reset: { kind: 'rolling', hours: 5 } },
        weekly(0.5, 20, { label: 'Weekly all models' }),
        weekly(0.5, 20, { label: 'Weekly Opus' })
      ],
      { price: USD_100 }
    );
    const [, all, opus] = viewState(state, NOW) as [MeterView, MeterView, MeterView];
    expect(all.meter.valueShare).toBe(1);
    expect(opus.meter.valueShare).toBe(0);
    expect(opus.tier).toBe('behind');
    expect(opus.valueAtRisk).toBeNull();
    // The overlapping sub-limit must not double the money at risk.
    expect(summarise(state, NOW).atRisk['USD']).toBeCloseTo(all.valueAtRisk as number, 9);
  });

  it('is zero for quota that carries over, whatever the pace', () => {
    // Scenario: Quota that carries over.
    const state = add(emptyState(), 'ElevenLabs', [weeklyResettingIn(14, 20, { rollover: 'carries' })], { price: USD_100 });
    const v = viewState(state, NOW)[0] as MeterView;
    expect(v.projectedUnused).toBe(0);
    expect(v.valueAtRisk ?? 0).toBe(0);
    expect(v.remainingValue ?? 0).toBe(0);
    expect(['use-now', 'behind']).not.toContain(v.tier);
    const summary = summarise(state, NOW);
    expect(summary.atRisk).toEqual({});
    expect(summary.useNow + summary.behind).toBe(0);
    expect(explain(v, NOW)).toContain('carries over');
    // The same meter without carry-over is the urgent case.
    expect(view(weeklyResettingIn(14, 20), { price: USD_100 }).tier).toBe('use-now');
  });
});

/** One account per tier (plus throttles), each with a distinct, known state. */
function tierZoo(): State {
  let state = emptyState();
  state = add(state, 'G spent', [weekly(0.5, 99)], { price: USD_100 });
  state = add(state, 'E idle', [{ label: 'Weekly', reset: { kind: 'interval', hours: 168 } }]);
  state = add(state, 'C hot', [weekly(0.3, 75)], { price: USD_100 });
  state = add(state, 'A use-now', [weeklyResettingIn(14, 62), { label: 'Session', role: 'throttle', reset: { kind: 'rolling', hours: 5 }, used: 100, resetsAt: iso(NOW + 70 * MINUTE) }], {
    price: USD_100
  });
  state = add(state, 'F balance', [{ label: 'Balance', unit: 'credits', limit: 500, used: 100, reset: { kind: 'none' } }]);
  state = add(state, 'D on-pace', [weekly(0.5, 50)], { price: USD_100 });
  state = add(state, 'B behind', [weekly(0.5, 20)], { price: USD_100 });
  state = add(state, 'D2 fresh', [weekly(0.02, 0)], { price: USD_100 });
  state = add(state, 'H expired', [{ label: 'Credits', unit: 'credits', limit: 1000, used: 600, reset: { kind: 'once' }, resetsAt: iso(NOW - HOUR) }], {}, NOW - 3 * HOUR);
  return rollState(state, NOW);
}

describe('orderings', () => {
  it('offers the six orderings of the spec', () => {
    expect(SORT_ORDERS.map((order) => order.id)).toEqual(['use-first', 'reset', 'left', 'value', 'name', 'updated']);
  });

  it('use first: tiers in the order use-now, behind, hot, on-pace, fresh, idle, balance, spent, expired', () => {
    expect(TIER_ORDER).toEqual(['use-now', 'behind', 'hot', 'on-pace', 'fresh', 'idle', 'balance', 'spent', 'expired']);
    // The one-off pack expires an hour after NOW, so look two hours later for the expired tier.
    const later = NOW + 2 * HOUR;
    let state = emptyState();
    state = add(state, 'G spent', [weekly(0.5, 99)]);
    state = add(state, 'E idle', [{ label: 'Weekly', reset: { kind: 'interval', hours: 168 } }]);
    state = add(state, 'C hot', [weekly(0.3, 75)]);
    state = add(state, 'A use-now', [weeklyResettingIn(14, 62)]);
    state = add(state, 'F balance', [{ label: 'Balance', unit: 'credits', limit: 500, used: 100, reset: { kind: 'none' } }]);
    state = add(state, 'D on-pace', [weekly(0.5, 50)]);
    state = add(state, 'B behind', [weekly(0.5, 20)]);
    state = add(state, 'H expired', [{ label: 'Credits', unit: 'credits', limit: 1000, used: 600, reset: { kind: 'once' }, resetsAt: iso(NOW + HOUR) }]);
    state = rollState(state, later);
    state = add(state, 'D2 fresh', [{ label: 'Weekly', used: 0, reset: { kind: 'interval', hours: 168 }, resetsAt: iso(later + 0.98 * WEEK) }], {}, later);
    const queue = allowanceQueue(state, later);
    expect(queue.map((v) => v.tier)).toEqual(TIER_ORDER);
    expect(queue.map((v) => v.account.label)).toEqual([
      'A use-now',
      'B behind',
      'C hot',
      'D on-pace',
      'D2 fresh',
      'E idle',
      'F balance',
      'G spent',
      'H expired'
    ]);
  });

  it('use first: the meter resetting in 3 hours comes before the one resetting in 20', () => {
    // Scenario: Two meters that need using.
    let state = add(emptyState(), 'Later', [weeklyResettingIn(20, 50)]);
    state = add(state, 'Sooner', [weeklyResettingIn(3, 50)]);
    const queue = allowanceQueue(state, NOW);
    expect(queue.map((v) => v.tier)).toEqual(['use-now', 'use-now']);
    expect(queue.map((v) => v.account.label)).toEqual(['Sooner', 'Later']);
  });

  it('use first: equal reset times are ordered by value at risk, highest first', () => {
    let state = add(emptyState(), 'Cheap', [weeklyResettingIn(10, 50)], { price: { amount: 20, currency: 'USD', period: 'month' } });
    state = add(state, 'Dear', [weeklyResettingIn(10, 50)], { price: { amount: 200, currency: 'USD', period: 'month' } });
    state = add(state, 'Free', [weeklyResettingIn(10, 50)]);
    expect(allowanceQueue(state, NOW).map((v) => v.account.label)).toEqual(['Dear', 'Cheap', 'Free']);
  });

  it('use first: a snoozed account goes after every other meter and is left out of the summary', () => {
    // Scenarios: Snoozed and stale items; Snoozed while travelling.
    let state = add(emptyState(), 'Travelling', [weeklyResettingIn(3, 50)], { price: USD_100 });
    state = add(state, 'Spent', [weekly(0.5, 99)]);
    state = add(state, 'Idle', [{ label: 'Weekly', reset: { kind: 'interval', hours: 168 } }]);
    state = add(state, 'Behind', [{ label: 'Monthly', used: 5, reset: { kind: 'monthly', day: 1, time: '00:00', tz: 'UTC' } }]);
    expect((allowanceQueue(state, NOW)[0] as MeterView).account.label).toBe('Travelling');
    expect(summarise(state, NOW).useNow).toBe(1);

    const travelling = state.accounts[0] as Account;
    state = updateAccount(state, travelling.id, { snoozedUntil: iso(NOW + 3 * DAY) }, NOW);
    const queue = allowanceQueue(state, NOW);
    expect(queue.map((v) => v.account.label)).toEqual(['Behind', 'Idle', 'Spent', 'Travelling']);
    const snoozed = queue[queue.length - 1] as MeterView;
    expect(snoozed.snoozed).toBe(true);
    expect(snoozed.tier).toBe('use-now'); // still visible with its real state
    const summary = summarise(state, NOW);
    expect(summary.useNow).toBe(0);
    expect(summary.atRisk).toEqual({});
    expect(summary.atRiskNow).toEqual({});
    expect(summary.nextReset?.account.label).toBe('Behind');
  });

  it('a snooze ends by itself when its time passes', () => {
    let state = add(emptyState(), 'Copilot', [{ label: 'Monthly', used: 5, reset: { kind: 'monthly', day: 1, time: '00:00', tz: 'UTC' } }], {
      price: { amount: 10, currency: 'USD', period: 'month' }
    });
    state = updateAccount(state, (state.accounts[0] as Account).id, { snoozedUntil: iso(NOW + 3 * DAY) }, NOW);
    for (const during of [NOW, NOW + DAY, NOW + 3 * DAY - MINUTE]) {
      expect((viewState(state, during)[0] as MeterView).snoozed).toBe(true);
      expect(summarise(state, during).behind).toBe(0);
      expect(summarise(state, during).atRisk).toEqual({});
    }
    const after = NOW + 3 * DAY + MINUTE;
    expect((viewState(state, after)[0] as MeterView).snoozed).toBe(false);
    expect(summarise(state, after).behind).toBe(1);
    expect(summarise(state, after).atRisk['USD']).toBeGreaterThan(0);
  });

  function mixed(): State {
    let state = emptyState();
    state = add(state, 'Bravo', [weeklyResettingIn(100, 10)], { price: { amount: 20, currency: 'USD', period: 'month' } }, NOW - 2 * HOUR);
    state = add(state, 'alpha', [weeklyResettingIn(30, 70)], { price: { amount: 200, currency: 'USD', period: 'month' } }, NOW - 5 * DAY);
    state = add(state, 'Charlie', [{ label: 'Weekly', reset: { kind: 'interval', hours: 168 } }]);
    state = add(state, 'Delta', [weeklyResettingIn(60, 40), weeklyResettingIn(60, 90, { label: 'Opus' })], {}, NOW - DAY);
    return state;
  }

  it('soonest reset: ascending time to reset, meters without a clock last', () => {
    const order = sortViews(viewState(mixed(), NOW), 'reset').map((v) => `${v.account.label}/${v.meter.label}`);
    expect(order).toEqual(['alpha/Weekly', 'Delta/Opus', 'Delta/Weekly', 'Bravo/Weekly', 'Charlie/Weekly']);
  });

  it('most left: largest remaining share first', () => {
    const order = sortViews(viewState(mixed(), NOW), 'left').map((v) => `${v.account.label}/${v.meter.label}`);
    expect(order).toEqual(['Charlie/Weekly', 'Bravo/Weekly', 'Delta/Weekly', 'alpha/Weekly', 'Delta/Opus']);
  });

  it('most value at risk: highest money first, unpriced meters after priced ones', () => {
    const sorted = sortViews(viewState(mixed(), NOW), 'value');
    const priced = sorted.filter((v) => v.valueAtRisk !== null);
    expect(sorted.slice(0, priced.length)).toEqual(priced);
    const values = priced.map((v) => v.valueAtRisk as number);
    expect(values).toEqual(values.slice().sort((a, b) => b - a));
    expect((sorted[0] as MeterView).valueAtRisk).toBe(Math.max(...values));
  });

  it('name: account then meter, ignoring case', () => {
    const order = sortViews(viewState(mixed(), NOW), 'name').map((v) => `${v.account.label}/${v.meter.label}`);
    expect(order).toEqual(['alpha/Weekly', 'Bravo/Weekly', 'Charlie/Weekly', 'Delta/Opus', 'Delta/Weekly']);
  });

  it('least recently updated: never-read meters first, then oldest reading first', () => {
    const order = sortViews(viewState(mixed(), NOW), 'updated').map((v) => `${v.account.label}/${v.meter.label}`);
    expect(order).toEqual(['Charlie/Weekly', 'alpha/Weekly', 'Delta/Opus', 'Delta/Weekly', 'Bravo/Weekly']);
  });

  it('sorting returns a new list and every ordering is a permutation of the input', () => {
    const input = viewState(mixed(), NOW);
    const copy = input.slice();
    for (const { id } of SORT_ORDERS) {
      const sorted = sortViews(input, id);
      expect(sorted).not.toBe(input);
      expect(sorted.map((v) => v.id).sort()).toEqual(copy.map((v) => v.id).sort());
    }
    expect(input).toEqual(copy);
  });

  it('the queue holds allowance meters only, in any ordering', () => {
    const state = tierZoo();
    for (const { id } of SORT_ORDERS) {
      const queue = allowanceQueue(state, NOW, id);
      expect(queue.every((v) => v.meter.role === 'allowance')).toBe(true);
      expect(queue).toHaveLength(9);
    }
  });

  it('use first is the default ordering', () => {
    const state = tierZoo();
    expect(allowanceQueue(state, NOW).map((v) => v.id)).toEqual(allowanceQueue(state, NOW, 'use-first').map((v) => v.id));
    expect(sortViews(viewState(state, NOW)).map((v) => v.id)).toEqual(sortViews(viewState(state, NOW), 'use-first').map((v) => v.id));
  });
});

describe('summarise', () => {
  it('counts tiers, money at risk and the next reset', () => {
    const state = tierZoo();
    const summary = summarise(state, NOW);
    const all = viewState(state, NOW);
    const byTier = (tier: Tier): MeterView[] => all.filter((v) => v.tier === tier);
    expect(summary.useNow).toBe(1);
    expect(summary.behind).toBe(1);
    expect(summary.hot).toBe(1);

    const expectedRisk = all.reduce((sum, v) => sum + (v.currency === 'USD' ? (v.valueAtRisk ?? 0) : 0), 0);
    expect(summary.atRisk['USD']).toBeCloseTo(expectedRisk, 9);
    expect(summary.atRiskNow['USD']).toBeCloseTo((byTier('use-now')[0] as MeterView).valueAtRisk as number, 9);
    expect(summary.atRiskNow['USD'] as number).toBeLessThan(summary.atRisk['USD'] as number);

    // The use-now meter resets in 14 hours; the spent and expired ones do not count as "next".
    expect(summary.nextReset?.account.label).toBe('A use-now');
    expect(summary.nextReset?.msLeft).toBe(14 * HOUR);
  });

  it('counts stale meters, but not idle or expired ones', () => {
    const state = tierZoo();
    const later = NOW + 3 * DAY;
    const stale = viewState(state, later).filter((v) => v.tier !== null && v.stale && v.tier !== 'idle' && v.tier !== 'expired');
    expect(stale.length).toBeGreaterThan(0);
    expect(summarise(state, later).stale).toBe(stale.length);
    expect(summarise(state, NOW).stale).toBe(0);
  });

  it('reports nothing for an empty state', () => {
    expect(summarise(emptyState(), NOW)).toEqual({
      useNow: 0,
      behind: 0,
      hot: 0,
      stale: 0,
      atRisk: {},
      atRiskNow: {},
      nextReset: null,
      lost30: {},
      utilisation30: null,
      cycles30: 0,
      lostIsEstimate: false
    });
  });

  it('skips used-up meters when naming the next reset', () => {
    let state = add(emptyState(), 'Spent soon', [weeklyResettingIn(2, 100)]);
    state = add(state, 'Still open', [weeklyResettingIn(50, 40)]);
    expect(summarise(state, NOW).nextReset?.account.label).toBe('Still open');
  });
});
