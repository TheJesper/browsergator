import { describe, expect, it } from 'vitest';

import {
  DAY,
  HOUR,
  MINUTE,
  MONTH,
  clamp,
  dateKey,
  daysInMonth,
  formatAge,
  formatDuration,
  formatMoment,
  isValidTimeZone,
  iso,
  parseClock,
  toMs,
  zonedParts,
  zonedTimeToUtc
} from '../../src/core/time.js';

const LA = 'America/Los_Angeles';
const STO = 'Europe/Stockholm';

const utc = (y: number, mo: number, d: number, h = 0, mi = 0): number => Date.UTC(y, mo - 1, d, h, mi, 0);

describe('zonedTimeToUtc', () => {
  it('is the identity in UTC', () => {
    expect(zonedTimeToUtc(2026, 11, 19, 10, 30, 'UTC')).toBe(utc(2026, 11, 19, 10, 30));
  });

  // 2026: US clocks go forward on 8 March (02:00 PST -> 03:00 PDT) and back on 1 November.
  it.each([
    ['the day before spring forward', [2026, 3, 7, 0, 0], utc(2026, 3, 7, 8, 0)],
    ['midnight on the spring-forward day (still PST)', [2026, 3, 8, 0, 0], utc(2026, 3, 8, 8, 0)],
    ['the last minute before the jump', [2026, 3, 8, 1, 59], utc(2026, 3, 8, 9, 59)],
    ['the first wall time after the jump', [2026, 3, 8, 3, 0], utc(2026, 3, 8, 10, 0)],
    ['noon on the spring-forward day (PDT)', [2026, 3, 8, 12, 0], utc(2026, 3, 8, 19, 0)],
    ['midnight after spring forward (PDT)', [2026, 3, 9, 0, 0], utc(2026, 3, 9, 7, 0)],
    ['midnight on the fall-back day (still PDT)', [2026, 11, 1, 0, 0], utc(2026, 11, 1, 7, 0)],
    ['after the repeated hour (PST)', [2026, 11, 1, 3, 0], utc(2026, 11, 1, 11, 0)],
    ['midnight after fall back (PST)', [2026, 11, 2, 0, 0], utc(2026, 11, 2, 8, 0)]
  ] as const)('America/Los_Angeles: %s', (_name, fields, expected) => {
    const [y, mo, d, h, mi] = fields;
    expect(iso(zonedTimeToUtc(y, mo, d, h, mi, LA))).toBe(iso(expected));
  });

  // 2026: Swedish clocks go forward on 29 March (02:00 CET -> 03:00 CEST) and back on 25 October.
  it.each([
    ['winter', [2026, 1, 15, 9, 0], utc(2026, 1, 15, 8, 0)],
    ['midnight on the spring-forward day (still CET)', [2026, 3, 29, 0, 0], utc(2026, 3, 28, 23, 0)],
    ['the last wall time before the jump', [2026, 3, 29, 1, 30], utc(2026, 3, 29, 0, 30)],
    ['the first wall time after the jump', [2026, 3, 29, 3, 0], utc(2026, 3, 29, 1, 0)],
    ['midnight after spring forward (CEST)', [2026, 3, 30, 0, 0], utc(2026, 3, 29, 22, 0)],
    ['summer', [2026, 7, 1, 9, 0], utc(2026, 7, 1, 7, 0)],
    ['before the repeated hour on the fall-back day (CEST)', [2026, 10, 25, 1, 30], utc(2026, 10, 24, 23, 30)],
    ['after the repeated hour (CET)', [2026, 10, 25, 3, 30], utc(2026, 10, 25, 2, 30)],
    ['midnight after fall back (CET)', [2026, 10, 26, 0, 0], utc(2026, 10, 25, 23, 0)]
  ] as const)('Europe/Stockholm: %s', (_name, fields, expected) => {
    const [y, mo, d, h, mi] = fields;
    expect(iso(zonedTimeToUtc(y, mo, d, h, mi, STO))).toBe(iso(expected));
  });

  it('round-trips through zonedParts for every hour of both DST days in both zones', () => {
    const days: [string, number, number, number][] = [
      [LA, 2026, 3, 8],
      [LA, 2026, 11, 1],
      [STO, 2026, 3, 29],
      [STO, 2026, 10, 25]
    ];
    for (const [tz, y, mo, d] of days) {
      for (let hour = 0; hour < 24; hour += 1) {
        // Hour 2 does not exist on the spring-forward days; it is covered separately below.
        if (mo === 3 && hour === 2) continue;
        const parts = zonedParts(zonedTimeToUtc(y, mo, d, hour, 15, tz), tz);
        expect([tz, parts.year, parts.month, parts.day, parts.hour, parts.minute]).toEqual([tz, y, mo, d, hour, 15]);
      }
    }
  });

  it('keeps a wall time skipped by the jump within an hour of the jump', () => {
    const jumpLa = utc(2026, 3, 8, 10, 0);
    const jumpSto = utc(2026, 3, 29, 1, 0);
    expect(Math.abs(zonedTimeToUtc(2026, 3, 8, 2, 30, LA) - jumpLa)).toBeLessThanOrEqual(30 * MINUTE);
    expect(Math.abs(zonedTimeToUtc(2026, 3, 29, 2, 30, STO) - jumpSto)).toBeLessThanOrEqual(30 * MINUTE);
  });

  it('resolves a repeated wall time to one of its two instants', () => {
    const la = zonedTimeToUtc(2026, 11, 1, 1, 30, LA);
    expect([utc(2026, 11, 1, 8, 30), utc(2026, 11, 1, 9, 30)]).toContain(la);
    const sto = zonedTimeToUtc(2026, 10, 25, 2, 30, STO);
    expect([utc(2026, 10, 25, 0, 30), utc(2026, 10, 25, 1, 30)]).toContain(sto);
  });

  it('normalises overflowing fields like Date.UTC', () => {
    expect(zonedTimeToUtc(2026, 13, 1, 0, 0, 'UTC')).toBe(utc(2027, 1, 1));
    expect(zonedTimeToUtc(2026, 11, 31, 0, 0, 'UTC')).toBe(utc(2026, 12, 1));
    expect(zonedTimeToUtc(2026, 3, 0, 0, 0, 'UTC')).toBe(utc(2026, 2, 28));
    // The day after 7 March in Los Angeles is the spring-forward day itself.
    expect(zonedTimeToUtc(2026, 3, 7 + 2, 0, 0, LA)).toBe(utc(2026, 3, 9, 7, 0));
  });
});

describe('zonedParts', () => {
  it('reads the wall clock of an instant in a zone, with midnight as hour 0', () => {
    expect(zonedParts(utc(2026, 11, 19, 0, 0), 'UTC')).toEqual({ year: 2026, month: 11, day: 19, hour: 0, minute: 0, second: 0 });
    expect(zonedParts(utc(2026, 11, 19, 8, 0), LA)).toMatchObject({ year: 2026, month: 11, day: 19, hour: 0, minute: 0 });
    expect(zonedParts(utc(2026, 12, 31, 23, 30), STO)).toMatchObject({ year: 2027, month: 1, day: 1, hour: 0, minute: 30 });
  });
});

describe('daysInMonth', () => {
  it.each([
    [2026, 1, 31],
    [2026, 2, 28],
    [2028, 2, 29],
    [2100, 2, 28],
    [2000, 2, 29],
    [2026, 4, 30],
    [2026, 11, 30],
    [2026, 12, 31]
  ])('%i-%i has %i days', (year, month, expected) => {
    expect(daysInMonth(year, month)).toBe(expected);
  });
});

describe('formatDuration', () => {
  it.each([
    [0, '<1m'],
    [59_000, '<1m'],
    [MINUTE, '1m'],
    [9 * MINUTE, '9m'],
    [59 * MINUTE + 59_000, '59m'],
    [HOUR, '1h'],
    [70 * MINUTE, '1h 10m'],
    [3 * HOUR + 12 * MINUTE, '3h 12m'],
    [14 * HOUR, '14h'],
    [20 * HOUR, '20h'],
    [DAY, '1d'],
    [2 * DAY + 4 * HOUR, '2d 4h'],
    [2 * DAY + 4 * HOUR + 59 * MINUTE, '2d 4h'],
    [9 * DAY, '9d'],
    [9 * DAY + 23 * HOUR, '9d 23h'],
    [10 * DAY + 5 * HOUR, '10d'],
    [23 * DAY + 11 * HOUR, '23d']
  ])('%i ms reads "%s"', (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });

  it('describes the past and refuses nonsense', () => {
    expect(formatDuration(-30_000)).toBe('now');
    expect(formatDuration(-3 * HOUR)).toBe('3h ago');
    expect(formatDuration(Number.NaN)).toBe('');
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe('');
  });
});

describe('formatAge', () => {
  it.each([
    [0, 'just now'],
    [59_000, 'just now'],
    [12 * MINUTE, '12m ago'],
    [3 * HOUR + 59 * MINUTE, '3h ago'],
    [3 * DAY, '3d ago'],
    [Number.POSITIVE_INFINITY, 'never']
  ])('%d ms reads "%s"', (ms, expected) => {
    expect(formatAge(ms)).toBe(expected);
  });
});

describe('formatMoment', () => {
  // Thursday 19 November 2026, 10:00 UTC.
  const now = utc(2026, 11, 19, 10, 0);

  it.each([
    ['later today', utc(2026, 11, 19, 14, 5), 'today 14:05'],
    ['earlier today', utc(2026, 11, 19, 0, 0), 'today 00:00'],
    ['tomorrow', utc(2026, 11, 20, 9, 0), 'tomorrow 09:00'],
    ['yesterday', utc(2026, 11, 18, 23, 59), 'yesterday 23:59'],
    ['within the week', utc(2026, 11, 22, 9, 0), 'Sun 09:00'],
    ['six days ahead', utc(2026, 11, 25, 9, 0), 'Wed 09:00'],
    ['a week ahead', utc(2026, 11, 26, 9, 0), 'Thu 26 Nov 09:00'],
    ['later this year', utc(2026, 12, 1, 0, 0), 'Tue 1 Dec 00:00'],
    ['further back', utc(2026, 11, 13, 0, 0), 'Fri 13 Nov 00:00'],
    ['another year', utc(2027, 1, 12, 8, 30), 'Tue 12 Jan 2027 08:30']
  ])('%s', (_name, at, expected) => {
    expect(formatMoment(at, now, 'UTC')).toBe(expected);
  });

  it('counts days in the viewer zone, not in UTC', () => {
    // 23:30 UTC on the 19th is already 00:30 on the 20th in Stockholm.
    expect(formatMoment(utc(2026, 11, 19, 23, 30), now, STO)).toBe('tomorrow 00:30');
    // 02:00 UTC on the 20th is still the evening of the 19th in Los Angeles.
    expect(formatMoment(utc(2026, 11, 20, 2, 0), now, LA)).toBe('today 18:00');
  });

  it('is not thrown off by a 23-hour day', () => {
    const before = zonedTimeToUtc(2026, 3, 7, 12, 0, LA);
    expect(formatMoment(zonedTimeToUtc(2026, 3, 8, 12, 0, LA), before, LA)).toBe('tomorrow 12:00');
    expect(formatMoment(zonedTimeToUtc(2026, 3, 9, 0, 0, LA), before, LA)).toBe('Mon 00:00');
  });
});

describe('dateKey', () => {
  it('is the calendar day of an instant in a zone', () => {
    const at = utc(2026, 11, 19, 23, 30);
    expect(dateKey(at, 'UTC')).toBe('2026-11-19');
    expect(dateKey(at, STO)).toBe('2026-11-20');
    expect(dateKey(utc(2026, 11, 19, 2, 0), LA)).toBe('2026-11-18');
    expect(dateKey(utc(2026, 1, 5, 0, 0), 'UTC')).toBe('2026-01-05');
  });
});

describe('small helpers', () => {
  it('toMs reads ISO instants and nothing else', () => {
    expect(toMs('2026-11-19T10:00:00.000Z')).toBe(utc(2026, 11, 19, 10, 0));
    expect(toMs(null)).toBeNull();
    expect(toMs(undefined)).toBeNull();
    expect(toMs('')).toBeNull();
    expect(toMs('next tuesday')).toBeNull();
  });

  it('clamp bounds a value', () => {
    expect(clamp(5, 0, 1)).toBe(1);
    expect(clamp(-5, 0, 1)).toBe(0);
    expect(clamp(0.4, 0, 1)).toBe(0.4);
  });

  it('isValidTimeZone accepts IANA names only', () => {
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone(LA)).toBe(true);
    expect(isValidTimeZone(STO)).toBe(true);
    expect(isValidTimeZone('Mars/Olympus_Mons')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });

  it('parseClock reads HH:MM and falls back to midnight', () => {
    expect(parseClock('09:05')).toEqual({ hour: 9, minute: 5 });
    expect(parseClock('9:05')).toEqual({ hour: 9, minute: 5 });
    expect(parseClock('23:59')).toEqual({ hour: 23, minute: 59 });
    expect(parseClock('nonsense')).toEqual({ hour: 0, minute: 0 });
  });

  it('the mean month is the Gregorian mean', () => {
    expect(MONTH / DAY).toBeCloseTo(365.2425 / 12, 6);
  });
});
