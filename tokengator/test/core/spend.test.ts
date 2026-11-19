import { describe, expect, it } from 'vitest';

import { NotFoundError, ValidationError, addAccount } from '../../src/core/accounts.js';
import { briefMarkdown, costsMarkdown, snapshot } from '../../src/core/brief.js';
import { summarise, viewState } from '../../src/core/forecast.js';
import { applyReadingToState, rollState } from '../../src/core/reset.js';
import {
  MAX_SPEND_DAYS,
  addSpendSource,
  recordSpend,
  removeSpendSource,
  summariseSpend,
  updateSpendSource
} from '../../src/core/spend.js';
import { DAY, HOUR, iso } from '../../src/core/time.js';
import { summaryLine } from '../../src/core/wording.js';
import { emptyState, type SpendSource, type State } from '../../src/core/types.js';

const utc = (y: number, mo: number, d: number, h = 0, mi = 0): number => Date.UTC(y, mo - 1, d, h, mi, 0);
/** Thursday 19 November 2026, 10:00 UTC. */
const NOW = utc(2026, 11, 19, 10, 0);

function withSource(budget: number | null = 50): State {
  return addSpendSource(emptyState(), { label: 'OpenAI API', providerId: 'openai', currency: 'USD', monthlyBudget: budget }, NOW).state;
}

const sourceOf = (state: State, id = 'openai-api'): SpendSource => state.spend.find((source) => source.id === id) as SpendSource;

function expectValidation(run: () => unknown, field: string): void {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ValidationError);
  expect((caught as ValidationError).field).toBe(field);
}

describe('spend sources', () => {
  it('adds "OpenAI API" in USD with a budget of 50 as 0 spent of 50', () => {
    // Scenario: Add a source with a budget.
    const { state, source } = addSpendSource(emptyState(), { label: 'OpenAI API', providerId: 'openai', currency: 'USD', monthlyBudget: 50 }, NOW);
    expect(state.spend).toEqual([source]);
    expect(source).toEqual({
      id: 'openai-api',
      providerId: 'openai',
      label: 'OpenAI API',
      currency: 'USD',
      monthlyBudget: 50,
      entries: [],
      source: { kind: 'manual' },
      updatedAt: iso(NOW)
    });
    const summary = summariseSpend(source, NOW, 'UTC');
    expect(summary.monthToDate).toBe(0);
    expect(summary.source.monthlyBudget).toBe(50);
    expect(summary.budgetFraction).toBe(0);
    expect(summary.projected).toBe(0);
    expect(summary.overBudget).toBe(false);
    expect(summary.headingOver).toBe(false);
    expect(costsMarkdown(state, NOW, 'UTC')).toContain('| OpenAI API | $0.00 | $0.00 | $50.00 |');
  });

  it('works normally when there are none', () => {
    // Scenario: No sources.
    const state = addAccount(emptyState(), { label: 'Claude', meters: [{ label: 'Weekly', reset: { kind: 'interval', hours: 168 }, used: 20, resetsAt: iso(NOW + DAY) }] }, NOW).state;
    expect(state.spend).toEqual([]);
    expect(costsMarkdown(state, NOW, 'UTC')).toBe('No API spend sources are tracked.');
    expect(summarise(state, NOW).useNow).toBe(1);
    expect(() => briefMarkdown(state, NOW, 'UTC')).not.toThrow();
    expect(() => snapshot(state, NOW, 'UTC')).not.toThrow();
  });

  it('defaults to USD, no budget and a custom provider', () => {
    const { source } = addSpendSource(emptyState(), { label: '  Misc  ' }, NOW);
    expect(source).toMatchObject({ id: 'misc', label: 'Misc', currency: 'USD', monthlyBudget: null, providerId: 'custom' });
    expect(addSpendSource(emptyState(), { label: 'Zero', monthlyBudget: 0 }, NOW).source.monthlyBudget).toBeNull();
    expect(addSpendSource(emptyState(), { label: 'Kronor', currency: 'sek' }, NOW).source.currency).toBe('SEK');
  });

  it('gives sources with the same name different ids', () => {
    let state = emptyState();
    for (let n = 0; n < 3; n += 1) state = addSpendSource(state, { label: 'OpenAI API' }, NOW).state;
    expect(state.spend.map((source) => source.id)).toEqual(['openai-api', 'openai-api-2', 'openai-api-3']);
  });

  it('records which collector feeds it', () => {
    const { source } = addSpendSource(emptyState(), { label: 'Anthropic API' }, NOW, { kind: 'collector', id: 'anthropic-costs' });
    expect(source.source).toEqual({ kind: 'collector', id: 'anthropic-costs' });
  });

  it('rejects bad input, naming the field', () => {
    expectValidation(() => addSpendSource(emptyState(), { label: '' }, NOW), 'label');
    expectValidation(() => addSpendSource(emptyState(), { label: 'x'.repeat(61) }, NOW), 'label');
    expectValidation(() => addSpendSource(emptyState(), { label: 'A', currency: 'dollars' }, NOW), 'currency');
    expectValidation(() => addSpendSource(emptyState(), { label: 'A', monthlyBudget: -5 }, NOW), 'monthlyBudget');
    expectValidation(() => addSpendSource(emptyState(), { label: 'A', monthlyBudget: '50' as never }, NOW), 'monthlyBudget');
    let full = emptyState();
    for (let n = 0; n < 50; n += 1) full = addSpendSource(full, { label: `Source ${n}` }, NOW).state;
    expectValidation(() => addSpendSource(full, { label: 'One too many' }, NOW), 'spend');
  });

  it('updates and removes a source', () => {
    let state = recordSpend(withSource(), 'openai-api', { date: '2026-11-18', amount: 2 }, NOW, 'UTC');
    state = updateSpendSource(state, 'openai-api', { label: 'OpenAI (work)', currency: 'eur', monthlyBudget: 80 });
    expect(sourceOf(state)).toMatchObject({ id: 'openai-api', label: 'OpenAI (work)', currency: 'EUR', monthlyBudget: 80, entries: [{ date: '2026-11-18', amount: 2 }] });
    state = updateSpendSource(state, 'openai-api', { monthlyBudget: null });
    expect(sourceOf(state).monthlyBudget).toBeNull();
    expect(sourceOf(state).label).toBe('OpenAI (work)');

    expectValidation(() => updateSpendSource(state, 'openai-api', { label: ' ' }), 'label');
    expectValidation(() => updateSpendSource(state, 'openai-api', { currency: 'x' }), 'currency');
    expectValidation(() => updateSpendSource(state, 'openai-api', { monthlyBudget: -1 }), 'monthlyBudget');
    expect(() => updateSpendSource(state, 'nope', { label: 'X' })).toThrow(NotFoundError);
    expect(() => removeSpendSource(state, 'nope')).toThrow(NotFoundError);
    expect(() => recordSpend(state, 'nope', { amount: 1 }, NOW, 'UTC')).toThrow(NotFoundError);
    expect(removeSpendSource(state, 'openai-api').spend).toEqual([]);
  });
});

describe('daily entries', () => {
  it('sets a day to 3.40 when it already has 2.10', () => {
    // Scenario: Set a day's total.
    let state = recordSpend(withSource(), 'openai-api', { date: '2026-11-18', amount: 2.1 }, NOW, 'UTC');
    state = recordSpend(state, 'openai-api', { date: '2026-11-18', amount: 3.4 }, NOW, 'UTC');
    expect(sourceOf(state).entries).toEqual([{ date: '2026-11-18', amount: 3.4 }]);
    // "set" is the default and can be said out loud.
    state = recordSpend(state, 'openai-api', { date: '2026-11-18', amount: 1.5, mode: 'set' }, NOW, 'UTC');
    expect(sourceOf(state).entries).toEqual([{ date: '2026-11-18', amount: 1.5 }]);
  });

  it('adds 1.25 to a day that has 2.10, making 3.35', () => {
    // Scenario: Add to a day.
    let state = recordSpend(withSource(), 'openai-api', { date: '2026-11-18', amount: 2.1 }, NOW, 'UTC');
    state = recordSpend(state, 'openai-api', { date: '2026-11-18', amount: 1.25, mode: 'add' }, NOW, 'UTC');
    expect(sourceOf(state).entries).toHaveLength(1);
    expect(sourceOf(state).entries[0]?.date).toBe('2026-11-18');
    expect(sourceOf(state).entries[0]?.amount).toBeCloseTo(3.35, 10);
  });

  it('starts a day from nothing when adding to a day without a total', () => {
    const state = recordSpend(withSource(), 'openai-api', { date: '2026-11-18', amount: 1.25, mode: 'add' }, NOW, 'UTC');
    expect(sourceOf(state).entries).toEqual([{ date: '2026-11-18', amount: 1.25 }]);
  });

  it('keeps one total per calendar day, in date order, whatever order they arrive in', () => {
    let state = withSource();
    for (const [date, amount] of [['2026-11-18', 3], ['2026-11-02', 1], ['2026-11-10', 2], ['2026-11-02', 5], ['2026-10-30', 4]] as [string, number][]) {
      state = recordSpend(state, 'openai-api', { date, amount }, NOW, 'UTC');
    }
    expect(sourceOf(state).entries).toEqual([
      { date: '2026-10-30', amount: 4 },
      { date: '2026-11-02', amount: 5 },
      { date: '2026-11-10', amount: 2 },
      { date: '2026-11-18', amount: 3 }
    ]);
  });

  it('uses today in the given zone when no date is given', () => {
    const lateEvening = utc(2026, 11, 19, 23, 30);
    expect(sourceOf(recordSpend(withSource(), 'openai-api', { amount: 1 }, lateEvening, 'UTC')).entries[0]?.date).toBe('2026-11-19');
    expect(sourceOf(recordSpend(withSource(), 'openai-api', { amount: 1 }, lateEvening, 'Europe/Stockholm')).entries[0]?.date).toBe('2026-11-20');
    expect(sourceOf(recordSpend(withSource(), 'openai-api', { amount: 1 }, utc(2026, 11, 19, 3, 0), 'America/Los_Angeles')).entries[0]?.date).toBe('2026-11-18');
  });

  it('keeps sources apart', () => {
    let state = addSpendSource(withSource(), { label: 'Anthropic API' }, NOW).state;
    state = recordSpend(state, 'openai-api', { date: '2026-11-18', amount: 2 }, NOW, 'UTC');
    state = recordSpend(state, 'anthropic-api', { date: '2026-11-18', amount: 7 }, NOW, 'UTC');
    expect(sourceOf(state, 'openai-api').entries).toEqual([{ date: '2026-11-18', amount: 2 }]);
    expect(sourceOf(state, 'anthropic-api').entries).toEqual([{ date: '2026-11-18', amount: 7 }]);
  });

  it('keeps at most the most recent 400 days', () => {
    expect(MAX_SPEND_DAYS).toBe(400);
    let state = withSource();
    const first = utc(2025, 6, 1);
    for (let n = 0; n < 450; n += 1) {
      state = recordSpend(state, 'openai-api', { date: iso(first + n * DAY).slice(0, 10), amount: n }, NOW, 'UTC');
    }
    const entries = sourceOf(state).entries;
    expect(entries).toHaveLength(400);
    expect(entries[0]).toEqual({ date: iso(first + 50 * DAY).slice(0, 10), amount: 50 });
    expect(entries[399]).toEqual({ date: iso(first + 449 * DAY).slice(0, 10), amount: 449 });
    // A late entry for a day older than everything kept does not push out a recent one.
    state = recordSpend(state, 'openai-api', { date: '2020-01-01', amount: 9 }, NOW, 'UTC');
    expect(sourceOf(state).entries).toHaveLength(400);
    expect(sourceOf(state).entries[0]?.date).toBe(iso(first + 50 * DAY).slice(0, 10));
    expect(sourceOf(state).entries[399]?.amount).toBe(449);
  });

  it('records when and through what the entry arrived', () => {
    const state = recordSpend(withSource(), 'openai-api', { date: '2026-11-18', amount: 2 }, NOW + HOUR, 'UTC', { kind: 'collector', id: 'openai-costs' });
    expect(sourceOf(state)).toMatchObject({ updatedAt: iso(NOW + HOUR), source: { kind: 'collector', id: 'openai-costs' } });
    const manual = recordSpend(state, 'openai-api', { date: '2026-11-19', amount: 2 }, NOW + 2 * HOUR, 'UTC');
    expect(sourceOf(manual).source).toEqual({ kind: 'collector', id: 'openai-costs' });
  });

  it('rejects bad entries, naming the field, and changes nothing', () => {
    const state = recordSpend(withSource(), 'openai-api', { date: '2026-11-18', amount: 2.1 }, NOW, 'UTC');
    const before = JSON.stringify(state);
    expectValidation(() => recordSpend(state, 'openai-api', { date: '2026-11-18', amount: -1 }, NOW, 'UTC'), 'amount');
    expectValidation(() => recordSpend(state, 'openai-api', { date: '2026-11-18', amount: Number.NaN }, NOW, 'UTC'), 'amount');
    expectValidation(() => recordSpend(state, 'openai-api', { date: '2026-11-18', amount: '3' as never }, NOW, 'UTC'), 'amount');
    expectValidation(() => recordSpend(state, 'openai-api', { date: 'yesterday', amount: 1 }, NOW, 'UTC'), 'date');
    expectValidation(() => recordSpend(state, 'openai-api', { date: '18/11/2026', amount: 1 }, NOW, 'UTC'), 'date');
    expectValidation(() => recordSpend(state, 'openai-api', { date: '2026-13-01', amount: 1 }, NOW, 'UTC'), 'date');
    // A day the calendar does not have would be counted in the month but shown on no day.
    expectValidation(() => recordSpend(state, 'openai-api', { date: '2026-11-31', amount: 1 }, NOW, 'UTC'), 'date');
    expectValidation(() => recordSpend(state, 'openai-api', { date: '2026-02-30', amount: 1 }, NOW, 'UTC'), 'date');
    expect(JSON.stringify(state)).toBe(before);
    expect(sourceOf(recordSpend(state, 'openai-api', { date: '2028-02-29', amount: 1 }, NOW, 'UTC')).entries.map((entry) => entry.date)).toContain('2028-02-29');
  });
});

describe('month-to-date and projection', () => {
  /** 30 spent over the first ten days of November, a 30-day month. */
  function tenDays(budget: number | null = 50): State {
    let state = withSource(budget);
    for (let day = 1; day <= 10; day += 1) {
      state = recordSpend(state, 'openai-api', { date: `2026-11-${String(day).padStart(2, '0')}`, amount: day === 10 ? 3.9 : 2.9 }, NOW, 'UTC');
    }
    return state;
  }
  const dayTen = utc(2026, 11, 10, 18, 0);

  it('projects 90 and flags the source as heading over a budget of 50 after 30 spent in 10 of 30 days', () => {
    // Scenario: Projection over budget.
    const summary = summariseSpend(sourceOf(tenDays()), dayTen, 'UTC');
    expect(summary.monthToDate).toBeCloseTo(30, 9);
    expect(summary.dailyAverage).toBeCloseTo(3, 9);
    expect(summary.projected).toBeCloseTo(90, 9);
    expect(summary.budgetFraction).toBeCloseTo(0.6, 9);
    expect(summary.headingOver).toBe(true);
    expect(summary.overBudget).toBe(false);
    expect(costsMarkdown(tenDays(), dayTen, 'UTC')).toContain('| OpenAI API | $30.00 | $90.00 | $50.00 (heading over) |');
  });

  it('does not flag a projection that stays inside the budget', () => {
    const summary = summariseSpend(sourceOf(tenDays(100)), dayTen, 'UTC');
    expect(summary.projected).toBeCloseTo(90, 9);
    expect(summary.headingOver).toBe(false);
    expect(summary.overBudget).toBe(false);
    expect(summary.budgetFraction).toBeCloseTo(0.3, 9);
  });

  it('says over budget once the month to date exceeds it', () => {
    const summary = summariseSpend(sourceOf(tenDays(25)), dayTen, 'UTC');
    expect(summary.overBudget).toBe(true);
    expect(summary.headingOver).toBe(true);
    expect(summary.budgetFraction).toBeCloseTo(1.2, 9);
    expect(costsMarkdown(tenDays(25), dayTen, 'UTC')).toContain('$25.00 (over)');
  });

  it('has no budget figures without a budget', () => {
    const summary = summariseSpend(sourceOf(tenDays(null)), dayTen, 'UTC');
    expect(summary.monthToDate).toBeCloseTo(30, 9);
    expect(summary.projected).toBeCloseTo(90, 9);
    expect(summary.budgetFraction).toBeNull();
    expect(summary.overBudget).toBe(false);
    expect(summary.headingOver).toBe(false);
  });

  it('averages over the days elapsed, including quiet ones', () => {
    // Same 30, seen on the 20th: 1.5 a day, 45 for the month.
    const summary = summariseSpend(sourceOf(tenDays()), utc(2026, 11, 20, 12, 0), 'UTC');
    expect(summary.monthToDate).toBeCloseTo(30, 9);
    expect(summary.dailyAverage).toBeCloseTo(1.5, 9);
    expect(summary.projected).toBeCloseTo(45, 9);
    expect(summary.headingOver).toBe(false);
  });

  it('uses the real length of the month', () => {
    let state = withSource();
    state = recordSpend(state, 'openai-api', { date: '2026-02-07', amount: 14 }, NOW, 'UTC');
    expect(summariseSpend(sourceOf(state), utc(2026, 2, 7, 12, 0), 'UTC').projected).toBeCloseTo(56, 9); // 2 a day x 28
    let leap = withSource();
    leap = recordSpend(leap, 'openai-api', { date: '2028-02-07', amount: 14 }, NOW, 'UTC');
    expect(summariseSpend(sourceOf(leap), utc(2028, 2, 7, 12, 0), 'UTC').projected).toBeCloseTo(58, 9);
    let december = withSource();
    december = recordSpend(december, 'openai-api', { date: '2026-12-01', amount: 2 }, NOW, 'UTC');
    expect(summariseSpend(sourceOf(december), utc(2026, 12, 1, 12, 0), 'UTC').projected).toBeCloseTo(62, 9);
  });

  it('counts only the current calendar month, and reports the previous one separately', () => {
    let state = tenDays();
    state = recordSpend(state, 'openai-api', { date: '2026-10-15', amount: 40 }, NOW, 'UTC');
    state = recordSpend(state, 'openai-api', { date: '2026-10-31', amount: 2 }, NOW, 'UTC');
    state = recordSpend(state, 'openai-api', { date: '2026-09-30', amount: 500 }, NOW, 'UTC');
    state = recordSpend(state, 'openai-api', { date: '2025-11-05', amount: 500 }, NOW, 'UTC');
    const summary = summariseSpend(sourceOf(state), dayTen, 'UTC');
    expect(summary.monthToDate).toBeCloseTo(30, 9);
    expect(summary.previousMonth).toBeCloseTo(42, 9);
    // On 1 December the month starts again and November becomes the previous month.
    const december = summariseSpend(sourceOf(state), utc(2026, 12, 1, 9, 0), 'UTC');
    expect(december.monthToDate).toBe(0);
    expect(december.previousMonth).toBeCloseTo(30, 9);
    // January looks back across the year end.
    let yearEnd = withSource();
    yearEnd = recordSpend(yearEnd, 'openai-api', { date: '2026-12-20', amount: 9 }, NOW, 'UTC');
    expect(summariseSpend(sourceOf(yearEnd), utc(2027, 1, 3), 'UTC').previousMonth).toBe(9);
  });

  it('decides which month it is in the given zone', () => {
    let state = withSource();
    state = recordSpend(state, 'openai-api', { date: '2026-11-30', amount: 10 }, NOW, 'UTC');
    state = recordSpend(state, 'openai-api', { date: '2026-12-01', amount: 4 }, NOW, 'UTC');
    const instant = utc(2026, 11, 30, 23, 30); // already 1 December in Stockholm
    expect(summariseSpend(sourceOf(state), instant, 'UTC').monthToDate).toBe(10);
    const stockholm = summariseSpend(sourceOf(state), instant, 'Europe/Stockholm');
    expect(stockholm.monthToDate).toBe(4);
    expect(stockholm.previousMonth).toBe(10);
  });

  it('lists the last days as a zero-filled series ending today', () => {
    const summary = summariseSpend(sourceOf(tenDays()), dayTen, 'UTC');
    expect(summary.series).toHaveLength(30);
    expect(summary.series[29]).toEqual({ date: '2026-11-10', amount: 3.9 });
    expect(summary.series[28]).toEqual({ date: '2026-11-09', amount: 2.9 });
    expect(summary.series[0]).toEqual({ date: '2026-10-12', amount: 0 });
    const dates = summary.series.map((point) => point.date);
    expect(dates).toEqual(dates.slice().sort());
    expect(new Set(dates).size).toBe(30);
    expect(summariseSpend(sourceOf(tenDays()), dayTen, 'UTC', 7).series.map((point) => point.date)).toEqual([
      '2026-11-04',
      '2026-11-05',
      '2026-11-06',
      '2026-11-07',
      '2026-11-08',
      '2026-11-09',
      '2026-11-10'
    ]);
  });
});

describe('costs are not waste', () => {
  /** One allowance exactly on pace, on a priced plan, with a recorded finished cycle. */
  function onPace(): State {
    let state = addAccount(
      emptyState(),
      {
        label: 'Claude Max',
        price: { amount: 100, currency: 'USD', period: 'month' },
        meters: [{ label: 'Weekly', reset: { kind: 'interval', hours: 168 }, used: 100, resetsAt: iso(NOW - 3.5 * DAY) }]
      },
      NOW - 4 * DAY
    ).state;
    // The first window closes fully used; half-way through the next one, half is used.
    state = rollState(state, NOW - 3 * DAY);
    return applyReadingToState(state, 'claude-max', 'claude-max:weekly', { usedPercent: 50 }, NOW);
  }

  function overBudget(state: State): State {
    let next = addSpendSource(state, { label: 'OpenAI API', currency: 'USD', monthlyBudget: 50 }, NOW).state;
    for (let day = 1; day <= 19; day += 1) {
      next = recordSpend(next, 'openai-api', { date: `2026-11-${String(day).padStart(2, '0')}`, amount: 40 }, NOW, 'UTC');
    }
    return next;
  }

  it('reports nothing at risk when a spend source is over budget and no allowance is behind pace', () => {
    // Scenario: High spend, no waste.
    const state = overBudget(onPace());
    const spend = summariseSpend(sourceOf(state), NOW, 'UTC');
    expect(spend.overBudget).toBe(true);
    expect(spend.monthToDate).toBe(760);

    const view = viewState(state, NOW)[0];
    expect(view?.tier).toBe('on-pace');
    const summary = summarise(state, NOW);
    expect(summary.useNow).toBe(0);
    expect(summary.behind).toBe(0);
    expect(summary.atRisk).toEqual({});
    expect(summary.atRiskNow).toEqual({});
    expect(summaryLine(summary, 'USD')).toBe('Nothing is going to waste right now.');
    expect(snapshot(state, NOW, 'UTC').summary.atRisk).toEqual({});
    expect(briefMarkdown(state, NOW, 'UTC')).toContain('**Nothing is going to waste right now.**');
    // No money figure anywhere in the brief: the 760 spent is not quota lost.
    expect(briefMarkdown(state, NOW, 'UTC')).not.toContain('$');
  });

  it('never changes a waste figure, a tier or the ledger', () => {
    const before = onPace();
    const after = overBudget(before);
    expect(summarise(after, NOW)).toEqual(summarise(before, NOW));
    expect(viewState(after, NOW)).toEqual(viewState(before, NOW));
    expect(after.cycles).toBe(before.cycles);
    expect(after.accounts).toBe(before.accounts);
    const a = snapshot(after, NOW, 'UTC');
    const b = snapshot(before, NOW, 'UTC');
    expect(a.summary).toEqual(b.summary);
    expect(a.queue).toEqual(b.queue);
    expect(briefMarkdown(after, NOW, 'UTC')).toBe(briefMarkdown(before, NOW, 'UTC'));
    // Not even after more windows close.
    const later = NOW + 30 * DAY;
    expect(rollState(after, later).cycles).toEqual(rollState(before, later).cycles);
    expect(summarise(rollState(after, later), later)).toEqual(summarise(rollState(before, later), later));
  });

  it('keeps spend money out of the money lost, even in the same currency', () => {
    const state = overBudget(onPace());
    const summary = summarise(state, NOW);
    // The only loss on record is the finished weekly cycle, which was fully used.
    expect(summary.cycles30).toBe(1);
    expect(summary.lost30).toEqual({});
    expect(summary.utilisation30).toBe(1);
  });
});
