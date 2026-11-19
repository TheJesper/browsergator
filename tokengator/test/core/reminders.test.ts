import { describe, expect, it } from 'vitest';

import { addAccount, updateAccount, type AccountInput, type MeterInput } from '../../src/core/accounts.js';
import { MAX_REMINDER_KEYS, calendarFeed, digestReminders, dueReminders, rememberReminders } from '../../src/core/reminders.js';
import { DAY, HOUR, iso } from '../../src/core/time.js';
import { emptyState, type State } from '../../src/core/types.js';

const utc = (y: number, mo: number, d: number, h = 0, mi = 0): number => Date.UTC(y, mo - 1, d, h, mi, 0);
/** Thursday 19 November 2026, 10:00 UTC. */
const NOW = utc(2026, 11, 19, 10, 0);

/** A weekly percent meter that resets in `hours` from now with `usedPercent` used. */
const weekly = (hours: number, usedPercent: number, extra: Partial<MeterInput> = {}): MeterInput => ({
  label: 'Weekly limit',
  reset: { kind: 'interval', hours: 168 },
  used: usedPercent,
  resetsAt: iso(NOW + hours * HOUR),
  ...extra
});

function add(state: State, label: string, meters: MeterInput[], extra: Partial<AccountInput> = {}): State {
  return addAccount(state, { label, meters, ...extra }, NOW).state;
}

describe('dueReminders', () => {
  it('raises a quota that resets soon with quota left, and says how much, when, and what it is worth', () => {
    const state = add(emptyState(), 'Claude Max', [weekly(14, 62)], { price: { amount: 100, currency: 'USD', period: 'month' } });
    const due = dueReminders(state, NOW, [], 'UTC');
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({
      key: `claude-max:weekly-limit@${NOW + 14 * HOUR}`,
      meterId: 'claude-max:weekly-limit',
      title: 'Use Claude Max now',
      resetsAtMs: NOW + 14 * HOUR
    });
    expect(due[0]?.body).toContain('38% left of the weekly limit, resets in 14h (tomorrow 00:00).');
    expect(due[0]?.body).toMatch(/About \$\d+\.\d\d expires at this pace\./);
  });

  it('stays quiet for quotas that are on pace, used up, far from their reset, or snoozed', () => {
    let state = add(emptyState(), 'Far', [weekly(120, 10)]);
    state = add(state, 'Spent', [weekly(6, 100)]);
    state = add(state, 'Nearly spent', [weekly(6, 95)]);
    state = add(state, 'Snoozed', [weekly(6, 20)]);
    state = updateAccount(state, 'snoozed', { snoozedUntil: iso(NOW + DAY) }, NOW);
    expect(dueReminders(state, NOW, [], 'UTC')).toEqual([]);
  });

  it('raises each window once', () => {
    const state = add(emptyState(), 'Claude Max', [weekly(14, 62)]);
    const [first] = dueReminders(state, NOW, [], 'UTC');
    expect(dueReminders(state, NOW + HOUR, [first?.key ?? ''], 'UTC')).toEqual([]);
    // The next window is a different key, so it is raised again when its turn comes.
    const next = add(emptyState(), 'Claude Max', [weekly(14 + 168, 62)]);
    expect(dueReminders(next, NOW + 168 * HOUR, [first?.key ?? ''], 'UTC')).toHaveLength(1);
  });

  it('treats a reset time that moved by a few minutes as the same window', () => {
    const state = add(emptyState(), 'Codex', [weekly(14, 62)]);
    const jittered = `codex:weekly-limit@${NOW + 14 * HOUR + 4 * 60_000}`;
    expect(dueReminders(state, NOW, [jittered], 'UTC')).toEqual([]);
    const otherWindow = `codex:weekly-limit@${NOW + 14 * HOUR - 2 * HOUR}`;
    expect(dueReminders(state, NOW, [otherWindow], 'UTC')).toHaveLength(1);
    // A key for another meter, or one that is not a key at all, changes nothing.
    expect(dueReminders(state, NOW, [`other:weekly-limit@${NOW + 14 * HOUR}`, 'garbage', '@5'], 'UTC')).toHaveLength(1);
  });

  it('never raises a session or a daily limit, however much is left', () => {
    const daily: MeterInput = { label: 'Daily requests', reset: { kind: 'daily', time: '11:00', tz: 'UTC' }, used: 10 };
    const fiveHour: MeterInput = { label: 'Session', reset: { kind: 'interval', hours: 5 }, used: 10, resetsAt: iso(NOW + HOUR) };
    let state = add(emptyState(), 'Gemini', [daily]);
    state = add(state, 'Short', [fiveHour]);
    expect(dueReminders(state, NOW, [], 'UTC')).toEqual([]);
  });

  it('puts the most urgent first', () => {
    let state = add(emptyState(), 'Later', [weekly(20, 30)]);
    state = add(state, 'Sooner', [weekly(3, 30)]);
    expect(dueReminders(state, NOW, [], 'UTC').map((reminder) => reminder.title)).toEqual(['Use Sooner now', 'Use Later now']);
  });

  it('says when a closed session limit reopens, and drops the reminder when it reopens too late to matter', () => {
    const session = (hours: number): MeterInput => ({ label: '5-hour session', role: 'throttle', reset: { kind: 'rolling', hours: 5 }, used: 100, resetsAt: iso(NOW + hours * HOUR) });
    const reopens = add(emptyState(), 'Claude Max', [weekly(14, 62), session(2)]);
    const [reminder] = dueReminders(reopens, NOW, [], 'UTC');
    expect(reminder?.body).toContain('Usable again today 12:00, when the 5-hour session reopens.');

    const tooLate = add(emptyState(), 'Claude Max', [weekly(1.5, 62), session(2)]);
    expect(dueReminders(tooLate, NOW, [], 'UTC')).toEqual([]);
  });

  it('warns when the reading behind it is old', () => {
    const state = add(emptyState(), 'Claude Max', [weekly(14 + 72, 62)]);
    // Three days on, nobody has updated the number.
    const [reminder] = dueReminders(state, NOW + 72 * HOUR, [], 'UTC');
    expect(reminder?.body).toContain('The reading is old, so check the real number first.');
  });
});

describe('digestReminders', () => {
  it('is nothing for no reminders and the reminder itself for one', () => {
    expect(digestReminders([])).toBeNull();
    const state = add(emptyState(), 'Claude Max', [weekly(14, 62)]);
    const due = dueReminders(state, NOW, [], 'UTC');
    expect(digestReminders(due)).toEqual({ title: due[0]?.title, body: due[0]?.body });
  });

  it('folds several into one message of at most three lines and a count', () => {
    let state = emptyState();
    for (const [index, name] of ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo'].entries()) state = add(state, name, [weekly(3 + index, 40)]);
    const digest = digestReminders(dueReminders(state, NOW, [], 'UTC'));
    expect(digest?.title).toBe('5 quotas to use now');
    expect(digest?.body.split('\n')).toEqual([
      'Alpha: 60% left of the weekly limit, resets in 3h (today 13:00).',
      'Bravo: 60% left of the weekly limit, resets in 4h (today 14:00).',
      'Charlie: 60% left of the weekly limit, resets in 5h (today 15:00).',
      'And 2 more.'
    ]);
  });
});

describe('rememberReminders', () => {
  it('adds the new keys, forgets windows that have ended, and stays bounded', () => {
    const past = `a:b@${NOW - 1}`;
    const live = `a:b@${NOW + HOUR}`;
    const fresh = `c:d@${NOW + 2 * HOUR}`;
    expect(rememberReminders([past, live], [fresh, live], NOW)).toEqual([live, fresh]);
    expect(rememberReminders(['not-a-key'], [], NOW)).toEqual([]);
    const many = Array.from({ length: MAX_REMINDER_KEYS + 50 }, (_, index) => `m:${index}@${NOW + HOUR}`);
    const kept = rememberReminders(many, [], NOW);
    expect(kept).toHaveLength(MAX_REMINDER_KEYS);
    expect(kept.at(-1)).toBe(many.at(-1));
  });
});

describe('calendarFeed', () => {
  const unfold = (feed: string): string[] => feed.replace(/\r\n /g, '').split('\r\n');
  const events = (feed: string): string[][] => {
    const out: string[][] = [];
    let current: string[] | null = null;
    for (const line of unfold(feed)) {
      if (line === 'BEGIN:VEVENT') current = [];
      else if (line === 'END:VEVENT' && current) {
        out.push(current);
        current = null;
      } else if (current) current.push(line);
    }
    return out;
  };
  const field = (event: string[], name: string): string | undefined => event.find((line) => line.startsWith(`${name}:`))?.slice(name.length + 1);

  it('is a valid, empty calendar when nothing is tracked', () => {
    const feed = calendarFeed(emptyState(), NOW);
    expect(feed.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n')).toBe(true);
    expect(feed.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(events(feed)).toEqual([]);
  });

  it('lists the coming resets of a weekly quota, each covering the last stretch before the reset', () => {
    const state = add(emptyState(), 'Claude Max', [weekly(14, 62)], { usageUrl: 'https://claude.ai/settings/usage' });
    const feed = calendarFeed(state, NOW, { daysAhead: 30, dashboardUrl: 'http://127.0.0.1:4777/' });
    const list = events(feed);
    // 14 hours from now, then weekly: four more inside thirty days.
    expect(list.map((event) => field(event, 'DTEND'))).toEqual(['20261120T000000Z', '20261127T000000Z', '20261204T000000Z', '20261211T000000Z', '20261218T000000Z']);
    // 15% of a week is 25.2 hours. The first entry would start in the past, so it starts now.
    expect(field(list[0] as string[], 'DTSTART')).toBe('20261119T100000Z');
    expect(field(list[1] as string[], 'DTSTART')).toBe('20261125T224800Z');
    expect(field(list[1] as string[], 'SUMMARY')).toBe('Use up Claude Max: weekly limit resets');
    expect(field(list[1] as string[], 'DESCRIPTION')).toBe(
      'The weekly limit of Claude Max resets at the end of this entry. Whatever is left then expires.\\nWhat is left right now: http://127.0.0.1:4777/\\nUsage page: https://claude.ai/settings/usage'
    );
    expect(list[1]).toContain('TRIGGER:PT0S');
    expect(new Set(list.map((event) => field(event, 'UID'))).size).toBe(list.length);
  });

  it('words each alarm by the time actually left when it rings (review finding)', () => {
    const state = add(emptyState(), 'Claude Max', [weekly(14, 62)]);
    const alarms = events(calendarFeed(state, NOW, { daysAhead: 10 })).map((event) => event.filter((line) => line.startsWith('DESCRIPTION:')).at(-1));
    // The window under way has 14 hours left, not the full day and an hour of a later one.
    expect(alarms).toEqual(['DESCRIPTION:Claude Max: weekly limit resets in 14h', 'DESCRIPTION:Claude Max: weekly limit resets in 1d 1h']);
  });

  it('lists nothing beyond its range, a first reset included', () => {
    const state = add(emptyState(), 'Claude Max', [weekly(120, 62)]);
    expect(events(calendarFeed(state, NOW, { daysAhead: 4 }))).toEqual([]);
    expect(events(calendarFeed(state, NOW, { daysAhead: 5 }))).toHaveLength(1);
  });

  it('follows the calendar for monthly quotas', () => {
    const monthly: MeterInput = { label: 'Credits', unit: 'credits', limit: 1000, used: 100, reset: { kind: 'monthly', day: 1, time: '00:00', tz: 'UTC' } };
    const feed = calendarFeed(add(emptyState(), 'Suno', [monthly]), NOW, { daysAhead: 75 });
    expect(events(feed).map((event) => field(event, 'DTEND'))).toEqual(['20261201T000000Z', '20270101T000000Z', '20270201T000000Z']);
  });

  it('leaves out what does not expire at a reset: session limits, carried-over quota, balances, snoozed accounts', () => {
    let state = add(emptyState(), 'Claude', [{ label: '5-hour session', role: 'throttle', reset: { kind: 'rolling', hours: 5 }, used: 10, resetsAt: iso(NOW + HOUR) }]);
    state = add(state, 'Eleven', [weekly(14, 10, { rollover: 'carries' })]);
    state = add(state, 'Prepaid', [{ label: 'Balance', unit: 'usd', limit: 50, used: 5, reset: { kind: 'none' } }]);
    state = add(state, 'Daily', [{ label: 'Daily', reset: { kind: 'daily', time: '00:00', tz: 'UTC' }, used: 5 }]);
    state = add(state, 'Asleep', [weekly(14, 10)]);
    state = updateAccount(state, 'asleep', { snoozedUntil: iso(NOW + DAY) }, NOW);
    expect(events(calendarFeed(state, NOW))).toEqual([]);
  });

  it('lists a first-use window once, since the next one opens only when it is used', () => {
    const rolling: MeterInput = { label: 'Weekly', reset: { kind: 'rolling', hours: 168 }, used: 30, resetsAt: iso(NOW + 30 * HOUR) };
    expect(events(calendarFeed(add(emptyState(), 'Codex', [rolling]), NOW))).toHaveLength(1);
  });

  it('never lets a name start a calendar line of its own', () => {
    const state = add(emptyState(), 'Claude Max', [weekly(14, 62)]);
    const edited: State = {
      ...state,
      accounts: state.accounts.map((account) => ({ ...account, label: 'Claude\rATTENDEE:mailto:x@evil.example\nMax' }))
    };
    const feed = calendarFeed(edited, NOW, { daysAhead: 1 });
    const lines = feed.replace(/\r\n /g, '').split('\r\n');
    expect(lines.some((line) => line.startsWith('ATTENDEE'))).toBe(false);
    // Every line break in the document is the CR LF that ends a line.
    expect(feed.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
  });

  it('escapes text and folds long lines to 75 octets', () => {
    const state = add(emptyState(), 'Tëam; Acme, Inc. — a long account name that keeps on going', [weekly(14, 62, { label: 'Wëekly limit' })]);
    const feed = calendarFeed(state, NOW, { daysAhead: 1 });
    for (const line of feed.split('\r\n')) expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75);
    const [event] = events(feed);
    expect(field(event as string[], 'SUMMARY')).toBe('Use up Tëam\\; Acme\\, Inc. — a long account name that keeps on going: wëekly limit resets');
  });
});
