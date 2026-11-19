import { describe, expect, it } from 'vitest';

import { addAccount, type AccountInput, type MeterInput } from '../../src/core/accounts.js';
import { defaultMeter, parseDuration, parseQuick, parseWhen, previewReading, resolveMeterIn, resolveTarget } from '../../src/core/quick.js';
import { applyReadingToState } from '../../src/core/reset.js';
import { DAY, HOUR, MINUTE, iso } from '../../src/core/time.js';
import { emptyState, type Account, type Meter, type Reading, type State } from '../../src/core/types.js';

const utc = (y: number, mo: number, d: number, h = 0, mi = 0): number => Date.UTC(y, mo - 1, d, h, mi, 0);
/** Thursday 19 November 2026, 10:00 UTC. */
const NOW = utc(2026, 11, 19, 10, 0);
const LA = 'America/Los_Angeles';
const STO = 'Europe/Stockholm';

function add(state: State, label: string, meters: MeterInput[], extra: Partial<AccountInput> = {}): State {
  return addAccount(state, { label, meters, ...extra }, NOW).state;
}

/** Six subscriptions with nothing in common, so every name in the tables below is unambiguous. */
function fixture(): State {
  let state = emptyState();
  state = add(
    state,
    'Claude',
    [
      // The throttle is listed first on purpose: a bare "claude" must still mean the weekly allowance.
      { label: 'Session', role: 'throttle', reset: { kind: 'rolling', hours: 5 } },
      { label: 'Weekly', reset: { kind: 'interval', hours: 168 }, resetsAt: iso(NOW + 2 * DAY) }
    ],
    { providerId: 'claude', plan: 'Max 20x' }
  );
  state = add(state, 'Suno Pro', [{ label: 'Monthly credits', unit: 'credits', limit: 2500, reset: { kind: 'monthly', day: 12, time: '00:00', tz: 'UTC' } }], {
    providerId: 'suno'
  });
  state = add(state, 'Copilot', [{ label: 'Premium requests', unit: 'requests', limit: 300, reset: { kind: 'monthly', day: 1, time: '00:00', tz: 'UTC' } }], {
    providerId: 'copilot'
  });
  state = add(state, 'ElevenLabs', [{ label: 'Characters', unit: 'characters', limit: 100_000, reset: { kind: 'monthly', day: 5, time: '00:00', tz: 'UTC' } }], {
    providerId: 'elevenlabs'
  });
  state = add(state, 'GPT 5', [{ label: 'Weekly', reset: { kind: 'interval', hours: 168 }, resetsAt: iso(NOW + 3 * DAY) }], { providerId: 'codex' });
  state = add(state, 'OpenRouter', [{ label: 'Balance', unit: 'usd', limit: 50, reset: { kind: 'none' } }], { providerId: 'openrouter' });
  state = add(state, 'Jobbet', [{ label: 'Daily', unit: 'count', unitLabel: 'songs', limit: 500, reset: { kind: 'daily', time: '00:00', tz: 'UTC' } }], {
    providerId: 'gemini'
  });
  return state;
}

function ok(text: string, state = fixture(), tz = 'UTC'): { account: Account; meter: Meter; reading: Reading; preview: string } {
  const result = parseQuick(text, state, NOW, tz);
  if (!result.ok) throw new Error(`"${text}" was rejected: ${result.error}`);
  return result;
}

function rejected(text: string, state = fixture()): { error: string; candidates: { accountId: string; meterId: string | null; label: string }[] } {
  const result = parseQuick(text, state, NOW, 'UTC');
  if (result.ok) throw new Error(`"${text}" was accepted as ${JSON.stringify(result.reading)}`);
  return result;
}

describe('parseDuration', () => {
  it.each([
    ['3h', 3 * HOUR],
    ['3h20m', 3 * HOUR + 20 * MINUTE],
    ['3h 20m', 3 * HOUR + 20 * MINUTE],
    ['2d 4h', 2 * DAY + 4 * HOUR],
    ['9d', 9 * DAY],
    ['45 min', 45 * MINUTE],
    ['45m', 45 * MINUTE],
    ['90 minutes', 90 * MINUTE],
    ['1w', 7 * DAY],
    ['2 weeks', 14 * DAY],
    ['1 week 2 days', 9 * DAY],
    ['1.5h', 1.5 * HOUR],
    ['2hrs', 2 * HOUR],
    ['1 hour', HOUR],
    ['2 days', 2 * DAY],
    ['2 days and 3 hours', 2 * DAY + 3 * HOUR],
    ['2d, 3h', 2 * DAY + 3 * HOUR],
    ['  5H  ', 5 * HOUR],
    ['0m', 0]
  ])('"%s" is %i ms', (text, expected) => {
    expect(parseDuration(text)).toBe(expected);
  });

  it.each(['', '   ', 'abc', '3', '3x', 'tomorrow', '3h tomorrow', 'thu 09:00', '1 month', '09:00', '2026-11-21', 'h', '-'])(
    '"%s" is not a duration',
    (text) => {
      expect(parseDuration(text)).toBeNull();
    }
  );
});

describe('parseWhen', () => {
  const cases: [string, number][] = [
    // durations
    ['3h', NOW + 3 * HOUR],
    ['in 3h', NOW + 3 * HOUR],
    ['in 2d 4h', NOW + 2 * DAY + 4 * HOUR],
    ['9d', NOW + 9 * DAY],
    ['in 45 min', NOW + 45 * MINUTE],
    ['1w', NOW + 7 * DAY],
    // today and tomorrow
    ['tomorrow', utc(2026, 11, 20, 0, 0)],
    ['tomorrow 9am', utc(2026, 11, 20, 9, 0)],
    ['tomorrow 09:30', utc(2026, 11, 20, 9, 30)],
    ['Tomorrow 18:00', utc(2026, 11, 20, 18, 0)],
    ['tmrw 18:00', utc(2026, 11, 20, 18, 0)],
    ['today 18:00', utc(2026, 11, 19, 18, 0)],
    ['today', utc(2026, 11, 19, 23, 59)],
    ['tonight', utc(2026, 11, 19, 23, 59)],
    // weekdays: today is a Thursday
    ['thu 11:00', utc(2026, 11, 19, 11, 0)],
    ['thu 09:00', utc(2026, 11, 26, 9, 0)],
    ['thursday', utc(2026, 11, 26, 0, 0)],
    ['fri', utc(2026, 11, 20, 0, 0)],
    ['friday 9am', utc(2026, 11, 20, 9, 0)],
    ['sat 5:30pm', utc(2026, 11, 21, 17, 30)],
    ['sun', utc(2026, 11, 22, 0, 0)],
    ['mon 09:00', utc(2026, 11, 23, 9, 0)],
    ['on mon 09:00', utc(2026, 11, 23, 9, 0)],
    ['Tuesday 14:00', utc(2026, 11, 24, 14, 0)],
    ['wed', utc(2026, 11, 25, 0, 0)],
    // a bare clock is the next time the clock reads it
    ['17:30', utc(2026, 11, 19, 17, 30)],
    ['09:00', utc(2026, 11, 20, 9, 0)],
    ['at 09:00', utc(2026, 11, 20, 9, 0)],
    ['9am', utc(2026, 11, 20, 9, 0)],
    ['9pm', utc(2026, 11, 19, 21, 0)],
    ['12pm', utc(2026, 11, 19, 12, 0)],
    ['12am', utc(2026, 11, 20, 0, 0)],
    ['10:01', utc(2026, 11, 19, 10, 1)],
    ['10:00', utc(2026, 11, 20, 10, 0)],
    // ISO dates, with and without a clock
    ['2026-11-21', utc(2026, 11, 21, 0, 0)],
    ['2026-11-21 09:00', utc(2026, 11, 21, 9, 0)],
    ['2026-11-21T09:00', utc(2026, 11, 21, 9, 0)],
    ['2026-11-21 9am', utc(2026, 11, 21, 9, 0)],
    ['on 2026-11-21', utc(2026, 11, 21, 0, 0)],
    ['2026-11-21T09:00:00Z', utc(2026, 11, 21, 9, 0)],
    ['2026-11-21T09:00:00.000Z', utc(2026, 11, 21, 9, 0)],
    ['2026-11-21T09:00:00+01:00', utc(2026, 11, 21, 8, 0)],
    ['2027-01-05', utc(2027, 1, 5, 0, 0)],
    // month and day, either way round
    ['nov 21', utc(2026, 11, 21, 0, 0)],
    ['Nov 21', utc(2026, 11, 21, 0, 0)],
    ['november 21', utc(2026, 11, 21, 0, 0)],
    ['21 nov', utc(2026, 11, 21, 0, 0)],
    ['nov 21 09:00', utc(2026, 11, 21, 9, 0)],
    ['21 nov 9am', utc(2026, 11, 21, 9, 0)],
    ['on nov 21', utc(2026, 11, 21, 0, 0)],
    ['dec 1', utc(2026, 12, 1, 0, 0)],
    ['jan 5', utc(2027, 1, 5, 0, 0)],
    ['nov 1', utc(2027, 11, 1, 0, 0)],
    ['nov 19', utc(2027, 11, 19, 0, 0)]
  ];

  it.each(cases)('"%s"', (text, expected) => {
    const got = parseWhen(text, NOW, 'UTC');
    expect(got === null ? null : iso(got)).toBe(iso(expected));
  });

  it('always answers with a moment in the future', () => {
    for (const [text] of cases) {
      expect(parseWhen(text, NOW, 'UTC') as number).toBeGreaterThan(NOW);
    }
  });

  it.each([
    ['an ISO date that has passed', '2026-11-01'],
    ['an ISO date and clock that have passed', '2026-11-19 09:00'],
    ['today at midnight, which has passed', '2026-11-19'],
    ['an ISO instant an hour ago', '2026-11-19T09:00:00Z'],
    ['an ISO instant that is exactly now', '2026-11-19T10:00:00Z'],
    ['a time earlier today', 'today 08:00'],
    ['a zero duration', '0m']
  ])('rejects %s', (_name, text) => {
    expect(parseWhen(text, NOW, 'UTC')).toBeNull();
  });

  it.each(['', '   ', 'banana', 'someday soon', '9', '25:00', '9:75', 'thu 25:00', 'thu banana', 'tomorrow banana', 'nov 45', 'nov', 'resets'])(
    'does not understand "%s"',
    (text) => {
      expect(parseWhen(text, NOW, 'UTC')).toBeNull();
    }
  );

  it('reads wall-clock expressions in the given zone', () => {
    // 10:00 UTC is 11:00 in Stockholm (CET) and 02:00 in Los Angeles (PST).
    expect(iso(parseWhen('tomorrow 09:00', NOW, STO) as number)).toBe('2026-11-20T08:00:00.000Z');
    expect(iso(parseWhen('09:00', NOW, STO) as number)).toBe('2026-11-20T08:00:00.000Z');
    expect(iso(parseWhen('12:00', NOW, STO) as number)).toBe('2026-11-19T11:00:00.000Z');
    expect(iso(parseWhen('2026-11-21', NOW, LA) as number)).toBe('2026-11-21T08:00:00.000Z');
    expect(iso(parseWhen('today', NOW, LA) as number)).toBe('2026-11-20T07:59:00.000Z');
    expect(iso(parseWhen('thu 09:00', NOW, LA) as number)).toBe('2026-11-19T17:00:00.000Z');
    expect(iso(parseWhen('nov 21 09:00', NOW, STO) as number)).toBe('2026-11-21T08:00:00.000Z');
    // Durations and full instants do not depend on the zone.
    expect(parseWhen('3h', NOW, LA)).toBe(NOW + 3 * HOUR);
    expect(iso(parseWhen('2026-11-21T09:00:00Z', NOW, LA) as number)).toBe('2026-11-21T09:00:00.000Z');
  });

  it('keeps the wall clock across a daylight-saving change', () => {
    const before = Date.UTC(2026, 2, 7, 20, 0, 0); // 12:00 PST on 7 March, the day before spring forward
    expect(iso(parseWhen('tomorrow 09:00', before, LA) as number)).toBe('2026-03-08T16:00:00.000Z');
    expect(iso(parseWhen('mon 09:00', before, LA) as number)).toBe('2026-03-09T16:00:00.000Z');
  });
});

describe('resolveTarget', () => {
  const idsOf = (state: State, tokens: string[]): string => {
    const found = resolveTarget(state, tokens);
    return found.ok ? found.meter.id : `error: ${found.error}`;
  };

  it.each([
    [['claude:weekly'], 'claude:weekly'],
    [['claude:session'], 'claude:session'],
    [['suno-pro:monthly-credits'], 'suno-pro:monthly-credits'],
    [['gpt-5:weekly'], 'gpt-5:weekly'],
    [['suno-pro'], 'suno-pro:monthly-credits'],
    [['gpt-5'], 'gpt-5:weekly'],
    [['suno-pro', 'monthly-credits'], 'suno-pro:monthly-credits'],
    [['claude'], 'claude:weekly'],
    [['Claude'], 'claude:weekly'],
    [['claude', 'weekly'], 'claude:weekly'],
    [['claude', 'session'], 'claude:session'],
    [['claude', 'sess'], 'claude:session'],
    [['cl', 'week'], 'claude:weekly'],
    [['max'], 'claude:weekly'],
    [['suno'], 'suno-pro:monthly-credits'],
    [['suno', 'pro'], 'suno-pro:monthly-credits'],
    [['suno', 'monthly'], 'suno-pro:monthly-credits'],
    [['suno', 'cred'], 'suno-pro:monthly-credits'],
    [['eleven'], 'elevenlabs:characters'],
    [['gpt', '5'], 'gpt-5:weekly'],
    [['gpt', '5', 'weekly'], 'gpt-5:weekly'],
    [['codex'], 'gpt-5:weekly'],
    [['gemini'], 'jobbet:daily'],
    [['jobbet', 'daily'], 'jobbet:daily']
  ] as [string[], string][])('%j is %s', (tokens, expected) => {
    expect(idsOf(fixture(), tokens)).toBe(expected);
  });

  it('means the first allowance that carries value when only the account is named', () => {
    const state = fixture();
    const claude = state.accounts[0] as Account;
    expect(claude.meters.map((meter) => meter.role)).toEqual(['throttle', 'allowance']);
    expect(defaultMeter(claude)?.id).toBe('claude:weekly');

    const onlyThrottle = add(emptyState(), 'Gate', [{ label: 'Session', role: 'throttle', reset: { kind: 'rolling', hours: 5 } }]);
    expect(defaultMeter(onlyThrottle.accounts[0] as Account)?.id).toBe('gate:session');

    const shares = add(emptyState(), 'Plan', [
      { label: 'Sub limit', reset: { kind: 'none' }, valueShare: 0 },
      { label: 'Main', reset: { kind: 'none' }, valueShare: 1 }
    ]);
    expect(defaultMeter(shares.accounts[0] as Account)?.id).toBe('plan:main');
  });

  it('offers every account when nothing matches', () => {
    const state = fixture();
    const found = resolveTarget(state, ['midjourney']);
    expect(found.ok).toBe(false);
    if (found.ok) return;
    expect(found.error).toContain('midjourney');
    expect(found.candidates.map((candidate) => candidate.accountId)).toEqual(state.accounts.map((account) => account.id));
    expect(found.candidates.every((candidate) => candidate.meterId === null)).toBe(true);
    expect(found.candidates[1]).toEqual({ accountId: 'suno-pro', meterId: null, label: 'Suno Pro' });
  });

  it('offers every account when no name is given', () => {
    for (const tokens of [[], ['   '], ['--']]) {
      const found = resolveTarget(fixture(), tokens);
      expect(found.ok).toBe(false);
      if (!found.ok) expect(found.candidates).toHaveLength(7);
    }
  });

  it('does not match a meter of the wrong account', () => {
    const found = resolveTarget(fixture(), ['copilot', 'weekly']);
    expect(found.ok).toBe(false);
  });

  it('reports the meters that tie when a name fits more than one', () => {
    let state = add(emptyState(), 'Claude Max', [{ label: 'Weekly', reset: { kind: 'interval', hours: 168 } }], { providerId: 'claude' });
    state = add(state, 'Claude Pro', [{ label: 'Weekly', reset: { kind: 'interval', hours: 168 } }], { providerId: 'claude' });
    state = add(state, 'Suno', [{ label: 'Credits', unit: 'credits', limit: 2500, reset: { kind: 'none' } }]);
    const found = resolveTarget(state, ['claude']);
    expect(found.ok).toBe(false);
    if (found.ok) return;
    expect(found.error).toMatch(/more than one/);
    expect(found.candidates).toEqual([
      { accountId: 'claude-max', meterId: 'claude-max:weekly', label: 'Claude Max, Weekly' },
      { accountId: 'claude-pro', meterId: 'claude-pro:weekly', label: 'Claude Pro, Weekly' }
    ]);
    // One more word settles it, and so does either id.
    expect(idsOf(state, ['claude', 'pro'])).toBe('claude-pro:weekly');
    expect(idsOf(state, ['claude-max'])).toBe('claude-max:weekly');
    expect(idsOf(state, ['claude-pro:weekly'])).toBe('claude-pro:weekly');
  });

  it('takes an exact account id over another account whose id merely starts the same (review finding)', () => {
    // Two subscriptions with one name: the second gets a numbered id, and the first id is a prefix of it.
    let state = add(emptyState(), 'Claude Max', [{ label: 'Weekly', reset: { kind: 'none' } }]);
    state = add(state, 'Claude Max', [{ label: 'Weekly', reset: { kind: 'none' } }]);
    const [first, second] = state.accounts.map((account) => account.id) as [string, string];
    expect(second.startsWith(first)).toBe(true);
    expect(idsOf(state, [first])).toBe(`${first}:weekly`);
    expect(idsOf(state, [second])).toBe(`${second}:weekly`);
    // The shared name alone is still a question.
    expect(idsOf(state, ['claude', 'max'])).toMatch(/^error: /);
  });

  it('prefers an exact name over a longer one that merely starts the same', () => {
    let state = add(emptyState(), 'Claude Code', [{ label: 'Weekly', reset: { kind: 'none' } }]);
    state = add(state, 'Claude', [
      { label: 'Weekly Opus', reset: { kind: 'none' } },
      { label: 'Weekly', reset: { kind: 'none' } }
    ]);
    expect(idsOf(state, ['claude'])).toBe('claude:weekly-opus'); // the exact account, then its main allowance
    expect(idsOf(state, ['claude', 'weekly'])).toBe('claude:weekly');
    expect(idsOf(state, ['claude', 'weekly', 'opus'])).toBe('claude:weekly-opus');
    expect(idsOf(state, ['claude', 'code'])).toBe('claude-code:weekly');

    const tie = resolveTarget(state, ['claude', 'w']);
    expect(tie.ok).toBe(false);
    if (!tie.ok) {
      expect(tie.candidates.map((candidate) => candidate.meterId).sort()).toEqual(['claude:weekly', 'claude:weekly-opus']);
    }
  });
});

describe('parseQuick', () => {
  const cases: [string, string, Reading][] = [
    // percentages
    ['claude weekly 62%', 'claude:weekly', { usedPercent: 62 }],
    ['claude weekly 62% used', 'claude:weekly', { usedPercent: 62 }],
    ['claude weekly 38% left', 'claude:weekly', { remainingPercent: 38 }],
    ['claude weekly 38% remaining', 'claude:weekly', { remainingPercent: 38 }],
    ['claude 62%', 'claude:weekly', { usedPercent: 62 }],
    ['Claude Weekly 62%', 'claude:weekly', { usedPercent: 62 }],
    ['  claude   weekly   62%  ', 'claude:weekly', { usedPercent: 62 }],
    ['cl week 62%', 'claude:weekly', { usedPercent: 62 }],
    ['claude session 40%', 'claude:session', { usedPercent: 40 }],
    ['claude weekly 62.5%', 'claude:weekly', { usedPercent: 62.5 }],
    ['claude 0%', 'claude:weekly', { usedPercent: 0 }],
    ['claude 100%', 'claude:weekly', { usedPercent: 100 }],
    ['suno 52%', 'suno-pro:monthly-credits', { usedPercent: 52 }],
    ['copilot 40% left', 'copilot:premium-requests', { remainingPercent: 40 }],
    // a bare number on a percentage-only meter can only be a percentage
    ['claude 62', 'claude:weekly', { usedPercent: 62 }],
    ['claude weekly 38 left', 'claude:weekly', { remainingPercent: 38 }],
    // amounts: a bare amount means used
    ['suno 1300', 'suno-pro:monthly-credits', { used: 1300 }],
    ['suno 1300 used', 'suno-pro:monthly-credits', { used: 1300 }],
    ['suno 1200 left', 'suno-pro:monthly-credits', { remaining: 1200 }],
    ['suno 1,200 left', 'suno-pro:monthly-credits', { remaining: 1200 }],
    ['suno monthly 1200 remaining', 'suno-pro:monthly-credits', { remaining: 1200 }],
    ['copilot 120', 'copilot:premium-requests', { used: 120 }],
    ['openrouter $12.40 used', 'openrouter:balance', { used: 12.4 }],
    ['openrouter 37.60 left', 'openrouter:balance', { remaining: 37.6 }],
    // k and M suffixes
    ['suno 1.3k', 'suno-pro:monthly-credits', { used: 1300 }],
    ['suno 1.2K left', 'suno-pro:monthly-credits', { remaining: 1200 }],
    ['eleven 30k', 'elevenlabs:characters', { used: 30_000 }],
    ['eleven 0.05M', 'elevenlabs:characters', { used: 50_000 }],
    ['eleven 0.05m left', 'elevenlabs:characters', { remaining: 50_000 }],
    // ratios carry the limit
    ['copilot 120/300', 'copilot:premium-requests', { used: 120, limit: 300 }],
    ['copilot 180/300 left', 'copilot:premium-requests', { remaining: 180, limit: 300 }],
    ['copilot 1.2k/1.5k', 'copilot:premium-requests', { used: 1200, limit: 1500 }],
    ['eleven 30k/1M', 'elevenlabs:characters', { used: 30_000, limit: 1_000_000 }],
    // "of N" carries the limit too
    ['eleven 30k of 100k', 'elevenlabs:characters', { used: 30_000, limit: 100_000 }],
    ['eleven 70k left of 100k', 'elevenlabs:characters', { remaining: 70_000, limit: 100_000 }],
    ['copilot 120 of 300 used', 'copilot:premium-requests', { used: 120, limit: 300 }],
    ['copilot 120 used of 1,500', 'copilot:premium-requests', { used: 120, limit: 1500 }],
    // on a percentage-only meter the limit says what the count is out of
    ['claude 62/100', 'claude:weekly', { used: 62, limit: 100 }],
    ['claude 50/200', 'claude:weekly', { used: 50, limit: 200 }],
    ['claude 150/200 left', 'claude:weekly', { remaining: 150, limit: 200 }],
    ['claude 50 of 200', 'claude:weekly', { used: 50, limit: 200 }],
    ['claude 25% of 200', 'claude:weekly', { usedPercent: 25, limit: 200 }],
    // names containing numbers
    ['gpt 5 62%', 'gpt-5:weekly', { usedPercent: 62 }],
    ['gpt 5 62% left', 'gpt-5:weekly', { remainingPercent: 62 }],
    ['gpt 5 7', 'gpt-5:weekly', { usedPercent: 7 }],
    ['gpt 5 weekly 62%', 'gpt-5:weekly', { usedPercent: 62 }],
    ['gpt-5 62%', 'gpt-5:weekly', { usedPercent: 62 }],
    // ids
    ['claude:weekly 62%', 'claude:weekly', { usedPercent: 62 }],
    ['claude:session 100%', 'claude:session', { usedPercent: 100 }],
    ['suno-pro 1200 left', 'suno-pro:monthly-credits', { remaining: 1200 }],
    // provider ids
    ['gemini 40', 'jobbet:daily', { used: 40 }],
    ['codex 15%', 'gpt-5:weekly', { usedPercent: 15 }],
    // reset clauses
    ['suno 1200 left resets in 9d', 'suno-pro:monthly-credits', { remaining: 1200, resetsAt: iso(NOW + 9 * DAY) }],
    ['suno 1200 left in 9d', 'suno-pro:monthly-credits', { remaining: 1200, resetsAt: iso(NOW + 9 * DAY) }],
    ['suno 1200 in 9d', 'suno-pro:monthly-credits', { used: 1200, resetsAt: iso(NOW + 9 * DAY) }],
    ['claude 50% in 45m', 'claude:weekly', { usedPercent: 50, resetsAt: iso(NOW + 45 * MINUTE) }],
    ['claude weekly 62% in 3h 20m', 'claude:weekly', { usedPercent: 62, resetsAt: iso(NOW + 3 * HOUR + 20 * MINUTE) }],
    ['claude weekly 62% resets 3h', 'claude:weekly', { usedPercent: 62, resetsAt: iso(NOW + 3 * HOUR) }],
    ['claude weekly 62% resets thu 09:00', 'claude:weekly', { usedPercent: 62, resetsAt: '2026-11-26T09:00:00.000Z' }],
    ['claude weekly 62% resets tomorrow 9am', 'claude:weekly', { usedPercent: 62, resetsAt: '2026-11-20T09:00:00.000Z' }],
    ['claude weekly 62% resets tomorrow', 'claude:weekly', { usedPercent: 62, resetsAt: '2026-11-20T00:00:00.000Z' }],
    ['claude weekly 62% resets 17:30', 'claude:weekly', { usedPercent: 62, resetsAt: '2026-11-19T17:30:00.000Z' }],
    ['claude weekly 62% resets at 17:30', 'claude:weekly', { usedPercent: 62, resetsAt: '2026-11-19T17:30:00.000Z' }],
    ['claude weekly 62% resets 2026-11-21', 'claude:weekly', { usedPercent: 62, resetsAt: '2026-11-21T00:00:00.000Z' }],
    ['claude weekly 62% resets 2026-11-21 09:00', 'claude:weekly', { usedPercent: 62, resetsAt: '2026-11-21T09:00:00.000Z' }],
    ['claude weekly 62% resets 2026-11-21T09:00:00Z', 'claude:weekly', { usedPercent: 62, resetsAt: '2026-11-21T09:00:00.000Z' }],
    ['claude weekly 62% resets nov 21', 'claude:weekly', { usedPercent: 62, resetsAt: '2026-11-21T00:00:00.000Z' }],
    ['claude weekly 62% until fri', 'claude:weekly', { usedPercent: 62, resetsAt: '2026-11-20T00:00:00.000Z' }],
    ['claude weekly 62% left resets on mon 09:00', 'claude:weekly', { remainingPercent: 62, resetsAt: '2026-11-23T09:00:00.000Z' }],
    ['eleven 30k of 100k resets in 2w', 'elevenlabs:characters', { used: 30_000, limit: 100_000, resetsAt: iso(NOW + 14 * DAY) }],
    // a reset alone is a valid update
    ['claude weekly resets in 3h', 'claude:weekly', { resetsAt: iso(NOW + 3 * HOUR) }],
    ['claude resets thu 09:00', 'claude:weekly', { resetsAt: '2026-11-26T09:00:00.000Z' }]
  ];

  it.each(cases)('"%s"', (text, meterId, reading) => {
    const result = ok(text);
    expect(result.meter.id).toBe(meterId);
    expect(result.account.id).toBe(meterId.slice(0, meterId.indexOf(':')));
    expect(result.reading).toEqual(reading);
    expect(result.preview.startsWith(`${result.account.label}, ${result.meter.label}: `)).toBe(true);
  });

  it('produces readings the meter accepts, and changes nothing by itself', () => {
    const state = fixture();
    const before = JSON.stringify(state);
    for (const [text] of cases) {
      const result = ok(text, state);
      expect(() => applyReadingToState(state, result.account.id, result.meter.id, result.reading, NOW)).not.toThrow();
    }
    expect(JSON.stringify(state)).toBe(before);
  });

  describe('previews', () => {
    it('reads "Claude, Weekly: 62% used, 38% left" for "claude weekly 62%"', () => {
      // Scenario: Percentage used.
      const state = fixture();
      const result = ok('claude weekly 62%', state);
      expect(result.preview).toBe('Claude, Weekly: 62% used, 38% left');
      // Confirming stores exactly that reading.
      const saved = applyReadingToState(state, result.account.id, result.meter.id, result.reading, NOW);
      expect(saved.accounts[0]?.meters[1]).toMatchObject({ id: 'claude:weekly', used: 62, updatedAt: iso(NOW) });
    });

    it('shows 1,200 credits left and a reset nine days from now for "suno 1200 left resets in 9d"', () => {
      // Scenario: Amount left with a reset.
      const result = ok('suno 1200 left resets in 9d');
      expect(result.preview).toBe('Suno Pro, Monthly credits: 1,300 credits used, 1,200 credits left (48%), resets Sat 28 Nov 10:00 (in 9d)');
      expect(result.reading.resetsAt).toBe('2026-11-28T10:00:00.000Z');
    });

    it('always spells out both used and left, so a wrong guess shows before saving', () => {
      expect(ok('copilot 120').preview).toBe('Copilot, Premium requests: 120 requests used, 180 requests left (60%)');
      expect(ok('copilot 120 left').preview).toBe('Copilot, Premium requests: 180 requests used, 120 requests left (40%)');
      expect(ok('claude 38% left').preview).toBe('Claude, Weekly: 62% used, 38% left');
      expect(ok('suno 52%').preview).toBe('Suno Pro, Monthly credits: 1,300 credits used, 1,200 credits left (48%)');
      expect(ok('openrouter $12.40 used').preview).toBe('OpenRouter, Balance: $12.40 used, $37.60 left (75%)');
    });

    it('uses the new limit when the line carries one', () => {
      expect(ok('copilot 120/1500').preview).toBe('Copilot, Premium requests: 120 requests used, 1,380 requests left (92%)');
      expect(ok('eleven 30k of 1M').preview).toBe('ElevenLabs, Characters: 30K characters used, 970K characters left (97%)');
    });

    it('turns a count on a percentage-only meter into the share it stands for', () => {
      const state = fixture();
      for (const text of ['claude 50/200', 'claude 150/200 left', 'claude 50 of 200', 'claude 25% of 200', 'claude 25%']) {
        const result = ok(text, state);
        expect(result.preview).toBe('Claude, Weekly: 25% used, 75% left');
        const saved = applyReadingToState(state, result.account.id, result.meter.id, result.reading, NOW);
        expect(saved.accounts[0]?.meters[1]).toMatchObject({ id: 'claude:weekly', used: 25, limit: 100 });
      }
    });

    it('shows a custom noun wherever the unit is displayed', () => {
      // Scenario: Custom noun.
      expect(ok('gemini 40').preview).toBe('Jobbet, Daily: 40 songs used, 460 songs left (92%)');
    });

    it('shows the reset in the given zone', () => {
      const result = ok('claude weekly 62% resets tomorrow 09:00', fixture(), STO);
      expect(result.reading.resetsAt).toBe('2026-11-20T08:00:00.000Z');
      expect(result.preview).toBe('Claude, Weekly: 62% used, 38% left, resets tomorrow 09:00 (in 22h)');
    });

    it('describes a reset-only update', () => {
      expect(ok('claude weekly resets in 3h').preview).toBe('Claude, Weekly: resets today 13:00 (in 3h)');
    });

    it('previewReading agrees with what applying the reading stores', () => {
      const state = fixture();
      for (const text of ['suno 1200 left', 'copilot 40%', 'eleven 30k of 200k', 'copilot 75% left']) {
        const result = ok(text, state);
        const saved = applyReadingToState(state, result.account.id, result.meter.id, result.reading, NOW);
        const meter = saved.accounts.flatMap((account) => account.meters).find((candidate) => candidate.id === result.meter.id) as Meter;
        const left = Math.round(((meter.limit - meter.used) / meter.limit) * 100);
        expect(previewReading(result.account, result.meter, result.reading, NOW, 'UTC')).toBe(result.preview);
        expect(result.preview).toContain(`(${left}%)`);
      }
    });
  });

  describe('rejections', () => {
    it('offers every account when the line matches none', () => {
      // Scenario: Ambiguous or unknown account.
      const state = fixture();
      const before = JSON.stringify(state);
      const result = rejected('midjourney 50%', state);
      expect(result.error).toContain('midjourney');
      expect(result.candidates.map((candidate) => candidate.label)).toEqual(['Claude', 'Suno Pro', 'Copilot', 'ElevenLabs', 'GPT 5', 'OpenRouter', 'Jobbet']);
      expect(JSON.stringify(state)).toBe(before);
    });

    it('offers the matching meters when the line matches more than one', () => {
      // Scenario: Ambiguous or unknown account.
      let state = add(emptyState(), 'Claude Max', [{ label: 'Weekly', reset: { kind: 'interval', hours: 168 } }]);
      state = add(state, 'Claude Pro', [{ label: 'Weekly', reset: { kind: 'interval', hours: 168 } }]);
      const result = rejected('claude 50%', state);
      expect(result.candidates.map((candidate) => candidate.meterId)).toEqual(['claude-max:weekly', 'claude-pro:weekly']);
      expect(result.candidates.map((candidate) => candidate.label)).toEqual(['Claude Max, Weekly', 'Claude Pro, Weekly']);
      // Picking a candidate by its id resolves it.
      expect(ok('claude-pro:weekly 50%', state).meter.id).toBe('claude-pro:weekly');
    });

    it.each([
      ['claude 120%', /between 0 and 100/],
      ['claude weekly 100.5%', /between 0 and 100/],
      ['claude 250', /between 0 and 100/],
      ['suno 120% left', /between 0 and 100/]
    ])('rejects a percentage above 100: "%s"', (text, message) => {
      const result = rejected(text);
      expect(result.error).toMatch(message);
      expect(result.candidates).toEqual([]);
    });

    it.each([
      ['', /account/i],
      ['   ', /account/i],
      ['claude', /amount/i],
      ['claude weekly', /amount/i],
      ['claude weekly 62% banana', /after the amount/],
      ['claude weekly 62 % used', /after the amount/],
      ['claude weekly 62% resets someday', /reset time "someday"/],
      ['claude weekly 62% resets', /reset time/],
      ['claude weekly 62% resets 2026-11-01', /reset time "2026-11-01"/],
      ['claude weekly 62% in a while', /reset time/],
      ['62%', /./],
      ['weekly 62%', /No account matches/]
    ])('rejects "%s"', (text, message) => {
      expect(rejected(text).error).toMatch(message);
    });

    it('offers the accounts for an empty line', () => {
      expect(rejected('').candidates).toHaveLength(7);
    });
  });
});

describe('a meter word that also occurs in the account name', () => {
  const NOW_MS = Date.parse('2026-11-19T10:00:00Z');
  const state = addAccount(emptyState(), {
    label: 'Max Plan',
    meters: [
      { label: 'Weekly', unit: 'percent', reset: { kind: 'interval', hours: 168 } },
      { label: 'Max burst', unit: 'percent', reset: { kind: 'interval', hours: 168 }, valueShare: 0 }
    ]
  }, NOW_MS).state;

  it('is left over for the meter instead of being swallowed by the account', () => {
    const found = resolveTarget(state, ['max-plan', 'max']);
    expect(found.ok && found.meter.label).toBe('Max burst');
    const parsed = parseQuick('max plan max 30%', state, NOW_MS, 'UTC');
    expect(parsed.ok && parsed.meter.label).toBe('Max burst');
  });

  it('still reads the bare account name as its main meter', () => {
    const found = resolveTarget(state, ['max', 'plan']);
    expect(found.ok && found.meter.label).toBe('Weekly');
  });

  it('resolves a meter inside a known account by key, label or words', () => {
    const account = state.accounts[0]!;
    expect(resolveMeterIn(account, 'max')).toMatchObject({ ok: true, meter: { label: 'Max burst' } });
    expect(resolveMeterIn(account, 'weekly')).toMatchObject({ ok: true, meter: { label: 'Weekly' } });
    expect(resolveMeterIn(account, '')).toMatchObject({ ok: true, meter: { label: 'Weekly' } });
    const missing = resolveMeterIn(account, 'monthly');
    expect(missing.ok).toBe(false);
    expect(!missing.ok && missing.candidates.map((candidate) => candidate.meterId)).toEqual(['max-plan:weekly', 'max-plan:max-burst']);
  });
});


describe('input that used to be misread instead of refused (review finding)', () => {
  it('reads a day only from the start of its name, so words that merely begin like one are not days', () => {
    // Thursday 19 November 2026: the next Monday is the 23rd, the next Thursday the 26th.
    for (const word of ['mon', 'monday', 'Mon']) expect(parseWhen(word, NOW, 'UTC'), word).toBe(utc(2026, 11, 23));
    for (const word of ['thu', 'thur', 'thurs', 'thursday']) expect(parseWhen(`${word} 09:00`, NOW, 'UTC'), word).toBe(utc(2026, 11, 26, 9, 0));
    for (const word of ['wed', 'weds', 'wednesday']) expect(parseWhen(word, NOW, 'UTC'), word).toBe(utc(2026, 11, 25));
    for (const word of ['monthly', 'month', 'months', 'friend', 'sunset', 'sunny', 'satisfied', 'tuesdays', 'wedding', 'mo']) {
      expect(parseWhen(word, NOW, 'UTC'), word).toBeNull();
    }
  });

  it('reads a month only from the start of its name', () => {
    for (const text of ['dec 5', '5 dec', 'december 5', 'decem 5']) expect(parseWhen(text, NOW, 'UTC'), text).toBe(utc(2026, 12, 5));
    expect(parseWhen('sept 3', NOW, 'UTC')).toBe(utc(2027, 9, 3));
    for (const text of ['decade 5', 'marching 3', 'mayor 3', 'ju 3', 'junk 3']) expect(parseWhen(text, NOW, 'UTC'), text).toBeNull();
  });

  it('refuses a day the calendar does not have instead of sliding into the next month', () => {
    for (const text of ['nov 31', '31 nov', '2026-11-31', '2026-11-31 09:00', 'feb 30', '2027-02-29', 'jun 31 18:00']) {
      expect(parseWhen(text, NOW, 'UTC'), text).toBeNull();
    }
    // The 29th of February exists in 2028 only, and "feb 29" means the coming one or nothing.
    expect(parseWhen('feb 29', NOW, 'UTC')).toBeNull();
    expect(parseWhen('2028-02-29', NOW, 'UTC')).toBe(utc(2028, 2, 29));
    expect(parseWhen('nov 30', NOW, 'UTC')).toBe(utc(2026, 11, 30));
  });

  it('does not change a schedule on the strength of a word it did not understand', () => {
    const refused = rejected('copilot 40% resets monthly');
    expect(refused.error).toMatch(/monthly/);
    expect(rejected('copilot 40% resets nov 31').error).toMatch(/nov 31/);
    // The same line with a real day still works.
    expect(ok('copilot 40% resets mon').reading).toMatchObject({ usedPercent: 40, resetsAt: iso(utc(2026, 11, 23)) });
  });

  it('reads commas as thousands separators only, and refuses a decimal comma', () => {
    expect(ok('suno 1,200 left').reading).toMatchObject({ remaining: 1200 });
    expect(ok('elevenlabs 12,500 used').reading).toMatchObject({ used: 12_500 });
    expect(ok('elevenlabs 1,234,567 used').reading).toMatchObject({ used: 1_234_567 });
    expect(ok('suno 1.5k left').reading).toMatchObject({ remaining: 1500 });
    for (const text of ['suno 1,5k left', 'suno 12,40 used', 'suno 1,23 left', 'suno 1,2345 left', 'suno ,500 left', 'suno 1,,200 left']) {
      const result = parseQuick(text, fixture(), NOW, 'UTC');
      expect(result.ok, text).toBe(false);
    }
  });
});
