import { describe, expect, it } from 'vitest';

import {
  addAccount,
  removeAccount,
  removeMeter,
  updateAccount,
  updateMeter,
  type AccountInput,
  type MeterInput
} from '../../src/core/accounts.js';
import { briefMarkdown } from '../../src/core/brief.js';
import { cyclesOf, ledgerTotals, summarise } from '../../src/core/forecast.js';
import { MAX_CYCLES, applyReadingToState, rollState } from '../../src/core/reset.js';
import { DAY, HOUR, MINUTE, MONTH, iso } from '../../src/core/time.js';
import {
  emptyState,
  type Account,
  type ClosedCycle,
  type Meter,
  type MeterSource,
  type Price,
  type Reading,
  type ResetRule,
  type State
} from '../../src/core/types.js';

const utc = (y: number, mo: number, d: number, h = 0, mi = 0): number => Date.UTC(y, mo - 1, d, h, mi, 0);
/** Thursday 19 November 2026, 10:00 UTC. */
const NOW = utc(2026, 11, 19, 10, 0);
const WEEK = 7 * DAY;
const WEEKLY: ResetRule = { kind: 'interval', hours: 168 };
const DAILY: ResetRule = { kind: 'daily', time: '00:00', tz: 'UTC' };
const USD_100: Price = { amount: 100, currency: 'USD', period: 'month' };

function add(
  state: State,
  label: string,
  meters: MeterInput[],
  extra: Partial<AccountInput> = {},
  nowMs = NOW,
  source?: MeterSource
): State {
  return addAccount(state, { label, meters, ...extra }, nowMs, source).state;
}

function read(state: State, meterId: string, reading: Reading, nowMs: number): State {
  const accountId = meterId.slice(0, meterId.indexOf(':'));
  return applyReadingToState(state, accountId, meterId, reading, nowMs);
}

const firstMeter = (state: State): Meter => (state.accounts[0] as Account).meters[0] as Meter;

describe('finished cycles', () => {
  it('records a weekly window that closes with 70% used as 30% unused worth 6.90 USD', () => {
    // Scenario: Window closes with quota left.
    const reset = NOW + HOUR;
    let state = add(emptyState(), 'Claude Max', [{ label: 'Weekly', reset: WEEKLY, resetsAt: iso(reset) }], {
      providerId: 'claude',
      price: USD_100
    });
    state = read(state, 'claude-max:weekly', { usedPercent: 70 }, NOW);
    expect(state.cycles).toEqual([]);

    const after = rollState(state, reset + HOUR);
    expect(after.cycles).toHaveLength(1);
    const cycle = after.cycles[0] as ClosedCycle;
    expect(cycle).toMatchObject({
      accountId: 'claude-max',
      meterId: 'claude-max:weekly',
      providerId: 'claude',
      accountLabel: 'Claude Max',
      meterLabel: 'Weekly',
      unit: 'percent',
      startedAt: iso(reset - WEEK),
      endedAt: iso(reset),
      limit: 100,
      used: 70,
      currency: 'USD',
      confidence: 'measured'
    });
    expect(cycle.wastedFraction).toBeCloseTo(0.3, 12);
    expect(Math.abs((cycle.wastedValue as number) - 6.9)).toBeLessThan(0.01);
    expect(cycle.wastedValue).toBeCloseTo(100 * (WEEK / MONTH) * 0.3, 9);
    expect(typeof cycle.id).toBe('string');
    expect(cycle.id.length).toBeGreaterThan(0);
  });

  it('records the cycle when a reading, not the clock, reveals that the window ended', () => {
    let state = add(emptyState(), 'Claude Max', [{ label: 'Weekly', reset: WEEKLY, resetsAt: '2026-11-20T00:00:00Z' }], { price: USD_100 }, utc(2026, 11, 14));
    state = read(state, 'claude-max:weekly', { usedPercent: 70 }, utc(2026, 11, 19, 23, 0));
    state = read(state, 'claude-max:weekly', { usedPercent: 2 }, utc(2026, 11, 20, 9, 0));
    expect(state.cycles).toHaveLength(1);
    expect(state.cycles[0]).toMatchObject({ endedAt: '2026-11-20T00:00:00.000Z', used: 70, confidence: 'measured' });
    expect(firstMeter(state)).toMatchObject({ used: 2, estimated: false, resetsAt: '2026-11-27T00:00:00.000Z' });
  });

  it('does not record throttle windows', () => {
    // Scenario: Throttle windows are not recorded.
    let state = add(emptyState(), 'Claude Max', [
      { label: 'Session', role: 'throttle', reset: { kind: 'rolling', hours: 5 } },
      { label: 'Hourly burst', role: 'throttle', reset: { kind: 'interval', hours: 1 }, resetsAt: iso(NOW + 30 * MINUTE) }
    ]);
    state = read(state, 'claude-max:session', { usedPercent: 60 }, NOW);
    state = read(state, 'claude-max:hourly-burst', { usedPercent: 60 }, NOW);
    const after = rollState(state, NOW + 6 * HOUR);
    expect(after.cycles).toEqual([]);
    expect(after.accounts[0]?.meters[0]).toMatchObject({ resetsAt: null, used: 0 });
  });

  it('does not record a hand-kept meter for a window in which nobody typed', () => {
    // Scenario: Hand-kept meter with no reading in the window.
    let state = add(emptyState(), 'Copilot', [{ label: 'Daily', unit: 'requests', limit: 50, reset: DAILY }]);
    state = read(state, 'copilot:daily', { used: 20 }, NOW);
    expect(firstMeter(state).source.kind).toBe('manual');

    state = rollState(state, utc(2026, 11, 20, 6, 0));
    expect(state.cycles).toHaveLength(1); // the window that was read
    expect(firstMeter(state).estimated).toBe(true);

    state = rollState(state, utc(2026, 11, 21, 6, 0));
    state = rollState(state, utc(2026, 11, 22, 6, 0));
    expect(state.cycles).toHaveLength(1);
    expect(state.cycles[0]).toMatchObject({ endedAt: '2026-11-20T00:00:00.000Z', used: 20 });

    // A reading in a later window makes that window count again.
    state = read(state, 'copilot:daily', { used: 45 }, utc(2026, 11, 22, 23, 0));
    state = rollState(state, utc(2026, 11, 23, 6, 0));
    expect(state.cycles.map((cycle) => [cycle.endedAt, cycle.used])).toEqual([
      ['2026-11-20T00:00:00.000Z', 20],
      ['2026-11-23T00:00:00.000Z', 45]
    ]);
  });

  it('treats agent-reported meters like hand-kept ones', () => {
    let state = add(emptyState(), 'Suno', [{ label: 'Daily', unit: 'credits', limit: 50, reset: DAILY }]);
    state = read(state, 'suno:daily', { used: 20, source: { kind: 'agent', id: 'claude-code' } }, NOW);
    state = rollState(state, utc(2026, 11, 20, 6, 0));
    state = rollState(state, utc(2026, 11, 21, 6, 0));
    expect(state.cycles).toHaveLength(1);
  });

  it.each([
    ['a collector', { kind: 'collector', id: 'fake-api' }],
    ['the status line', { kind: 'statusline', id: 'claude-statusline' }]
  ] as [string, MeterSource][])('records a silent window as fully unused and estimated when %s feeds the meter', (_name, source) => {
    // Scenario: Automatic source with no reading in the window.
    let state = add(emptyState(), 'Claude Max', [{ label: 'Daily', unit: 'requests', limit: 50, reset: DAILY }], { price: USD_100 });
    state = read(state, 'claude-max:daily', { used: 20, source }, utc(2026, 11, 19, 23, 30));

    state = rollState(state, utc(2026, 11, 20, 6, 0));
    expect(state.cycles).toHaveLength(1);
    expect(state.cycles[0]).toMatchObject({ used: 20, confidence: 'measured' });

    // Nothing arrives during the window of the 20th.
    state = rollState(state, utc(2026, 11, 21, 6, 0));
    expect(state.cycles).toHaveLength(2);
    const silent = state.cycles[1] as ClosedCycle;
    expect(silent).toMatchObject({
      startedAt: '2026-11-20T00:00:00.000Z',
      endedAt: '2026-11-21T00:00:00.000Z',
      used: 0,
      wastedFraction: 1,
      confidence: 'estimated',
      currency: 'USD'
    });
    expect(silent.wastedValue).toBeCloseTo(100 * (DAY / MONTH), 9);
  });

  it('never records a meter that has had no reading at all', () => {
    // Scenario: Never-read meters are not recorded.
    for (const source of [{ kind: 'manual' }, { kind: 'collector', id: 'fake-api' }] as MeterSource[]) {
      let state = add(
        emptyState(),
        'Claude Max',
        [
          { label: 'Weekly', reset: WEEKLY, resetsAt: iso(NOW + HOUR) },
          { label: 'Daily', unit: 'requests', limit: 50, reset: DAILY }
        ],
        { price: USD_100 },
        NOW,
        source
      );
      expect(firstMeter(state).updatedAt).toBeNull();
      for (let day = 1; day <= 30; day += 1) state = rollState(state, NOW + day * DAY);
      expect(state.cycles).toEqual([]);
    }
  });

  it('records only the first window when several pass unobserved, even for an automatic source', () => {
    let state = add(emptyState(), 'Claude Max', [{ label: 'Daily', unit: 'requests', limit: 50, reset: DAILY }]);
    state = read(state, 'claude-max:daily', { used: 20, source: { kind: 'collector', id: 'fake-api' } }, NOW);
    state = rollState(state, utc(2026, 11, 25, 6, 0));
    expect(state.cycles).toHaveLength(1);
    expect(state.cycles[0]).toMatchObject({ endedAt: '2026-11-20T00:00:00.000Z', used: 20 });
    expect(firstMeter(state)).toMatchObject({ windowStartedAt: '2026-11-25T00:00:00.000Z', resetsAt: '2026-11-26T00:00:00.000Z' });
  });

  it('does not invent a fully wasted window when the provider resets a little before the rule says', () => {
    // A collector-fed monthly meter whose provider resets at 20:00 on the 11th; the rule says the 12th.
    const source: MeterSource = { kind: 'collector', id: 'fake-api' };
    let state = add(emptyState(), 'Suno Pro', [{ label: 'Monthly credits', unit: 'credits', limit: 2500, reset: { kind: 'monthly', day: 12, time: '00:00', tz: 'UTC' } }], {
      price: { amount: 10, currency: 'USD', period: 'month' }
    });
    state = read(state, 'suno-pro:monthly-credits', { remaining: 1200, resetsAt: '2026-12-11T20:00:00Z', source }, utc(2026, 12, 11, 19, 0));
    // The service looks at the state between the provider's reset and the rule's boundary, and again after it.
    state = rollState(state, utc(2026, 12, 11, 21, 0));
    state = rollState(state, utc(2026, 12, 12, 1, 0));
    expect(state.cycles).toHaveLength(1);
    expect(state.cycles[0]).toMatchObject({ endedAt: '2026-12-11T20:00:00.000Z', used: 1300, confidence: 'measured' });
    expect(ledgerTotals(state.cycles, utc(2026, 12, 12, 1, 0)).utilisation30).toBeCloseTo(0.52, 9);
  });

  it('records a one-off expiry once, with what was paid for the unused share', () => {
    const expiry = NOW + 10 * DAY;
    let state = add(
      emptyState(),
      'Credit pack',
      [{ label: 'Credits', unit: 'credits', limit: 1000, used: 600, reset: { kind: 'once' }, resetsAt: iso(expiry) }],
      { price: { amount: 50, currency: 'USD', period: 'month' } }
    );
    state = rollState(state, expiry + HOUR);
    state = rollState(state, expiry + 40 * DAY);
    expect(state.cycles).toHaveLength(1);
    const cycle = state.cycles[0] as ClosedCycle;
    expect(cycle).toMatchObject({ endedAt: iso(expiry), used: 600, limit: 1000, currency: 'USD' });
    expect(cycle.wastedFraction).toBeCloseTo(0.4, 12);
    expect(cycle.wastedValue).toBeCloseTo(20, 9);
    expect(firstMeter(state).expired).toBe(true);
  });

  it('values a one-off expiry the same whether or not a reading arrived before it', () => {
    const expiry = NOW + 10 * DAY;
    let state = add(
      emptyState(),
      'Credit pack',
      [{ label: 'Credits', unit: 'credits', limit: 1000, reset: { kind: 'once' }, resetsAt: iso(expiry) }],
      { price: { amount: 50, currency: 'USD', period: 'month' } }
    );
    state = read(state, 'credit-pack:credits', { used: 600 }, NOW + DAY);
    state = rollState(state, expiry + HOUR);
    expect(state.cycles).toHaveLength(1);
    expect(state.cycles[0]?.wastedValue).toBeCloseTo(20, 9);
  });

  it('records quota that carries over as nothing wasted', () => {
    let state = add(emptyState(), 'ElevenLabs', [{ label: 'Characters', unit: 'characters', limit: 100_000, reset: WEEKLY, resetsAt: iso(NOW + HOUR), rollover: 'carries' }], {
      price: USD_100
    });
    state = read(state, 'elevenlabs:characters', { used: 20_000 }, NOW);
    state = rollState(state, NOW + 2 * HOUR);
    expect(state.cycles).toHaveLength(1);
    expect(state.cycles[0]).toMatchObject({ used: 20_000, wastedFraction: 0, wastedValue: 0 });
    expect(summarise(state, NOW + 2 * HOUR).lost30).toEqual({});
  });

  it('has no money on a cycle of an account without a price', () => {
    let state = add(emptyState(), 'Free tier', [{ label: 'Weekly', reset: WEEKLY, resetsAt: iso(NOW + HOUR) }]);
    state = read(state, 'free-tier:weekly', { usedPercent: 70 }, NOW);
    state = rollState(state, NOW + 2 * HOUR);
    expect(state.cycles[0]).toMatchObject({ wastedValue: null, currency: null });
    expect(state.cycles[0]?.wastedFraction).toBeCloseTo(0.3, 12);
    const totals = ledgerTotals(state.cycles, NOW + 2 * HOUR);
    expect(totals.lost30).toEqual({});
    expect(totals.cycles30).toBe(1);
    expect(totals.utilisation30).toBeCloseTo(0.7, 12);
  });

  it('counts usage beyond the limit as fully used, never as negative waste', () => {
    let state = add(emptyState(), 'Copilot', [{ label: 'Daily', unit: 'requests', limit: 50, reset: DAILY }]);
    state = read(state, 'copilot:daily', { used: 80 }, utc(2026, 11, 19, 23, 0));
    state = rollState(state, utc(2026, 11, 20, 1, 0));
    expect(state.cycles[0]).toMatchObject({ used: 50, limit: 50, wastedFraction: 0 });
  });

  it('gives every cycle its own id', () => {
    let state = add(emptyState(), 'A', [{ label: 'Daily', unit: 'requests', limit: 50, reset: DAILY }, { label: 'Other', unit: 'requests', limit: 50, reset: DAILY, valueShare: 1 }]);
    for (let day = 19; day <= 24; day += 1) {
      state = read(state, 'a:daily', { used: day }, utc(2026, 11, day, 23, 0));
      state = read(state, 'a:other', { used: day }, utc(2026, 11, day, 23, 0));
    }
    state = rollState(state, utc(2026, 11, 25, 1, 0));
    expect(state.cycles).toHaveLength(12);
    expect(new Set(state.cycles.map((cycle) => cycle.id)).size).toBe(12);
  });
});

describe('confidence', () => {
  function weeklyReadBeforeReset(gapMs: number): ClosedCycle {
    const reset = utc(2026, 11, 20);
    let state = add(emptyState(), 'Claude Max', [{ label: 'Weekly', reset: WEEKLY, resetsAt: iso(reset) }], { price: USD_100 }, reset - 6 * DAY);
    state = read(state, 'claude-max:weekly', { usedPercent: 50 }, reset - gapMs);
    state = rollState(state, reset + MINUTE);
    expect(state.cycles).toHaveLength(1);
    return state.cycles[0] as ClosedCycle;
  }

  it('is measured when the meter was read one hour before it reset', () => {
    // Scenario: Reading shortly before the reset.
    expect(weeklyReadBeforeReset(HOUR).confidence).toBe('measured');
  });

  it('is estimated when the meter was last read four days before it reset', () => {
    // Scenario: Reading days before the reset.
    const cycle = weeklyReadBeforeReset(4 * DAY);
    expect(cycle.confidence).toBe('estimated');
    expect(cycle.used).toBe(50); // still the last known usage
  });

  it('turns at the staleness limit of the window', () => {
    // 20% of a week is 33.6 hours.
    expect(weeklyReadBeforeReset(33 * HOUR).confidence).toBe('measured');
    expect(weeklyReadBeforeReset(34 * HOUR).confidence).toBe('estimated');
  });

  it('marks totals that include estimated money as approximate', () => {
    let state = add(emptyState(), 'Claude Max', [{ label: 'Weekly', reset: WEEKLY, resetsAt: '2026-11-20T00:00:00Z' }], { price: USD_100 }, utc(2026, 11, 14));
    state = read(state, 'claude-max:weekly', { usedPercent: 50 }, utc(2026, 11, 16));
    const later = utc(2026, 11, 20, 1, 0);
    state = rollState(state, later);
    expect(state.cycles[0]?.confidence).toBe('estimated');
    expect(summarise(state, later).lostIsEstimate).toBe(true);
    expect(briefMarkdown(state, later, 'UTC')).toContain('Expired unused in the last 30 days: about $11.50.');

    let measured = add(emptyState(), 'Claude Max', [{ label: 'Weekly', reset: WEEKLY, resetsAt: '2026-11-20T00:00:00Z' }], { price: USD_100 }, utc(2026, 11, 14));
    measured = read(measured, 'claude-max:weekly', { usedPercent: 50 }, utc(2026, 11, 19, 23, 0));
    measured = rollState(measured, later);
    expect(summarise(measured, later).lostIsEstimate).toBe(false);
    expect(briefMarkdown(measured, later, 'UTC')).toContain('Expired unused in the last 30 days: $11.50.');
  });
});

describe('totals', () => {
  /** A daily 20-dollar allowance: each cycle's lost money is simply the dollars left that day. */
  function dollars(): State {
    let state = add(emptyState(), 'API credits', [{ label: 'Daily credit', unit: 'usd', limit: 20, reset: DAILY }], {}, utc(2026, 10, 4, 12, 0));
    const id = 'api-credits:daily-credit';
    state = read(state, id, { used: 0 }, utc(2026, 10, 4, 20, 0)); // closes 5 October, 45 days before NOW: 20 lost
    state = read(state, id, { used: 16 }, utc(2026, 11, 9, 20, 0)); // closes 10 November: 4 lost
    state = read(state, id, { used: 14 }, utc(2026, 11, 13, 20, 0)); // closes 14 November: 6 lost
    state = read(state, id, { used: 10 }, utc(2026, 11, 17, 20, 0)); // closes 18 November: 10 lost
    return rollState(state, NOW);
  }

  it('adds up 4 + 6 + 10 USD from the last 30 days and leaves out 20 USD from 45 days ago', () => {
    // Scenario: Trailing total.
    const state = dollars();
    expect(state.cycles.map((cycle) => [cycle.endedAt.slice(0, 10), Math.round((cycle.wastedValue as number) * 100) / 100])).toEqual([
      ['2026-10-05', 20],
      ['2026-11-10', 4],
      ['2026-11-14', 6],
      ['2026-11-18', 10]
    ]);
    const totals = ledgerTotals(state.cycles, NOW);
    // A meter counted in dollars is a credit at face value, so its losses are totalled as credits.
    expect(Object.keys(totals.creditsLost30)).toEqual(['USD']);
    expect(totals.creditsLost30['USD']).toBeCloseTo(20, 9);
    expect(totals.lost30).toEqual({});
    expect(totals.cycles30).toBe(3);
    expect(totals.lostIsEstimate).toBe(false);
    expect(summarise(state, NOW).creditsLost30['USD']).toBeCloseTo(20, 9);
  });

  it('totals plan money and dollar credits separately', () => {
    let state = dollars();
    state = add(state, 'Claude Max', [{ label: 'Weekly', reset: WEEKLY, resetsAt: '2026-11-17T00:00:00Z' }], { price: USD_100 }, utc(2026, 11, 11));
    state = read(state, 'claude-max:weekly', { usedPercent: 50 }, utc(2026, 11, 16, 23, 0));
    state = rollState(state, NOW);
    const totals = ledgerTotals(state.cycles, NOW);
    expect(totals.lost30['USD']).toBeCloseTo(11.5, 1);
    expect(totals.creditsLost30['USD']).toBeCloseTo(20, 9);
    expect(briefMarkdown(state, NOW, 'UTC')).toContain('Expired unused in the last 30 days: $11.50, plus $20.00 in credits.');
  });

  it('averages utilisation over the same 30 days', () => {
    const totals = ledgerTotals(dollars().cycles, NOW);
    expect(totals.utilisation30).toBeCloseTo((0.8 + 0.7 + 0.5) / 3, 9);
  });

  it('moves the window with the clock', () => {
    const state = dollars();
    // Sixteen days later the cycles of 10 and 14 November are still inside, 31 days later none is.
    expect(ledgerTotals(state.cycles, NOW + 16 * DAY).creditsLost30['USD']).toBeCloseTo(20, 9);
    expect(ledgerTotals(state.cycles, utc(2026, 12, 12)).creditsLost30['USD']).toBeCloseTo(16, 9);
    expect(ledgerTotals(state.cycles, utc(2026, 12, 16)).creditsLost30['USD']).toBeCloseTo(10, 9);
    expect(ledgerTotals(state.cycles, utc(2026, 12, 19))).toEqual({ lost30: {}, creditsLost30: {}, utilisation30: null, cycles30: 0, lostIsEstimate: false });
    // A different span can be asked for.
    expect(ledgerTotals(state.cycles, NOW, 60).creditsLost30['USD']).toBeCloseTo(40, 9);
    expect(ledgerTotals(state.cycles, NOW, 7).creditsLost30['USD']).toBeCloseTo(16, 9);
    expect(ledgerTotals(state.cycles, NOW, 3).creditsLost30['USD']).toBeCloseTo(10, 9);
  });

  it('keeps currencies apart', () => {
    let state = add(emptyState(), 'Claude Max', [{ label: 'Weekly', reset: WEEKLY, resetsAt: iso(NOW + HOUR) }], { price: USD_100 });
    state = add(state, 'Nordic plan', [{ label: 'Weekly', reset: WEEKLY, resetsAt: iso(NOW + HOUR) }], { price: { amount: 249, currency: 'SEK', period: 'month' } });
    state = add(state, 'Free tier', [{ label: 'Weekly', reset: WEEKLY, resetsAt: iso(NOW + HOUR) }]);
    state = read(state, 'claude-max:weekly', { usedPercent: 70 }, NOW);
    state = read(state, 'nordic-plan:weekly', { usedPercent: 50 }, NOW);
    state = read(state, 'free-tier:weekly', { usedPercent: 10 }, NOW);
    const later = NOW + 2 * HOUR;
    state = rollState(state, later);
    const summary = summarise(state, later);
    expect(Object.keys(summary.lost30).sort()).toEqual(['SEK', 'USD']);
    expect(Math.abs((summary.lost30['USD'] as number) - 6.9)).toBeLessThan(0.01);
    expect(summary.lost30['SEK']).toBeCloseTo(249 * (WEEK / MONTH) * 0.5, 6);
    expect(summary.cycles30).toBe(3);
    expect(summary.utilisation30).toBeCloseTo((0.7 + 0.5 + 0.1) / 3, 9);
  });

  it('ignores a cycle whose end still lies ahead', () => {
    // A provider that reports a later reset closes the stored window before its own end has come.
    let state = add(emptyState(), 'Claude Max', [{ label: 'Weekly', reset: WEEKLY, resetsAt: '2026-11-20T00:00:00Z' }], { price: USD_100 }, utc(2026, 11, 14));
    state = read(state, 'claude-max:weekly', { usedPercent: 55 }, utc(2026, 11, 19, 6, 0));
    state = read(state, 'claude-max:weekly', { usedPercent: 4, resetsAt: '2026-11-27T00:00:00Z' }, NOW);
    expect(state.cycles).toHaveLength(1);
    expect(ledgerTotals(state.cycles, NOW).cycles30).toBe(0);
    expect(ledgerTotals(state.cycles, utc(2026, 11, 20, 1, 0)).cycles30).toBe(1);
  });

  it('lists the recent cycles of one meter in order', () => {
    let state = add(
      emptyState(),
      'A',
      [
        { label: 'Daily', unit: 'requests', limit: 50, reset: DAILY },
        { label: 'Other', unit: 'requests', limit: 50, reset: DAILY }
      ],
      {},
      utc(2026, 11, 1, 12, 0)
    );
    for (let day = 1; day <= 18; day += 1) {
      state = read(state, 'a:daily', { used: day }, utc(2026, 11, day, 23, 0));
      if (day % 2 === 0) state = read(state, 'a:other', { used: 50 - day }, utc(2026, 11, day, 23, 0));
    }
    state = rollState(state, NOW);
    const own = cyclesOf(state, 'a:daily');
    expect(own).toHaveLength(12);
    expect(own.every((cycle) => cycle.meterId === 'a:daily')).toBe(true);
    expect(own.map((cycle) => cycle.used)).toEqual([7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
    const ends = own.map((cycle) => cycle.endedAt);
    expect(ends).toEqual(ends.slice().sort());
    expect(cyclesOf(state, 'a:daily', 3).map((cycle) => cycle.used)).toEqual([16, 17, 18]);
    expect(cyclesOf(state, 'a:other')).toHaveLength(9);
    expect(cyclesOf(state, 'a:nothing')).toEqual([]);
  });
});

describe('bounded history', () => {
  function cycle(n: number, endedAtMs: number): ClosedCycle {
    return {
      id: `old:meter:${n}`,
      accountId: 'old',
      meterId: 'old:meter',
      providerId: 'custom',
      accountLabel: 'Old account',
      meterLabel: 'Old meter',
      unit: 'percent',
      startedAt: iso(endedAtMs - DAY),
      endedAt: iso(endedAtMs),
      limit: 100,
      used: 50,
      wastedFraction: 0.5,
      wastedValue: 1,
      currency: 'USD',
      confidence: 'measured'
    };
  }

  it('keeps the 2,000 most recent cycles', () => {
    expect(MAX_CYCLES).toBe(2000);
    const start = utc(2020, 1, 1);
    // An unusual shape built by hand: a ledger that is already full.
    const full: ClosedCycle[] = Array.from({ length: MAX_CYCLES }, (_, n) => cycle(n, start + n * DAY));
    let state: State = { ...emptyState(), cycles: full };
    state = add(state, 'Claude Max', [{ label: 'Weekly', reset: WEEKLY, resetsAt: iso(NOW + HOUR) }], { price: USD_100 });
    state = read(state, 'claude-max:weekly', { usedPercent: 70 }, NOW);
    expect(state.cycles).toHaveLength(MAX_CYCLES);

    state = rollState(state, NOW + 2 * HOUR);
    expect(state.cycles).toHaveLength(MAX_CYCLES);
    expect(state.cycles[state.cycles.length - 1]).toMatchObject({ meterId: 'claude-max:weekly', endedAt: iso(NOW + HOUR) });
    expect(state.cycles[0]?.id).toBe('old:meter:1'); // the oldest one made room
    expect(state.cycles.some((entry) => entry.id === 'old:meter:0')).toBe(false);

    // The same bound holds when a reading closes the window.
    state = read(state, 'claude-max:weekly', { usedPercent: 10 }, NOW + 3 * HOUR);
    state = read(state, 'claude-max:weekly', { usedPercent: 1 }, NOW + HOUR + WEEK + MINUTE);
    expect(state.cycles).toHaveLength(MAX_CYCLES);
    expect(state.cycles[0]?.id).toBe('old:meter:2');
    expect(state.cycles[state.cycles.length - 1]).toMatchObject({ meterId: 'claude-max:weekly', used: 10 });
  });

  it('keeps the cycles of a deleted account under the names they had', () => {
    // Scenario: Account deleted.
    let state = add(emptyState(), 'Claude Max', [{ label: 'Weekly', reset: WEEKLY, resetsAt: iso(NOW + HOUR) }], { price: USD_100 });
    state = add(state, 'Copilot', [{ label: 'Daily', unit: 'requests', limit: 50, reset: DAILY }]);
    state = read(state, 'claude-max:weekly', { usedPercent: 70 }, NOW);
    state = rollState(state, NOW + 2 * HOUR);
    const before = state.cycles;
    expect(before).toHaveLength(1);

    state = removeAccount(state, 'claude-max');
    expect(state.accounts.map((account) => account.id)).toEqual(['copilot']);
    expect(state.cycles).toEqual(before);
    expect(state.cycles[0]).toMatchObject({ accountLabel: 'Claude Max', meterLabel: 'Weekly', accountId: 'claude-max' });
    expect(Math.abs((summarise(state, NOW + 2 * HOUR).lost30['USD'] as number) - 6.9)).toBeLessThan(0.01);
    // Later rolls do not disturb them either.
    expect(rollState(state, NOW + 5 * DAY).cycles).toEqual(before);
  });

  it('keeps the cycles of a deleted meter', () => {
    let state = add(emptyState(), 'Claude Max', [
      { label: 'Weekly', reset: WEEKLY, resetsAt: iso(NOW + HOUR) },
      { label: 'Opus', reset: WEEKLY, resetsAt: iso(NOW + HOUR), valueShare: 0.5 }
    ], { price: USD_100 });
    state = read(state, 'claude-max:opus', { usedPercent: 20 }, NOW);
    state = rollState(state, NOW + 2 * HOUR);
    expect(state.cycles).toHaveLength(1);
    state = removeMeter(state, 'claude-max:opus', NOW + 3 * HOUR);
    expect(state.cycles).toHaveLength(1);
    expect(state.cycles[0]).toMatchObject({ meterId: 'claude-max:opus', meterLabel: 'Opus' });
    expect(cyclesOf(state, 'claude-max:opus')).toHaveLength(1);
  });

  it('keeps old names on old cycles after a rename and uses the new names from then on', () => {
    let state = add(emptyState(), 'Claude Max', [{ label: 'Weekly', reset: WEEKLY, resetsAt: iso(NOW + HOUR) }], { price: USD_100 });
    state = read(state, 'claude-max:weekly', { usedPercent: 70 }, NOW);
    state = rollState(state, NOW + 2 * HOUR);
    state = updateAccount(state, 'claude-max', { label: 'Claude Max 20x' }, NOW + 3 * HOUR);
    state = updateMeter(state, 'claude-max:weekly', { label: 'All models' }, NOW + 3 * HOUR);
    state = read(state, 'claude-max:weekly', { usedPercent: 40 }, NOW + 4 * HOUR);
    state = rollState(state, NOW + HOUR + WEEK + MINUTE);
    expect(state.cycles.map((entry) => [entry.accountLabel, entry.meterLabel, entry.meterId])).toEqual([
      ['Claude Max', 'Weekly', 'claude-max:weekly'],
      ['Claude Max 20x', 'All models', 'claude-max:weekly']
    ]);
    expect(cyclesOf(state, 'claude-max:weekly')).toHaveLength(2);
  });
});
