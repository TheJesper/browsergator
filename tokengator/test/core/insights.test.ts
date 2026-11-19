import { describe, expect, it } from 'vitest';

import { addAccount, updateAccount, type AccountInput, type MeterInput } from '../../src/core/accounts.js';
import { demoState } from '../../src/core/demo.js';
import { ledgerTotals, summarise, viewState, type MeterView } from '../../src/core/forecast.js';
import { weeksMarkdown } from '../../src/core/brief.js';
import { FORECAST_TIERS, blockedLimits, countTiers, expectsToExpire, expiryOutlook, ledgerWeeks, nextUseNow, plottable, refreshList, upcomingResets, wasteBy, weeksCovering } from '../../src/core/insights.js';
import { rollState } from '../../src/core/reset.js';
import { DAY, HOUR, iso } from '../../src/core/time.js';
import { emptyState, type ClosedCycle, type Price, type State } from '../../src/core/types.js';

const utc = (y: number, mo: number, d: number, h = 0, mi = 0): number => Date.UTC(y, mo - 1, d, h, mi, 0);
/** Thursday 19 November 2026, 17:30 UTC. */
const NOW = utc(2026, 11, 19, 17, 30);
const USD_100: Price = { amount: 100, currency: 'USD', period: 'month' };

function add(state: State, label: string, meters: MeterInput[], extra: Partial<AccountInput> = {}): State {
  return addAccount(state, { label, meters, ...extra }, NOW).state;
}

/** A weekly window resetting in `hours` with `usedPercent` used. */
const weekly = (hours: number, usedPercent: number, extra: Partial<MeterInput> = {}): MeterInput => ({
  label: 'Weekly limit',
  reset: { kind: 'interval', hours: 168 },
  used: usedPercent,
  resetsAt: iso(NOW + hours * HOUR),
  ...extra
});

function cycle(over: Partial<ClosedCycle> & Pick<ClosedCycle, 'endedAt'>): ClosedCycle {
  return {
    id: `c-${over.endedAt}-${over.meterId ?? 'm'}`,
    accountId: 'acc',
    meterId: 'acc:weekly',
    providerId: 'claude',
    accountLabel: 'Claude Max',
    meterLabel: 'Weekly limit',
    unit: 'percent',
    startedAt: null,
    limit: 100,
    used: 60,
    wastedFraction: 0.4,
    wastedValue: 9.2,
    currency: 'USD',
    confidence: 'measured',
    ...over
  };
}

const sample = (): { state: State; views: MeterView[] } => {
  const state = rollState(demoState(NOW), NOW);
  return { state, views: viewState(state, NOW) };
};

describe('upcomingResets', () => {
  it('steps a fixed interval up to the end of the range, and respects the cap', () => {
    const [view] = viewState(add(emptyState(), 'Claude Max', [weekly(14, 62)]), NOW);
    const resets = upcomingResets(view as MeterView, NOW, NOW + 30 * DAY);
    expect(resets).toEqual([0, 1, 2, 3, 4].map((i) => NOW + 14 * HOUR + i * 168 * HOUR));
    expect(upcomingResets(view as MeterView, NOW, NOW + 30 * DAY, 2)).toHaveLength(2);
  });

  it('gives one end for a window that opens on first use, and none without a future reset', () => {
    const [rolling] = viewState(add(emptyState(), 'Codex', [{ label: 'Session', role: 'throttle', reset: { kind: 'rolling', hours: 5 }, used: 10, resetsAt: iso(NOW + HOUR) }]), NOW);
    expect(upcomingResets(rolling as MeterView, NOW, NOW + 30 * DAY)).toEqual([NOW + HOUR]);
    const [unknown] = viewState(add(emptyState(), 'Claude Max', [{ label: 'Weekly limit', reset: { kind: 'interval', hours: 168 }, used: 10 }]), NOW);
    expect(upcomingResets(unknown as MeterView, NOW, NOW + 30 * DAY)).toEqual([]);
  });
});

describe('expiryOutlook', () => {
  it('puts each reset on its calendar day in the viewer\'s zone', () => {
    // 23:30 UTC on the 20th is already the 21st in Stockholm.
    const state = add(emptyState(), 'Claude Max', [weekly(30, 62)], { price: USD_100 });
    const views = viewState(state, NOW);
    const inUtc = expiryOutlook(views, NOW, 30, 'UTC');
    const inStockholm = expiryOutlook(views, NOW, 30, 'Europe/Stockholm');
    const dayOf = (outlook: ReturnType<typeof expiryOutlook>): string | undefined => outlook.days.find((day) => day.entries.some((entry) => entry.current))?.date;
    expect(dayOf(inUtc)).toBe('2026-11-20');
    expect(dayOf(inStockholm)).toBe('2026-11-21');
    expect(inUtc.days).toHaveLength(30);
    expect(inUtc.days[0]?.date).toBe('2026-11-19');
  });

  it('keeps plan money and dollar credits apart and never adds them', () => {
    let state = add(emptyState(), 'Claude Max', [weekly(14, 62), { label: 'API credits', unit: 'usd', limit: 100, used: 20, reset: { kind: 'interval', hours: 720 }, resetsAt: iso(NOW + 9 * DAY) }], { price: USD_100 });
    state = updateAccount(state, 'claude-max', {}, NOW);
    const outlook = expiryOutlook(viewState(state, NOW), NOW, 30, 'UTC');
    const plan = outlook.days.reduce((sum, day) => sum + (day.plan['USD'] ?? 0), 0);
    const credits = outlook.days.reduce((sum, day) => sum + (day.credits['USD'] ?? 0), 0);
    expect(plan).toBeGreaterThan(0);
    expect(credits).toBeGreaterThan(0);
    const summary = summarise(state, NOW);
    expect(plan).toBeCloseTo(summary.atRisk['USD'] ?? 0, 6);
    expect(credits).toBeCloseTo(summary.creditsAtRisk['USD'] ?? 0, 6);
    for (const day of outlook.days) expect(Object.keys(day).filter((key) => /total|sum/i.test(key))).toEqual([]);
  });

  it('leaves out carried-over and snoozed quotas, and counts the snoozed', () => {
    let state = add(emptyState(), 'Suno', [weekly(14, 20, { rollover: 'carries' })], { price: USD_100 });
    state = add(state, 'Claude Max', [weekly(20, 20)], { price: USD_100 });
    state = updateAccount(state, 'claude-max', { snoozedUntil: iso(NOW + 3 * DAY) }, NOW);
    const outlook = expiryOutlook(viewState(state, NOW), NOW, 30, 'UTC');
    expect(outlook.days.every((day) => Object.keys(day.plan).length === 0)).toBe(true);
    expect(outlook.snoozed).toBe(1);
  });

  it('lists the later windows of a meter as renewals with nothing forecast, and counts unpriced losses', () => {
    const state = add(emptyState(), 'Claude Max', [weekly(14, 10)]);
    const outlook = expiryOutlook(viewState(state, NOW), NOW, 30, 'UTC');
    const entries = outlook.days.flatMap((day) => day.entries);
    expect(entries.filter((entry) => entry.current)).toHaveLength(1);
    expect(entries.filter((entry) => !entry.current).length).toBeGreaterThanOrEqual(3);
    expect(entries.filter((entry) => !entry.current).every((entry) => entry.valueAtRisk === null && entry.projectedUnused === 0)).toBe(true);
    expect(outlook.unvalued).toBe(1);
    expect(outlook.days.find((day) => day.unvalued > 0)?.count).toBe(1);
  });

  it('on the sample: the first week and what resets after 30 days', () => {
    const { views } = sample();
    const outlook = expiryOutlook(views, NOW, 30, 'UTC');
    const fromViews = views.filter((view) => view.tier !== null && !view.snoozed && view.valueBasis === 'plan' && view.resetsAtMs !== null && view.resetsAtMs < outlook.days[7]!.startMs);
    expect(outlook.firstWeek.plan['USD']).toBeCloseTo(fromViews.reduce((sum, view) => sum + (view.valueAtRisk ?? 0), 0), 6);
    expect(Object.keys(outlook.firstWeek.credits)).toEqual([]);
    expect(outlook.later.credits['USD']).toBeGreaterThan(0);
    expect(outlook.days.some((day) => day.urgent)).toBe(true);
  });

  it('leaves out an expired one-off pack: it has no reset ahead', () => {
    const state = add(emptyState(), 'Credit pack', [{ label: 'Pack', unit: 'usd', limit: 50, used: 10, reset: { kind: 'once' }, resetsAt: iso(NOW + 2 * DAY) }]);
    const later = NOW + 12 * DAY;
    const views = viewState(rollState(state, later), later);
    expect(views[0]?.tier).toBe('expired');
    const outlook = expiryOutlook(views, later, 30, 'UTC');
    expect(outlook.days.flatMap((day) => day.entries)).toEqual([]);
    expect(outlook.later).toMatchObject({ count: 0, firstMs: null, plan: {}, credits: {} });
  });

  it('puts a reset just due on today, and drops one that passed days ago', () => {
    const state = add(emptyState(), 'Claude Max', [weekly(14, 10)], { price: USD_100 });
    const resetMs = NOW + 14 * HOUR;
    // Read before the next reading rolls the window on: two hours past its reset, it is closing now.
    const due = expiryOutlook(viewState(state, resetMs + 2 * HOUR), resetMs + 2 * HOUR, 30, 'UTC');
    expect(due.days[0]?.entries.map((entry) => entry.atMs)).toEqual([resetMs]);
    // Three days past, the window has closed: it is not drawn on today.
    const past = expiryOutlook(viewState(state, resetMs + 3 * DAY), resetMs + 3 * DAY, 30, 'UTC');
    expect(past.days.flatMap((day) => day.entries)).toEqual([]);
    expect(past.unvalued + past.stale + past.later.count).toBe(0);
  });

  it('counts a quota resetting after the range by the same test as its money', () => {
    // A quarter on pace with 54% used five ninths in: about 3% left at the reset, worth a few dollars.
    const state = add(emptyState(), 'Quarterly', [{ label: 'Quarter', reset: { kind: 'interval', hours: 2160 }, used: 54, resetsAt: iso(NOW + 40 * DAY) }], { price: USD_100 });
    const views = viewState(state, NOW);
    expect(views[0]?.tier).toBe('on-pace');
    expect(views[0]?.projectedUnused).toBeLessThan(0.05);
    const outlook = expiryOutlook(views, NOW, 30, 'UTC');
    expect(outlook.later.plan['USD']).toBeGreaterThan(0);
    expect(outlook.later.count).toBe(1);
    expect(outlook.later.firstMs).toBe(NOW + 40 * DAY);
  });
});

describe('expectsToExpire', () => {
  it('is true only for a forecast that leaves 5% or more that does not carry over', () => {
    const state = add(emptyState(), 'Claude Max', [
      { ...weekly(40, 20), key: 'behind', label: 'Behind' },
      { ...weekly(160, 1), key: 'fresh', label: 'Fresh' },
      { ...weekly(40, 20, { rollover: 'carries' }), key: 'carries', label: 'Carries' },
      { ...weekly(40, 100), key: 'spent', label: 'Spent' },
      { key: 'session', label: 'Session', role: 'throttle', reset: { kind: 'rolling', hours: 5 }, used: 10, resetsAt: iso(NOW + HOUR) }
    ], { price: USD_100 });
    const byKey = new Map(viewState(state, NOW).map((view) => [view.meter.key, view]));
    expect(byKey.get('behind')?.tier).toBe('behind');
    expect(expectsToExpire(byKey.get('behind') as MeterView)).toBe(true);
    // Too early to forecast, however much would be left at this pace.
    expect(byKey.get('fresh')).toMatchObject({ tier: 'fresh' });
    expect(byKey.get('fresh')?.projectedUnused).toBeGreaterThanOrEqual(0.05);
    expect(expectsToExpire(byKey.get('fresh') as MeterView)).toBe(false);
    for (const key of ['carries', 'spent', 'session']) expect(expectsToExpire(byKey.get(key) as MeterView), key).toBe(false);
  });

  it('agrees with the forecasting states on the sample', () => {
    const { views } = sample();
    expect([...FORECAST_TIERS]).toEqual(['use-now', 'behind', 'on-pace']);
    const expiring = views.filter(expectsToExpire);
    expect(expiring.length).toBeGreaterThan(0);
    expect(views.filter((view) => view.tier === 'fresh').some(expectsToExpire)).toBe(false);
    for (const view of expiring) expect(FORECAST_TIERS).toContain(view.tier);
  });
});

describe('ledgerWeeks', () => {
  it('starts weeks on Monday in the zone, ends the last one now, and reports a week without windows as no record', () => {
    const cycles = [cycle({ endedAt: iso(utc(2026, 11, 3, 12)) }), cycle({ endedAt: iso(utc(2026, 11, 18, 12)), confidence: 'estimated', wastedValue: 5 })];
    const weeks = ledgerWeeks(cycles, NOW, 3, 'UTC');
    expect(weeks.map((week) => iso(week.startMs))).toEqual(['2026-11-02T00:00:00.000Z', '2026-11-09T00:00:00.000Z', '2026-11-16T00:00:00.000Z']);
    expect(weeks[2]?.endMs).toBe(NOW);
    expect(weeks.map((week) => week.windows)).toEqual([1, 0, 1]);
    expect(weeks[1]?.lost).toEqual({});
    expect(weeks[2]).toMatchObject({ estimatedWindows: 1, lost: { USD: 5 }, lostEstimated: { USD: 5 } });
    // A week in the middle still has the share used over the 30 days ending with it.
    expect(weeks[1]?.trailingWindows).toBe(1);
  });

  it('puts dollar credits apart, and the current week matches the 30-day figure', () => {
    const { state } = sample();
    const weeks = ledgerWeeks(state.cycles, NOW, 12, 'UTC');
    const last = weeks[weeks.length - 1];
    expect(last?.trailingUtilisation).toBe(ledgerTotals(state.cycles, NOW, 30).utilisation30);
    expect(weeks.some((week) => (week.creditsLost['USD'] ?? 0) > 0)).toBe(true);
    for (const week of weeks) expect(Object.keys(week.lost).every((code) => code === 'USD')).toBe(true);
  });

  it('counts a week in Stockholm from local Monday midnight', () => {
    // Sunday 23:30 UTC on the 15th is already Monday 00:30 on the 16th in Stockholm.
    const cycles = [cycle({ endedAt: iso(utc(2026, 11, 15, 23, 30)) })];
    const local = ledgerWeeks(cycles, NOW, 2, 'Europe/Stockholm');
    const inUtc = ledgerWeeks(cycles, NOW, 2, 'UTC');
    expect(local.map((week) => week.windows)).toEqual([0, 1]);
    expect(inUtc.map((week) => week.windows)).toEqual([1, 0]);
  });
});

describe('weeksCovering', () => {
  it('counts the weeks from the one the span starts in to the current one', () => {
    // Thursday: seven days back is last Thursday, in last week.
    expect(weeksCovering(NOW, 7, 'UTC')).toBe(2);
    expect(weeksCovering(NOW, 3, 'UTC')).toBe(1);
    expect(weeksCovering(NOW, 30, 'UTC')).toBe(5);
    expect(weeksCovering(NOW, 365, 'UTC')).toBe(53);
    // Across the end of summer time in Stockholm a week is an hour long, and still one week.
    expect(weeksCovering(NOW, 30, 'Europe/Stockholm')).toBe(5);
  });

  it('gives weeks that hold every window the totals count over the same days', () => {
    const ended = [0.5, 3, 5, 6.9, 7.2, 12, 29.5, 31].map((daysAgo) => NOW - daysAgo * DAY);
    const cycles = ended.map((at) => cycle({ endedAt: iso(at) }));
    for (const tz of ['UTC', 'Europe/Stockholm', 'America/Los_Angeles']) {
      for (const days of [1, 7, 14, 30]) {
        const weeks = ledgerWeeks(cycles, NOW, weeksCovering(NOW, days, tz), tz);
        const inWeeks = weeks.reduce((sum, week) => sum + week.windows, 0);
        const first = weeks[0]?.startMs ?? NOW;
        expect(first, `${tz} ${days}`).toBeLessThanOrEqual(NOW - days * DAY);
        expect(inWeeks, `${tz} ${days}`).toBeGreaterThanOrEqual(ledgerTotals(cycles, NOW, days).cycles30);
        expect(inWeeks, `${tz} ${days}`).toBe(ended.filter((at) => at >= first).length);
      }
    }
  });
});

describe('weeksMarkdown', () => {
  it('writes an estimated amount as about a whole amount, and keeps credits and their estimate apart', () => {
    const cycles = [
      cycle({ endedAt: iso(utc(2026, 11, 3, 12)), wastedValue: 9.68 }),
      cycle({ endedAt: iso(utc(2026, 11, 17, 12)), wastedValue: 12.19, confidence: 'estimated' }),
      cycle({ endedAt: iso(utc(2026, 11, 18, 12)), meterId: 'acc:credits', unit: 'usd', wastedValue: 52, confidence: 'estimated' })
    ];
    const lines = weeksMarkdown(ledgerWeeks(cycles, NOW, 3, 'UTC'), 'USD', 'UTC').split('\n');
    expect(lines[0]).toBe('| Week of | Windows | Expired | Of which estimated | Credits expired | Credits estimated | Used, trailing 30 days |');
    // Every window left 40% unused.
    expect(lines.slice(2)).toEqual([
      '| 2026-11-02 | 1 | $9.68 |  |  |  | 60% |',
      '| 2026-11-09 | 0 | no window closed |  |  |  | 60% |',
      '| 2026-11-16 | 2 | about $12 | about $12 | about $52 | about $52 | 60% |'
    ]);
  });
});

describe('wasteBy', () => {
  it('orders by plan money lost, keeps credits apart, and keeps the name of a deleted subscription', () => {
    const cycles = [
      cycle({ endedAt: iso(NOW - 10 * DAY), accountId: 'a', accountLabel: 'Old name', meterId: 'a:w', wastedValue: 4 }),
      cycle({ endedAt: iso(NOW - 3 * DAY), accountId: 'a', accountLabel: 'Alpha', meterId: 'a:w', wastedValue: 6, confidence: 'estimated' }),
      cycle({ endedAt: iso(NOW - 5 * DAY), accountId: 'b', accountLabel: 'Bravo', meterId: 'b:credits', unit: 'usd', wastedValue: 70, wastedFraction: 0.7 }),
      cycle({ endedAt: iso(NOW - 5 * DAY), accountId: 'c', accountLabel: 'Charlie', meterId: 'c:w', wastedValue: 8 }),
      cycle({ endedAt: iso(NOW - 200 * DAY), accountId: 'd', accountLabel: 'Delta', meterId: 'd:w', wastedValue: 99 })
    ];
    const rows = wasteBy(cycles, NOW, 90, 'USD');
    expect(rows.map((row) => row.accountLabel)).toEqual(['Alpha', 'Charlie', 'Bravo']);
    expect(rows[0]).toMatchObject({ lost: { USD: 10 }, lostIsEstimate: true, windows: 2, estimatedWindows: 1, topMeterId: 'a:w' });
    expect(rows[2]).toMatchObject({ lost: {}, creditsLost: { USD: 70 } });
    expect(wasteBy(cycles, NOW, null, 'USD')[0]?.accountLabel).toBe('Delta');
  });

  it('on the sample: the subscription that left the most plan money first, opened on its worst meter', () => {
    const { state } = sample();
    const rows = wasteBy(state.cycles, NOW, 90, 'USD');
    const lost = rows.map((row) => row.lost['USD'] ?? 0);
    expect(lost).toEqual([...lost].sort((a, b) => b - a));
    expect(rows.every((row) => row.utilisation >= 0 && row.utilisation <= 1)).toBe(true);
  });
});

describe('what needs attention', () => {
  it('lists stale readings oldest first and quotas without a reset time, never the snoozed', () => {
    let state = add(emptyState(), 'Alpha', [weekly(40, 20)], { price: USD_100 });
    state = add(state, 'Bravo', [{ label: 'Weekly limit', reset: { kind: 'interval', hours: 168 }, used: 30 }]);
    state = add(state, 'Charlie', [weekly(40, 20)]);
    state = updateAccount(state, 'charlie', { snoozedUntil: iso(NOW + 5 * DAY) }, NOW);
    const later = NOW + 3 * DAY;
    const ids = refreshList(viewState(state, later)).map((view) => view.id);
    expect(ids).toContain('alpha:weekly-limit');
    expect(ids).toContain('bravo:weekly-limit');
    expect(ids).not.toContain('charlie:weekly-limit');
  });

  it('orders never read, then no reset time, then the most overdue for how often each should be read', () => {
    const daily = { kind: 'daily', time: '00:00', tz: 'UTC' } as const;
    const monthly = { kind: 'monthly', day: 1, time: '00:00', tz: 'UTC' } as const;
    // A daily quota read 10 hours ago is further past due (stale after 4.8 hours) than a monthly one read
    // three days ago (stale after 48 hours), although its reading is younger.
    let state = addAccount(emptyState(), { label: 'Daily', meters: [{ label: 'Day', reset: daily, used: 10 }] }, NOW - 10 * HOUR).state;
    state = addAccount(state, { label: 'Monthly', meters: [{ label: 'Month', reset: monthly, used: 10 }] }, NOW - 3 * DAY).state;
    state = add(state, 'Unread', [{ label: 'Week', reset: { kind: 'interval', hours: 168 }, resetsAt: iso(NOW + 2 * DAY) }]);
    state = add(state, 'No reset', [{ label: 'Week', reset: { kind: 'interval', hours: 168 }, used: 30 }]);
    expect(refreshList(viewState(state, NOW)).map((view) => view.account.label)).toEqual(['Unread', 'No reset', 'Daily', 'Monthly']);
  });

  it('lists closed rate limits soonest first', () => {
    const { views } = sample();
    const blocked = blockedLimits(views, NOW);
    expect(blocked.length).toBeGreaterThan(0);
    expect(blocked.every((view) => view.throttle === 'blocked' && (view.resetsAtMs ?? 0) > NOW)).toBe(true);
  });
});

describe('pace', () => {
  it('counts the tiers of the quotas the chart can place, and what it leaves out', () => {
    const { views } = sample();
    const counts = countTiers(views);
    const plotted = views.filter(plottable);
    expect(counts.plotted).toBe(plotted.length);
    expect(Object.values(counts.tiers).reduce((sum, n) => sum + (n ?? 0), 0)).toBe(plotted.length);
    expect(counts.plotted + counts.unplotted + counts.snoozed).toBe(views.filter((view) => view.tier !== null).length);
  });

  it('finds when the first quota behind pace enters its use-now stretch', () => {
    const { views } = sample();
    const next = nextUseNow(views, NOW);
    expect(next).not.toBeNull();
    const expected = Math.min(...views.filter((view) => view.tier === 'behind' && !view.snoozed && view.resetsAtMs !== null && view.horizonMs !== null).map((view) => (view.resetsAtMs as number) - (view.horizonMs as number)).filter((at) => at > NOW));
    expect(next?.atMs).toBe(expected);
  });
});
