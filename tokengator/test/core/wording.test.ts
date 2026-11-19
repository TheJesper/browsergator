import { describe, expect, it } from 'vitest';

import { addAccount, updateAccount, type AccountInput, type MeterInput } from '../../src/core/accounts.js';
import { agentPrompt, briefMarkdown, meterMarkdown, meterRecord, queueText, snapshot, stamp } from '../../src/core/brief.js';
import { TIER_ORDER, allowanceQueue, summarise, viewAccount, viewState, type MeterView, type Tier } from '../../src/core/forecast.js';
import { formatAmount, formatMoney, formatMoneyTotals, formatMultiple, formatNumber, formatPercent } from '../../src/core/format.js';
import { applyReadingToState, rollState } from '../../src/core/reset.js';
import { DAY, HOUR, MINUTE, formatMoment, iso } from '../../src/core/time.js';
import { emptyState, type Account, type Price, type State } from '../../src/core/types.js';
import {
  THROTTLE_LABEL,
  TIER_HINT,
  TIER_LABEL,
  explain,
  headline,
  leftText,
  recommend,
  resetText,
  stateLabel,
  statusLine,
  summaryLine,
  usedText
} from '../../src/core/wording.js';

const utc = (y: number, mo: number, d: number, h = 0, mi = 0): number => Date.UTC(y, mo - 1, d, h, mi, 0);
/** Thursday 19 November 2026, 10:00 UTC. */
const NOW = utc(2026, 11, 19, 10, 0);
const WEEK = 7 * DAY;
const USD_100: Price = { amount: 100, currency: 'USD', period: 'month' };

/** A weekly percentage meter that is `elapsed` (0..1) through its window with `usedPercent` used. */
function weekly(elapsed: number, usedPercent: number, extra: Partial<MeterInput> = {}): MeterInput {
  return {
    label: 'Weekly',
    reset: { kind: 'interval', hours: 168 },
    used: usedPercent,
    resetsAt: iso(NOW + Math.round((1 - elapsed) * WEEK)),
    ...extra
  };
}

const weeklyResettingIn = (hours: number, usedPercent: number, extra: Partial<MeterInput> = {}): MeterInput =>
  weekly(1 - hours / 168, usedPercent, extra);

function add(state: State, label: string, meters: MeterInput[], extra: Partial<AccountInput> = {}, nowMs = NOW): State {
  return addAccount(state, { label, meters, ...extra }, nowMs).state;
}

function views(meters: MeterInput[], extra: Partial<AccountInput> = {}, label = 'Claude Max'): MeterView[] {
  const state = add(emptyState(), label, meters, extra);
  return viewAccount(state.accounts[0] as Account, NOW);
}

function view(meter: MeterInput, extra: Partial<AccountInput> = {}, label = 'Claude Max'): MeterView {
  return views([meter], extra, label)[0] as MeterView;
}

describe('labels', () => {
  it('has a label and a hint for every tier and every throttle state', () => {
    for (const tier of TIER_ORDER) {
      expect(TIER_LABEL[tier].length).toBeGreaterThan(0);
      expect(TIER_HINT[tier].length).toBeGreaterThan(0);
    }
    expect(TIER_LABEL).toEqual({
      'use-now': 'Use now',
      behind: 'Behind pace',
      hot: 'Running hot',
      'on-pace': 'On pace',
      fresh: 'New window',
      idle: 'Not started',
      balance: 'Balance',
      spent: 'Used up',
      expired: 'Expired'
    });
    expect(THROTTLE_LABEL).toEqual({ open: 'Open', blocked: 'Blocked', idle: 'Idle' });
  });

  it('never tells tiers apart by colour words alone: every headline starts with a label in words', () => {
    const state = zoo();
    for (const v of viewState(state, NOW)) {
      const text = headline(v, NOW);
      expect(text).toMatch(/^[A-Z][a-z]/);
      expect(stateLabel(v)).toBe(v.tier !== null ? TIER_LABEL[v.tier] : THROTTLE_LABEL[v.throttle ?? 'idle']);
    }
  });
});

describe('amount wording', () => {
  it('speaks in percentages for percentage-only meters', () => {
    const v = view(weeklyResettingIn(14, 62));
    expect(usedText(v)).toBe('62% used');
    expect(leftText(v)).toBe('38% left');
    expect(resetText(v)).toBe('resets in 14h');
  });

  it('speaks in the unit of counted meters', () => {
    const v = view({ label: 'Premium requests', unit: 'requests', limit: 300, used: 120, reset: { kind: 'monthly', day: 1, time: '00:00', tz: 'UTC' } });
    expect(usedText(v)).toBe('120 of 300 requests used');
    expect(leftText(v)).toBe('180 requests left');
    expect(resetText(v)).toBe('resets in 11d');
  });

  it('uses a custom noun wherever the unit is shown', () => {
    // Scenario: Custom noun.
    const v = view({ label: 'Daily', unit: 'count', unitLabel: 'songs', limit: 500, used: 210, reset: { kind: 'daily', time: '00:00', tz: 'UTC' } });
    expect(usedText(v)).toBe('210 of 500 songs used');
    expect(leftText(v)).toBe('290 songs left');
    expect(headline(v, NOW)).toBe('On pace: 290 songs left, resets in 14h');
    expect(statusLine(v, NOW)).toBe('Claude Max, Daily: On pace: 290 songs left, resets in 14h');
    expect(explain(v, NOW)).toContain('210 of 500 songs used');
    expect(meterMarkdown(v, NOW, 'UTC')).toContain('- Used: 210 of 500 songs');
    expect(meterMarkdown(v, NOW, 'UTC')).toContain('- Left: 290 songs');
    expect(formatAmount(v.meter, 1)).toBe('1 songs');
  });

  it('speaks in dollars for meters counted in dollars', () => {
    const v = view({ label: 'Credit', unit: 'usd', limit: 20, used: 5, reset: { kind: 'none' } });
    expect(usedText(v)).toBe('$5.00 of $20.00 used');
    expect(leftText(v)).toBe('$15.00 left');
    expect(headline(v, NOW)).toBe('Balance: $15.00 left');
  });

  it('has no reset text without a clock', () => {
    expect(resetText(view({ label: 'Balance', reset: { kind: 'none' } }))).toBe('');
    expect(resetText(view({ label: 'Session', role: 'throttle', reset: { kind: 'rolling', hours: 5 } }))).toBe('');
  });
});

describe('formatting helpers', () => {
  it('formatPercent rounds to whole percentages without hiding small shares', () => {
    expect(formatPercent(0.38)).toBe('38%');
    expect(formatPercent(0)).toBe('0%');
    expect(formatPercent(1)).toBe('100%');
    expect(formatPercent(0.004)).toBe('<1%');
    expect(formatPercent(0.996)).toBe('99%');
    expect(formatPercent(0.625)).toBe('63%');
    expect(formatPercent(Number.NaN)).toBe('0%');
  });

  it('formatNumber groups thousands and abbreviates large numbers', () => {
    expect(formatNumber(0)).toBe('0');
    expect(formatNumber(12.34)).toBe('12.3');
    expect(formatNumber(1284)).toBe('1,284');
    expect(formatNumber(2500)).toBe('2,500');
    expect(formatNumber(12_940)).toBe('12.9K');
    expect(formatNumber(100_000)).toBe('100K');
    expect(formatNumber(4_200_000)).toBe('4.2M');
  });

  it('formatAmount names the unit, singular for one', () => {
    expect(formatAmount({ unit: 'percent' }, 62.4)).toBe('62%');
    expect(formatAmount({ unit: 'credits' }, 1200)).toBe('1,200 credits');
    expect(formatAmount({ unit: 'requests' }, 1)).toBe('1 request');
    expect(formatAmount({ unit: 'usd' }, 12.4)).toBe('$12.40');
    expect(formatAmount({ unit: 'count' }, 3)).toBe('3 units');
  });

  it('formatMoney keeps cents below 100 and drops them above', () => {
    expect(formatMoney(9.2, 'USD')).toBe('$9.20');
    expect(formatMoney(6.9, 'usd')).toBe('$6.90');
    expect(formatMoney(149.6, 'USD')).toBe('$150');
    expect(formatMoney(12, 'EUR')).toBe('€12.00');
    expect(formatMoney(22.91, 'SEK')).toContain('22.91');
    expect(formatMoney(22.91, 'SEK')).not.toContain('$');
  });

  it('formatMoneyTotals lists each currency once, the preferred one first', () => {
    expect(formatMoneyTotals({})).toBe('');
    expect(formatMoneyTotals({}, 'USD', 'nothing')).toBe('nothing');
    expect(formatMoneyTotals({ USD: 0.001 })).toBe('');
    expect(formatMoneyTotals({ USD: 9.2 })).toBe('$9.20');
    const both = formatMoneyTotals({ USD: 9.2, EUR: 30 }, 'USD');
    expect(both).toBe('$9.20 + €30.00');
    expect(formatMoneyTotals({ USD: 9.2, EUR: 30 }, 'EUR')).toBe('€30.00 + $9.20');
    expect(formatMoneyTotals({ USD: 9.2, EUR: 30 })).toBe('€30.00 + $9.20'); // largest first without a preference
  });

  it('formatMultiple reads as a multiplier', () => {
    expect(formatMultiple(3.5)).toBe('3.5×');
    expect(formatMultiple(2)).toBe('2×');
    expect(formatMultiple(12.4)).toBe('12×');
    expect(formatMultiple(250)).toBe('99×+');
    expect(formatMultiple(Number.POSITIVE_INFINITY)).toBe('99×+');
  });
});

describe('wording per tier', () => {
  it('use-now', () => {
    const v = view(weeklyResettingIn(14, 62), { price: USD_100 });
    expect(v.tier).toBe('use-now');
    expect(headline(v, NOW)).toBe('Use now: 38% left, resets in 14h');
    expect(statusLine(v, NOW)).toBe('Claude Max, Weekly: Use now: 38% left, resets in 14h ($7.41 at risk)');
    expect(explain(v, NOW)).toBe(
      '62% used with 8% of the window left. At this pace about 32% expires unused, worth $7.41. Finishing it takes 6.7× the pace so far.'
    );
    expect(recommend(v, NOW)).toBe(
      'Prefer Claude Max for work the user wants done now: 38% left and it resets in 14h ($7.41 would expire).'
    );
  });

  it('use-now without a price says nothing about money', () => {
    const v = view(weeklyResettingIn(14, 62));
    expect(statusLine(v, NOW)).toBe('Claude Max, Weekly: Use now: 38% left, resets in 14h');
    expect(explain(v, NOW)).toBe('62% used with 8% of the window left. At this pace about 32% expires unused. Finishing it takes 6.7× the pace so far.');
    expect(recommend(v, NOW)).toBe('Prefer Claude Max for work the user wants done now: 38% left and it resets in 14h.');
  });

  it('use-now with nothing used yet names what is left instead of a multiple', () => {
    const v = view(weeklyResettingIn(14, 0));
    expect(v.tier).toBe('use-now');
    expect(v.requiredMultiple).toBeNull();
    expect(explain(v, NOW)).toContain('Finishing it takes all 100% before the reset.');
  });

  it('behind', () => {
    const v = view(weekly(0.6, 30), { price: USD_100 });
    expect(v.tier).toBe('behind');
    expect(headline(v, NOW)).toBe('Behind pace: about 48% will expire, resets in 2d 19h');
    expect(statusLine(v, NOW)).toBe('Claude Max, Weekly: Behind pace: about 48% will expire, resets in 2d 19h ($11.15 at risk)');
    expect(explain(v, NOW)).toBe(
      '30% used with 40% of the window left. At this pace about 48% expires unused, worth $11.15. Finishing it takes 3.5× the pace so far.'
    );
    expect(recommend(v, NOW)).toBe('Claude Max is behind pace; route suitable work to it before it resets in 2d 19h.');
  });

  it('behind with nothing used yet gives an amount per day', () => {
    const halfway = utc(2026, 11, 16);
    const state = add(
      emptyState(),
      'Copilot',
      [{ label: 'Premium requests', unit: 'requests', limit: 300, used: 0, reset: { kind: 'monthly', day: 1, time: '00:00', tz: 'UTC' } }],
      {},
      halfway
    );
    const v = viewState(state, halfway)[0] as MeterView;
    expect(headline(v, halfway)).toBe('Behind pace: about 95% will expire, resets in 15d');
    expect(explain(v, halfway)).toBe(
      '0 of 300 requests used with 50% of the window left. At this pace about 95% expires unused. Finishing it takes about 20 requests a day.'
    );
  });

  it('hot', () => {
    const v = view(weekly(0.3, 75), { price: USD_100 });
    expect(v.tier).toBe('hot');
    const runsOut = formatMoment(v.runsOutAtMs as number, NOW);
    expect(runsOut).toMatch(/^(today|tomorrow) \d\d:\d\d$/);
    expect(headline(v, NOW)).toBe(`Running hot: runs out ${runsOut}, resets in 4d 21h`);
    expect(statusLine(v, NOW)).toBe(`Claude Max, Weekly: Running hot: runs out ${runsOut}, resets in 4d 21h`);
    expect(explain(v, NOW)).toBe(
      `75% used with 70% of the window left. At this pace it runs out ${runsOut}, 4d 4h before the reset. Nothing will be wasted, but it may need rationing.`
    );
    expect(recommend(v, NOW)).toBe('Go easy on Claude Max: at this pace it runs out before its reset.');
  });

  it('on-pace', () => {
    const v = view(weeklyResettingIn(20, 88), { price: USD_100 });
    expect(v.tier).toBe('on-pace');
    expect(headline(v, NOW)).toBe('On pace: 12% left, resets in 20h');
    expect(statusLine(v, NOW)).toBe('Claude Max, Weekly: On pace: 12% left, resets in 20h');
    expect(explain(v, NOW)).toBe('88% used with 12% of the window left. On track to be used up around the reset.');
    expect(recommend(v, NOW)).toBe('Claude Max needs no action.');
  });

  it('fresh', () => {
    const v = view(weekly(0.02, 0), { price: USD_100 });
    expect(v.tier).toBe('fresh');
    expect(headline(v, NOW)).toBe('New window: 100% left, resets in 6d 20h');
    expect(explain(v, NOW)).toBe('0% used with 98% of the window left. The window has only just started, so there is no forecast yet.');
    expect(recommend(v, NOW)).toBe('Claude Max needs no action.');
    expect(statusLine(v, NOW)).toBe('Claude Max, Weekly: New window: 100% left, resets in 6d 20h');
  });

  it('spent', () => {
    const v = view(weeklyResettingIn(48, 99), { price: USD_100 });
    expect(v.tier).toBe('spent');
    expect(headline(v, NOW)).toBe('Used up: resets in 2d');
    expect(statusLine(v, NOW)).toBe('Claude Max, Weekly: Used up: resets in 2d');
    expect(explain(v, NOW)).toBe('99% used with 29% of the window left. Fully used, so nothing expires.');
    expect(recommend(v, NOW)).toBe('Claude Max is used up until its reset; use something else.');
  });

  it('idle because the reset time is not known', () => {
    const v = view({ label: 'Weekly', reset: { kind: 'interval', hours: 168 } }, {}, 'ChatGPT Plus');
    expect(v.tier).toBe('idle');
    expect(headline(v, NOW)).toBe('Reset time unknown: 100% left');
    expect(explain(v, NOW)).toBe('0% used. Set the reset time to get a forecast. No reading yet.');
    expect(recommend(v, NOW)).toBe('ChatGPT Plus has no reset time on record; ask the user or read its usage page.');
    expect(statusLine(v, NOW)).toBe('ChatGPT Plus, Weekly: Reset time unknown: 100% left (no reading yet)');
  });

  it('idle because a rolling window has not started', () => {
    const fiveHours = view({ label: 'Five hours', reset: { kind: 'rolling', hours: 5 } });
    expect(headline(fiveHours, NOW)).toBe('Not started: the 5-hour window opens on first use');
    expect(recommend(fiveHours, NOW)).toBe('Claude Max has no window running; using it starts one.');
    expect(headline(view({ label: 'W', reset: { kind: 'rolling', hours: 168 } }), NOW)).toBe('Not started: the weekly window opens on first use');
    expect(headline(view({ label: 'W', reset: { kind: 'rolling', hours: 48 } }), NOW)).toBe('Not started: the 2-day window opens on first use');
  });

  it('balance', () => {
    const v = view({ label: 'Balance', unit: 'credits', limit: 500, used: 100, reset: { kind: 'none' } }, {}, 'OpenRouter');
    expect(v.tier).toBe('balance');
    expect(headline(v, NOW)).toBe('Balance: 400 credits left');
    expect(explain(v, NOW)).toBe('100 of 500 credits used.');
    expect(recommend(v, NOW)).toBe('OpenRouter needs no action.');
    expect(statusLine(v, NOW)).toBe('OpenRouter, Balance: Balance: 400 credits left');
  });

  it('expired', () => {
    // A pack bought twenty days ago, last read two hours ago, that ran out an hour ago.
    const expired = (used: number): MeterView => {
      let state = add(
        emptyState(),
        'Credit pack',
        [{ label: 'Credits', unit: 'credits', limit: 1000, reset: { kind: 'once' }, resetsAt: iso(NOW - HOUR) }],
        { price: { amount: 50, currency: 'USD', period: 'month' } },
        NOW - 20 * DAY
      );
      state = applyReadingToState(state, 'credit-pack', 'credit-pack:credits', { used }, NOW - 2 * HOUR);
      return viewState(rollState(state, NOW), NOW)[0] as MeterView;
    };
    const v = expired(600);
    expect(v.tier).toBe('expired');
    expect(headline(v, NOW)).toBe('Expired with 40% unused');
    expect(statusLine(v, NOW)).toBe('Credit pack, Credits: Expired with 40% unused');
    expect(explain(v, NOW)).toBe('600 of 1,000 credits used.');
    expect(recommend(v, NOW)).toBe('Credit pack has expired.');
    expect(headline(expired(1000), NOW)).toBe('Expired, fully used');
  });

  it('throttles: blocked, open and idle', () => {
    const session = (used: number, minutesLeft: number | null): MeterInput => ({
      label: 'Session',
      role: 'throttle',
      reset: { kind: 'rolling', hours: 5 },
      ...(minutesLeft === null ? {} : { used, resetsAt: iso(NOW + minutesLeft * MINUTE) })
    });
    const blocked = view(session(100, 70));
    expect(headline(blocked, NOW)).toBe('Blocked: reopens in 1h 10m');
    expect(explain(blocked, NOW)).toBe(
      `Session is at its limit, so this account cannot be used right now. It reopens ${formatMoment(NOW + 70 * MINUTE, NOW)}.`
    );
    expect(statusLine(blocked, NOW)).toBe('Claude Max, Session: Blocked: reopens in 1h 10m');
    expect(stateLabel(blocked)).toBe('Blocked');

    const open = view(session(40, 120));
    expect(headline(open, NOW)).toBe('Open: 40% used, resets in 2h');
    expect(explain(open, NOW)).toBe('40% used in the current window. This is a rate limit, not an allowance: nothing is lost when it resets.');
    expect(stateLabel(open)).toBe('Open');

    const idle = view(session(0, null));
    expect(headline(idle, NOW)).toBe('Idle: opens on first use');
    expect(explain(idle, NOW)).toBe('No window is running. One opens the next time the account is used. No reading yet.');
    expect(stateLabel(idle)).toBe('Idle');
  });

  it('says for how long the account is blocked on the meters that need using', () => {
    // Scenario: Session cap reached.
    const [weeklyView] = views(
      [weeklyResettingIn(14, 62), { label: 'Session', role: 'throttle', reset: { kind: 'rolling', hours: 5 }, used: 100, resetsAt: iso(NOW + 70 * MINUTE) }],
      { price: USD_100 }
    ) as [MeterView];
    expect(headline(weeklyView, NOW)).toBe('Use now: 38% left, resets in 14h');
    expect(explain(weeklyView, NOW)).toBe(
      '62% used with 8% of the window left. At this pace about 32% expires unused, worth $7.41. Finishing it takes 6.7× the pace so far. Blocked by Session for 1h 10m.'
    );
    expect(recommend(weeklyView, NOW)).toBe(
      'Prefer Claude Max for work the user wants done now: 38% left and it resets in 14h ($7.41 would expire). It is blocked by Session for another 1h 10m.'
    );
  });
});

describe('the forecast in words', () => {
  it('states the same three figures the forecast bar draws', () => {
    const v = view(weekly(0.6, 42));
    const markdown = meterMarkdown(v, NOW, 'UTC');
    expect(markdown).toContain('- Used: 42%');
    expect(markdown).toContain('- Forecast: 71% used by the reset, 29% expires');
    expect(headline(v, NOW)).toBe('Behind pace: about 29% will expire, resets in 2d 19h');
    expect(explain(v, NOW)).toContain('At this pace about 29% expires unused.');
    expect(snapshot(add(emptyState(), 'Claude Max', [weekly(0.6, 42)]), NOW, 'UTC').queue[0]).toMatchObject({ usedPercent: 42, projectedUnusedPercent: 29.1 });
  });
});

describe('markers carried into every summary', () => {
  function staleWeekly(): { state: State; v: MeterView } {
    const state = add(emptyState(), 'Claude Max', [{ label: 'Weekly', reset: { kind: 'interval', hours: 168 }, used: 62, resetsAt: iso(NOW + 14 * HOUR) }], { price: USD_100 }, NOW - 3 * DAY);
    return { state, v: viewState(state, NOW)[0] as MeterView };
  }

  it('says when a stale meter was last updated', () => {
    // Scenario: Old weekly reading.
    const { state, v } = staleWeekly();
    expect(v.stale).toBe(true);
    expect(statusLine(v, NOW)).toBe('Claude Max, Weekly: Use now: 38% left, resets in 14h ($7.41 at risk, updated 3d ago)');
    expect(explain(v, NOW)).toMatch(/Last updated 3d ago; refresh before acting on it\.$/);
    expect(recommend(v, NOW)).toMatch(/The reading is stale, so check the usage page first\.$/);
    expect(meterMarkdown(v, NOW, 'UTC')).toContain('- Updated: 3d ago (stale)');
    expect(briefMarkdown(state, NOW, 'UTC')).toContain('| Claude Max | Weekly (stale) |');
    expect(queueText(state, NOW, 'UTC')).toContain('updated 3d ago');
    expect(snapshot(state, NOW, 'UTC').queue[0]).toMatchObject({ stale: true, updatedAt: iso(NOW - 3 * DAY) });
    expect(agentPrompt(v, NOW, 'UTC')).toContain('updated 3d ago');
  });

  it('says in every summary that a meter has never been read', () => {
    // Requirement: a meter that never had a reading is stale, and every summary carries the marker.
    const state = add(emptyState(), 'ChatGPT Plus', [{ label: 'Weekly', reset: { kind: 'interval', hours: 168 }, resetsAt: iso(NOW + 3 * DAY) }]);
    const v = viewState(state, NOW)[0] as MeterView;
    expect(v.stale).toBe(true);
    expect(v.ageMs).toBeNull();
    expect(v.tier).toBe('behind'); // 0% used is an assumption here, not a fact
    expect(statusLine(v, NOW)).toBe('ChatGPT Plus, Weekly: Behind pace: about 97% will expire, resets in 3d (no reading yet)');
    expect(explain(v, NOW)).toMatch(/No reading yet\.$/);
    expect(recommend(v, NOW)).toMatch(/check the usage page first\.$/);
    expect(meterMarkdown(v, NOW, 'UTC')).toContain('- Updated: never (stale)');
    expect(briefMarkdown(state, NOW, 'UTC')).toContain('| ChatGPT Plus | Weekly (stale) |');
    expect(queueText(state, NOW, 'UTC')).toContain('(no reading yet)');
    expect(agentPrompt(v, NOW, 'UTC')).toContain('(no reading yet)');
    expect(snapshot(state, NOW, 'UTC').queue[0]).toMatchObject({ stale: true, updatedAt: null });
  });

  it('says so when the numbers are assumed after a roll-over', () => {
    const state = rollState(add(emptyState(), 'Claude Max', [weeklyResettingIn(1, 62)]), NOW + 2 * DAY);
    const v = viewState(state, NOW + 2 * DAY)[0] as MeterView;
    expect(v.meter.estimated).toBe(true);
    expect(explain(v, NOW + 2 * DAY)).toContain('The window rolled over since the last reading, so these numbers are assumed.');
    expect(snapshot(state, NOW + 2 * DAY, 'UTC').queue[0]?.estimated).toBe(true);
  });

  it('marks snoozed and carry-over meters', () => {
    let state = add(emptyState(), 'Claude Max', [weekly(0.6, 30, { rollover: 'carries' })]);
    state = updateAccount(state, 'claude-max', { snoozedUntil: iso(NOW + DAY) }, NOW);
    const v = viewState(state, NOW)[0] as MeterView;
    expect(explain(v, NOW)).toContain('Unused quota carries over to the next window, so nothing is lost at the reset.');
    expect(explain(v, NOW)).not.toContain('On track to be used up');
    expect(explain(v, NOW)).toMatch(/Snoozed\.$/);
    expect(snapshot(state, NOW, 'UTC').queue[0]?.snoozed).toBe(true);
  });
});

/** One account per tier, plus a blocked throttle. */
function zoo(): State {
  let state = emptyState();
  state = add(state, 'Claude Max', [weeklyResettingIn(14, 62), { label: 'Session', role: 'throttle', reset: { kind: 'rolling', hours: 5 }, used: 100, resetsAt: iso(NOW + 70 * MINUTE) }], {
    price: USD_100
  });
  state = add(state, 'ChatGPT Plus', [weekly(0.6, 30)], { price: { amount: 20, currency: 'USD', period: 'month' } });
  state = add(state, 'Cursor', [weekly(0.3, 75)]);
  state = add(state, 'Copilot', [{ label: 'Premium requests', unit: 'requests', limit: 300, used: 180, reset: { kind: 'monthly', day: 1, time: '00:00', tz: 'UTC' } }], {
    price: { amount: 10, currency: 'USD', period: 'month' }
  });
  state = add(state, 'Gemini', [weekly(0.02, 0)]);
  state = add(state, 'Codex', [{ label: 'Weekly', reset: { kind: 'interval', hours: 168 } }]);
  state = add(state, 'OpenRouter', [{ label: 'Balance', unit: 'usd', limit: 20, used: 5, reset: { kind: 'none' } }]);
  state = add(state, 'ElevenLabs', [weekly(0.5, 99, { label: 'Characters' })]);
  state = add(state, 'Credit pack', [{ label: 'Credits', unit: 'credits', limit: 1000, used: 600, reset: { kind: 'once' }, resetsAt: iso(NOW - HOUR) }], {}, NOW - 3 * HOUR);
  state = add(state, 'Suno', [{ label: 'Monthly credits', unit: 'credits', limit: 2500, used: 100, reset: { kind: 'monthly', day: 12, time: '00:00', tz: 'UTC' } }]);
  state = updateAccount(state, 'suno', { snoozedUntil: iso(NOW + 3 * DAY) }, NOW);
  return rollState(state, NOW);
}

describe('summaryLine', () => {
  it('counts what needs using now and the money at risk', () => {
    const one = add(emptyState(), 'Claude Max', [weeklyResettingIn(14, 62)], { price: USD_100 });
    expect(summaryLine(summarise(one, NOW), 'USD')).toBe('1 quota needs using now, $7.41 at risk.');
    const two = add(one, 'ChatGPT Plus', [weeklyResettingIn(5, 40)]);
    expect(summaryLine(summarise(two, NOW), 'USD')).toBe('2 quotas need using now, $7.41 at risk.');
    const unpriced = add(emptyState(), 'Free tier', [weeklyResettingIn(14, 62)]);
    expect(summaryLine(summarise(unpriced, NOW), 'USD')).toBe('1 quota needs using now.');
  });

  it('names only the money inside the meters that need using now', () => {
    let state = add(emptyState(), 'Claude Max', [weeklyResettingIn(14, 62)], { price: USD_100 });
    state = add(state, 'ChatGPT Plus', [weekly(0.6, 30)], { price: USD_100 });
    const summary = summarise(state, NOW);
    expect(summary.useNow).toBe(1);
    expect(summary.behind).toBe(1);
    expect(formatMoneyTotals(summary.atRiskNow, 'USD')).toBe('$7.41');
    expect(formatMoneyTotals(summary.atRisk, 'USD')).toBe('$18.56');
    expect(summaryLine(summary, 'USD')).toBe('1 quota needs using now, $7.41 at risk.');
  });

  it('falls back to what is behind pace', () => {
    const one = add(emptyState(), 'Claude Max', [weekly(0.6, 30)], { price: USD_100 });
    expect(summaryLine(summarise(one, NOW), 'USD')).toBe('Nothing expires in the next hours, but 1 quota is behind pace ($11.15 at risk).');
    const two = add(one, 'ChatGPT Plus', [weekly(0.5, 10)]);
    expect(summaryLine(summarise(two, NOW), 'USD')).toBe('Nothing expires in the next hours, but 2 quotas are behind pace ($11.15 at risk).');
  });

  it('says so in words when nothing needs attention', () => {
    const hot = add(emptyState(), 'Claude Max', [weekly(0.3, 75)], { price: USD_100 });
    expect(summaryLine(summarise(hot, NOW), 'USD')).toBe('Nothing is going to waste. Some quotas are running hot.');
    const fine = add(emptyState(), 'Claude Max', [weekly(0.5, 50)], { price: USD_100 });
    expect(summaryLine(summarise(fine, NOW), 'USD')).toBe('Nothing is going to waste right now.');
    expect(summaryLine(summarise(emptyState(), NOW), 'USD')).toBe('Nothing is going to waste right now.');
  });

  it('lists the preferred currency first when money is at risk in several', () => {
    let state = add(emptyState(), 'Claude Max', [weeklyResettingIn(14, 62)], { price: USD_100 });
    state = add(state, 'Mistral', [weeklyResettingIn(14, 62)], { price: { amount: 400, currency: 'EUR', period: 'month' } });
    expect(summaryLine(summarise(state, NOW), 'USD')).toBe('2 quotas need using now, $7.41 + €29.64 at risk.');
    expect(summaryLine(summarise(state, NOW), 'EUR')).toBe('2 quotas need using now, €29.64 + $7.41 at risk.');
  });
});

describe('one wording everywhere', () => {
  it('uses the sentence "Use now: 38% left, resets in 14h" in the snapshot, the queue text and the Markdown', () => {
    // Scenario: Same sentence in two places.
    const state = zoo();
    const sentence = 'Use now: 38% left, resets in 14h';
    const v = allowanceQueue(state, NOW)[0] as MeterView;
    expect(v.account.label).toBe('Claude Max');
    expect(headline(v, NOW)).toBe(sentence); // what the dashboard row shows

    const snap = snapshot(state, NOW, 'UTC'); // what_to_use and status --json
    expect(snap.queue[0]).toMatchObject({ id: 'claude-max:weekly', headline: sentence, tier: 'use-now', state: 'Use now' });

    const text = queueText(state, NOW, 'UTC'); // tool text and CLI status
    expect(text.split('\n')).toContain(`1. Claude Max, Weekly: ${sentence} ($7.41 at risk)`);

    expect(meterMarkdown(v, NOW, 'UTC')).toContain(`**${sentence}**`); // copy as Markdown
    expect(agentPrompt(v, NOW, 'UTC')).toContain(`Claude Max, Weekly: ${sentence}`); // copy as agent prompt

    // The brief is a table, so it carries the same two figures rather than the sentence.
    const brief = briefMarkdown(state, NOW, 'UTC');
    const section = brief.slice(brief.indexOf('## Use now'), brief.indexOf('## Behind pace'));
    expect(section).toContain('| Claude Max | Weekly (blocked) | 38% | 14h (tomorrow 00:00) | 32% | $7.41 |');
    expect(brief).toContain(`**Next:** ${snap.queue[0]?.recommendation}`);
    expect(snap.queue[0]?.recommendation).toContain('38% left and it resets in 14h');
  });

  it('agrees for every meter, in every tier, at the same moment', () => {
    const state = zoo();
    const snap = snapshot(state, NOW, 'UTC');
    const queue = allowanceQueue(state, NOW);
    const lines = queueText(state, NOW, 'UTC', 50).split('\n');
    expect(snap.queue.map((record) => record.id)).toEqual(queue.map((v) => v.id));
    expect(new Set(queue.map((v) => v.tier))).toEqual(new Set<Tier | null>(TIER_ORDER));

    for (const v of queue) {
      const sentence = headline(v, NOW);
      const record = snap.queue.find((entry) => entry.id === v.id);
      expect(record?.headline).toBe(sentence);
      expect(record?.recommendation).toBe(recommend(v, NOW));
      expect(record?.state).toBe(stateLabel(v));
      expect(meterRecord(v, NOW)).toEqual(record);
      expect(statusLine(v, NOW)).toContain(sentence);
      expect(meterMarkdown(v, NOW, 'UTC')).toContain(`**${sentence}**`);
      expect(agentPrompt(v, NOW, 'UTC')).toContain(sentence);
      if (!v.snoozed) expect(lines.some((line) => line.endsWith(statusLine(v, NOW)))).toBe(true);
    }

    const throttle = viewState(state, NOW).find((v) => v.tier === null) as MeterView;
    expect(snap.throttles).toEqual([meterRecord(throttle, NOW)]);
    expect(snap.throttles[0]).toMatchObject({ headline: 'Blocked: reopens in 1h 10m', tier: 'blocked', role: 'throttle' });
  });

  it('uses one summary sentence in the snapshot, the queue text and the brief', () => {
    const state = zoo();
    const line = summaryLine(summarise(state, NOW), state.settings.currency);
    // One meter needs using now; the money named with it is that meter's, not the whole queue's.
    expect(line).toBe('1 quota needs using now, $7.41 at risk.');
    expect(snapshot(state, NOW, 'UTC').summary.line).toBe(line);
    expect(queueText(state, NOW, 'UTC').split('\n')[1]).toBe(line);
    expect(briefMarkdown(state, NOW, 'UTC')).toContain(`**${line}**`);
  });

  it('keeps agreeing as the clock moves', () => {
    const state = zoo();
    const later = NOW + HOUR;
    const sentence = 'Use now: 38% left, resets in 13h';
    expect(snapshot(state, later, 'UTC').queue[0]?.headline).toBe(sentence);
    expect(queueText(state, later, 'UTC')).toContain(`1. Claude Max, Weekly: ${sentence}`);
    expect(headline(allowanceQueue(state, later)[0] as MeterView, later)).toBe(sentence);
  });

  it('gives the brief one section per tier present, in use-first order, and lists snoozed accounts apart', () => {
    const brief = briefMarkdown(zoo(), NOW, 'UTC');
    const headings = brief.split('\n').filter((line) => line.startsWith('## ')).map((line) => line.slice(3));
    expect(headings).toEqual(['Use now', 'Behind pace', 'Running hot', 'On pace', 'New window', 'Not started', 'Balance', 'Used up', 'Expired']);
    expect(brief).toContain('Snoozed: Suno.');
    expect(brief).not.toContain('| Suno |');
    expect(brief.startsWith('# AI quota brief\n\n_As of 10:00 UTC (2026-11-19T10:00:00.000Z)_')).toBe(true);
  });

  it('leaves snoozed accounts out of the queue text and marks them in the snapshot', () => {
    const state = zoo();
    expect(queueText(state, NOW, 'UTC')).not.toContain('Suno');
    const snap = snapshot(state, NOW, 'UTC');
    expect(snap.queue[snap.queue.length - 1]).toMatchObject({ account: 'Suno', snoozed: true });
    expect(snap.summary.behind).toBe(1); // ChatGPT Plus only: Suno is behind too, but snoozed
  });

  it('stamps agent-facing text with the time it was written', () => {
    expect(stamp(NOW, 'UTC')).toBe('10:00 UTC (2026-11-19T10:00:00.000Z)');
    expect(stamp(NOW, 'Europe/Stockholm')).toBe('11:00 Europe/Stockholm (2026-11-19T10:00:00.000Z)');
    expect(queueText(emptyState(), NOW, 'UTC')).toBe(
      'As of 10:00 UTC (2026-11-19T10:00:00.000Z).\nNothing is going to waste right now.\n\nNo subscriptions are tracked yet. Add one with add_account.'
    );
    expect(briefMarkdown(emptyState(), NOW, 'UTC')).toContain('No subscriptions are tracked yet.');
  });

  it('reports a reading in the snapshot exactly as stored, with rounded derived figures', () => {
    let state = add(emptyState(), 'Suno Pro', [{ label: 'Monthly credits', unit: 'credits', limit: 2500, reset: { kind: 'monthly', day: 12, time: '00:00', tz: 'UTC' } }], {
      providerId: 'suno',
      plan: 'Pro',
      price: { amount: 10, currency: 'USD', period: 'month' }
    });
    state = applyReadingToState(state, 'suno-pro', 'suno-pro:monthly-credits', { remaining: 1200, source: { kind: 'agent', id: 'claude-code' } }, NOW);
    const record = snapshot(state, NOW, 'UTC').queue[0];
    expect(record).toMatchObject({
      id: 'suno-pro:monthly-credits',
      account: 'Suno Pro',
      accountId: 'suno-pro',
      provider: 'suno',
      plan: 'Pro',
      meter: 'Monthly credits',
      key: 'monthly-credits',
      role: 'allowance',
      unit: 'credits',
      limit: 2500,
      used: 1300,
      remaining: 1200,
      usedPercent: 52,
      remainingPercent: 48,
      resetsAt: '2026-12-12T00:00:00.000Z',
      resetsInMinutes: 22 * 24 * 60 + 14 * 60,
      windowHours: 720,
      currency: 'USD',
      stale: false,
      updatedAt: iso(NOW),
      source: 'agent:claude-code',
      estimated: false,
      snoozed: false,
      blockedBy: null,
      blockedUntil: null
    });
  });
});
