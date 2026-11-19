import { describe, expect, it } from 'vitest';

import {
  NotFoundError,
  ValidationError,
  addAccount,
  addMeter,
  findMeter,
  parseState,
  removeAccount,
  removeMeter,
  slugify,
  updateAccount,
  updateMeter,
  updateSettings,
  validateResetRule,
  type AccountInput,
  type MeterInput
} from '../../src/core/accounts.js';
import { presetAccountInput, type PresetPlan, type ProviderPreset } from '../../src/core/catalog-types.js';
import { viewState } from '../../src/core/forecast.js';
import { applyReadingToState, rollState } from '../../src/core/reset.js';
import { addSpendSource, recordSpend } from '../../src/core/spend.js';
import { DAY, HOUR, iso } from '../../src/core/time.js';
import { STATE_VERSION, emptyState, type Account, type Meter, type MeterSource, type Reading, type State } from '../../src/core/types.js';

const utc = (y: number, mo: number, d: number, h = 0, mi = 0): number => Date.UTC(y, mo - 1, d, h, mi, 0);
/** Thursday 19 November 2026, 10:00 UTC. */
const NOW = utc(2026, 11, 19, 10, 0);

const WEEKLY: MeterInput = { label: 'Weekly', reset: { kind: 'interval', hours: 168 } };
const base = (overrides: Partial<AccountInput> = {}): AccountInput => ({ label: 'Claude Max', meters: [WEEKLY], ...overrides });

function expectValidation(run: () => unknown, field: string, message?: RegExp): ValidationError {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ValidationError);
  const error = caught as ValidationError;
  expect(error.field).toBe(field);
  expect(error.message.length).toBeGreaterThan(0);
  if (message) expect(error.message).toMatch(message);
  return error;
}

function one(): State {
  return addAccount(emptyState(), base(), NOW).state;
}

describe('addAccount', () => {
  it('stores "Suno Pro" with a monthly meter of 2,500 credits at 0 used, resetting on the next 12th', () => {
    // Scenario: Create a custom account.
    const { state, account } = addAccount(
      emptyState(),
      {
        label: 'Suno Pro',
        meters: [{ label: 'Monthly credits', unit: 'credits', limit: 2500, reset: { kind: 'monthly', day: 12, time: '00:00', tz: 'UTC' } }]
      },
      NOW
    );
    expect(state.accounts).toEqual([account]);
    expect(account).toMatchObject({
      id: 'suno-pro',
      providerId: 'custom',
      label: 'Suno Pro',
      plan: null,
      price: null,
      usageUrl: null,
      notes: null,
      snoozedUntil: null,
      createdAt: iso(NOW),
      updatedAt: iso(NOW)
    });
    expect(account.meters).toHaveLength(1);
    expect(account.meters[0]).toEqual({
      id: 'suno-pro:monthly-credits',
      key: 'monthly-credits',
      label: 'Monthly credits',
      role: 'allowance',
      unit: 'credits',
      limit: 2500,
      used: 0,
      reset: { kind: 'monthly', day: 12, time: '00:00', tz: 'UTC' },
      windowStartedAt: '2026-11-12T00:00:00.000Z',
      resetsAt: '2026-12-12T00:00:00.000Z',
      rollover: 'none',
      valueShare: 1,
      source: { kind: 'manual' },
      updatedAt: null,
      samples: [],
      estimated: false,
      expired: false
    });
  });

  it('rejects an account without meters, naming them, and stores nothing', () => {
    // Scenario: Reject an account without meters.
    const state = emptyState();
    expectValidation(() => addAccount(state, { label: 'Empty', meters: [] }, NOW), 'meters', /meter/i);
    expectValidation(() => addAccount(state, { label: 'Empty' } as unknown as AccountInput, NOW), 'meters', /meter/i);
    expectValidation(() => addAccount(state, { label: 'Empty', meters: 'weekly' } as unknown as AccountInput, NOW), 'meters');
    expect(state).toEqual(emptyState());
  });

  it('gives a percentage-only meter a limit of 100, whatever limit was sent', () => {
    // Scenario: Percentage-only meter.
    const { account } = addAccount(emptyState(), base({ meters: [{ ...WEEKLY, unit: 'percent', limit: 500 }, { label: 'Default unit', reset: { kind: 'none' } }] }), NOW);
    expect(account.meters.map((meter) => [meter.unit, meter.limit])).toEqual([
      ['percent', 100],
      ['percent', 100]
    ]);
  });

  it('accepts every unit of the spec and keeps a custom noun for counts', () => {
    // Scenario: Custom noun.
    const units = ['requests', 'credits', 'tokens', 'characters', 'minutes', 'hours', 'images', 'usd', 'count'] as const;
    const { account } = addAccount(
      emptyState(),
      base({ meters: units.map((unit) => ({ label: `M ${unit}`, unit, limit: 10, reset: { kind: 'none' as const }, ...(unit === 'count' ? { unitLabel: ' songs ' } : {}) })) }),
      NOW
    );
    expect(account.meters.map((meter) => meter.unit)).toEqual([...units]);
    expect(account.meters[8]?.unitLabel).toBe('songs');
    expect(account.meters[0]).not.toHaveProperty('unitLabel');
  });

  it('rejects an unknown time zone, naming the zone', () => {
    // Scenario: Unknown time zone.
    for (const reset of [
      { kind: 'daily', time: '00:00', tz: 'Mars/Olympus_Mons' },
      { kind: 'monthly', day: 1, time: '00:00', tz: 'Mars/Olympus_Mons' }
    ] as const) {
      const state = emptyState();
      const error = expectValidation(() => addAccount(state, base({ meters: [{ label: 'Daily', reset }] }), NOW), 'meters[0].reset.tz');
      expect(error.message).toContain('Mars/Olympus_Mons');
      expect(state.accounts).toEqual([]);
    }
  });

  const invalid: [string, unknown, string][] = [
    ['no label', { meters: [WEEKLY] }, 'label'],
    ['an empty label', { label: '   ', meters: [WEEKLY] }, 'label'],
    ['a label that is not text', { label: 42, meters: [WEEKLY] }, 'label'],
    ['a label of 61 characters', { label: 'x'.repeat(61), meters: [WEEKLY] }, 'label'],
    ['a plan of 61 characters', base({ plan: 'p'.repeat(61) }), 'plan'],
    ['13 meters', base({ meters: Array.from({ length: 13 }, (_, n) => ({ ...WEEKLY, label: `M${n}` })) }), 'meters'],
    ['a negative price', base({ price: { amount: -5, currency: 'USD', period: 'month' } }), 'price.amount'],
    ['a price that is not a number', base({ price: { amount: '20', currency: 'USD', period: 'month' } as never }), 'price.amount'],
    ['a currency that is not a code', base({ price: { amount: 20, currency: 'dollars', period: 'month' } }), 'price.currency'],
    ['a price that is not an object', base({ price: 20 as never }), 'price'],
    ['a usage address that is not http', base({ usageUrl: 'javascript:alert(1)' }), 'usageUrl'],
    ['a meter without a label', base({ meters: [{ reset: { kind: 'none' } } as MeterInput] }), 'meters[0].label'],
    ['a second meter without a label', base({ meters: [WEEKLY, { label: '', reset: { kind: 'none' } }] }), 'meters[1].label'],
    ['an unknown unit', base({ meters: [{ ...WEEKLY, unit: 'bananas' as never }] }), 'meters[0].unit'],
    ['a counted meter without a limit', base({ meters: [{ ...WEEKLY, unit: 'credits' }] }), 'meters[0].limit'],
    ['a limit of zero', base({ meters: [{ ...WEEKLY, unit: 'credits', limit: 0 }] }), 'meters[0].limit'],
    ['a negative limit', base({ meters: [{ ...WEEKLY, unit: 'credits', limit: -10 }] }), 'meters[0].limit'],
    ['a limit that is not a number', base({ meters: [{ ...WEEKLY, unit: 'credits', limit: '2500' as never }] }), 'meters[0].limit'],
    ['a negative amount used', base({ meters: [{ ...WEEKLY, used: -1 }] }), 'meters[0].used'],
    ['a meter without a reset rule', base({ meters: [{ label: 'Weekly' } as MeterInput] }), 'meters[0].reset'],
    ['an unknown reset kind', base({ meters: [{ label: 'Weekly', reset: { kind: 'weekly' } as never }] }), 'meters[0].reset.kind'],
    ['an interval without hours', base({ meters: [{ label: 'Weekly', reset: { kind: 'interval' } as never }] }), 'meters[0].reset.hours'],
    ['a rolling window of zero hours', base({ meters: [{ label: 'Session', reset: { kind: 'rolling', hours: 0 } }] }), 'meters[0].reset.hours'],
    ['a daily time that is not a clock', base({ meters: [{ label: 'Daily', reset: { kind: 'daily', time: '25:00', tz: 'UTC' } }] }), 'meters[0].reset.time'],
    ['a monthly day of 32', base({ meters: [{ label: 'Monthly', reset: { kind: 'monthly', day: 32, time: '00:00', tz: 'UTC' } }] }), 'meters[0].reset.day'],
    ['a monthly day of 0', base({ meters: [{ label: 'Monthly', reset: { kind: 'monthly', day: 0, time: '00:00', tz: 'UTC' } }] }), 'meters[0].reset.day'],
    ['a fractional monthly day', base({ meters: [{ label: 'Monthly', reset: { kind: 'monthly', day: 1.5, time: '00:00', tz: 'UTC' } }] }), 'meters[0].reset.day'],
    ['a value share above 1', base({ meters: [{ ...WEEKLY, valueShare: 1.5 }] }), 'meters[0].valueShare'],
    ['a negative value share', base({ meters: [{ ...WEEKLY, valueShare: -0.1 }] }), 'meters[0].valueShare'],
    ['an unparseable reset time', base({ meters: [{ ...WEEKLY, resetsAt: 'next week' }] }), 'meters[0].resetsAt'],
    ['an unparseable window start', base({ meters: [{ ...WEEKLY, windowStartedAt: 'last week' }] }), 'meters[0].windowStartedAt'],
    ['a unit noun of 25 characters', base({ meters: [{ label: 'Songs', unit: 'count', limit: 5, unitLabel: 'n'.repeat(25), reset: { kind: 'none' } }] }), 'meters[0].unitLabel']
  ];

  it.each(invalid)('rejects %s, naming the field, and stores nothing', (_name, input, field) => {
    const state = one();
    const before = JSON.stringify(state);
    expectValidation(() => addAccount(state, input as AccountInput, NOW), field);
    expect(JSON.stringify(state)).toBe(before);
  });

  it('gives accounts with the same name different ids', () => {
    let state = emptyState();
    const ids: string[] = [];
    for (let n = 0; n < 4; n += 1) {
      const added = addAccount(state, base(), NOW);
      state = added.state;
      ids.push(added.account.id);
    }
    expect(ids).toEqual(['claude-max', 'claude-max-2', 'claude-max-3', 'claude-max-4']);
    const meterIds = state.accounts.flatMap((account) => account.meters.map((meter) => meter.id));
    expect(meterIds).toEqual(['claude-max:weekly', 'claude-max-2:weekly', 'claude-max-3:weekly', 'claude-max-4:weekly']);
    expect(new Set(meterIds).size).toBe(meterIds.length);
  });

  it('gives meters with the same name different keys within an account', () => {
    const { account } = addAccount(emptyState(), base({ meters: [WEEKLY, WEEKLY, { ...WEEKLY, key: 'weekly' }, { ...WEEKLY, label: 'Other', key: 'Weekly!' }] }), NOW);
    expect(account.meters.map((meter) => meter.key)).toEqual(['weekly', 'weekly-2', 'weekly-3', 'weekly-4']);
    expect(account.meters.map((meter) => meter.id)).toEqual([
      'claude-max:weekly',
      'claude-max:weekly-2',
      'claude-max:weekly-3',
      'claude-max:weekly-4'
    ]);
  });

  it('makes ids that are safe in an address, whatever the label', () => {
    let state = emptyState();
    const labels = ['Claude Max (20x)', '  ChatGPT / Codex  ', '!!!', 'A'.repeat(60), 'weird:name?#&'];
    for (const label of labels) state = addAccount(state, base({ label }), NOW).state;
    const ids = state.accounts.map((account) => account.id);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(new Set(ids).size).toBe(labels.length);
    expect(ids.slice(0, 3)).toEqual(['claude-max-20x', 'chatgpt-codex', 'item']);
    expect(state.accounts.map((account) => account.label)).toEqual(labels.map((label) => label.trim()));
    expect(slugify('Hello, World')).toBe('hello-world');
    // Letters outside a-z never reach an id, whatever they turn into.
    for (const label of ['Svensk tjänst', 'Låtar & ljud', 'Café crème', '日本語', 'Ünïcödé 3000']) {
      expect(slugify(label)).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(slugify(label).length).toBeLessThanOrEqual(40);
    }
  });

  it('shares the plan price with the first allowance only, and never with a throttle', () => {
    const { account } = addAccount(
      emptyState(),
      base({
        meters: [
          { label: 'Session', role: 'throttle', reset: { kind: 'rolling', hours: 5 }, valueShare: 1 },
          { label: 'All models', reset: { kind: 'interval', hours: 168 } },
          { label: 'Opus', reset: { kind: 'interval', hours: 168 } },
          { label: 'Explicit', reset: { kind: 'interval', hours: 168 }, valueShare: 0.25 }
        ]
      }),
      NOW
    );
    expect(account.meters.map((meter) => [meter.role, meter.valueShare])).toEqual([
      ['throttle', 0],
      ['allowance', 1],
      ['allowance', 0],
      ['allowance', 0.25]
    ]);
  });

  it('counts a meter created with a starting amount as read, and one without as never read', () => {
    const { account } = addAccount(emptyState(), base({ meters: [{ ...WEEKLY, used: 40 }, { ...WEEKLY, label: 'Untouched' }, { ...WEEKLY, label: 'Zero', used: 0 }] }), NOW);
    expect(account.meters[0]).toMatchObject({ used: 40, updatedAt: iso(NOW), samples: [{ t: iso(NOW), used: 40 }] });
    expect(account.meters[1]).toMatchObject({ used: 0, updatedAt: null, samples: [] });
    expect(account.meters[2]).toMatchObject({ used: 0, updatedAt: iso(NOW), samples: [{ t: iso(NOW), used: 0 }] });
  });

  it('normalises the price and drops a price of zero', () => {
    const priced = addAccount(emptyState(), base({ price: { amount: 200, currency: 'usd', period: 'month' } }), NOW).account;
    expect(priced.price).toEqual({ amount: 200, currency: 'USD', period: 'month' });
    const yearly = addAccount(emptyState(), base({ price: { amount: 990, currency: 'SEK', period: 'year' } }), NOW).account;
    expect(yearly.price).toEqual({ amount: 990, currency: 'SEK', period: 'year' });
    const free = addAccount(emptyState(), base({ price: { amount: 0, currency: 'USD', period: 'month' } }), NOW).account;
    expect(free.price).toBeNull();
  });

  it('records the source it was created from and a tidy provider id', () => {
    const { account } = addAccount(emptyState(), base({ providerId: 'ElevenLabs' }), NOW, { kind: 'collector', id: 'elevenlabs' });
    expect(account.providerId).toBe('elevenlabs');
    expect(account.meters[0]?.source).toEqual({ kind: 'collector', id: 'elevenlabs' });
  });

  it('returns a new state and leaves the old one alone', () => {
    const before = one();
    const snapshot = JSON.stringify(before);
    const { state: after } = addAccount(before, base({ label: 'Second' }), NOW);
    expect(after).not.toBe(before);
    expect(after.accounts).toHaveLength(2);
    expect(JSON.stringify(before)).toBe(snapshot);
    expect(after.accounts[0]).toBe(before.accounts[0]);
  });
});

describe('presets', () => {
  // A local stand-in for a catalog entry, so these tests do not depend on what the catalog contains.
  const provider: ProviderPreset = {
    id: 'copilot',
    name: 'GitHub Copilot',
    vendor: 'GitHub',
    monogram: 'Co',
    category: 'coding',
    usageUrl: 'https://github.com/settings/copilot',
    howToRead: 'Premium requests used this month.',
    collectors: [],
    plans: [
      {
        id: 'pro',
        name: 'Pro',
        price: { amount: 10, currency: 'USD', period: 'month' },
        meters: [
          { key: 'premium-requests', label: 'Premium requests', role: 'allowance', unit: 'requests', limit: 300, reset: { kind: 'monthly', day: 1, time: '00:00', tz: 'UTC' } }
        ]
      },
      {
        id: 'billing-date',
        name: 'Billing date',
        price: { amount: 20, currency: 'USD', period: 'month' },
        meters: [
          { key: 'weekly', label: 'Weekly', role: 'allowance', unit: 'percent', reset: { kind: 'interval', hours: 168 } },
          { key: 'session', label: 'Session', role: 'throttle', unit: 'percent', reset: { kind: 'rolling', hours: 5 } }
        ]
      }
    ]
  };

  function deepFreeze<T>(value: T): T {
    if (value && typeof value === 'object') {
      for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
      Object.freeze(value);
    }
    return value;
  }

  it('creates the account a plan describes: a monthly meter resetting on the 1st at 00:00 UTC, with the list price', () => {
    // Scenario: Add from a preset.
    const plan = provider.plans[0] as PresetPlan;
    const { account } = addAccount(emptyState(), presetAccountInput(provider, plan), NOW);
    expect(account).toMatchObject({
      providerId: 'copilot',
      label: 'GitHub Copilot Pro',
      plan: 'Pro',
      price: { amount: 10, currency: 'USD', period: 'month' },
      usageUrl: 'https://github.com/settings/copilot'
    });
    expect(account.meters).toHaveLength(1);
    expect(account.meters[0]).toMatchObject({
      key: 'premium-requests',
      label: 'Premium requests',
      role: 'allowance',
      unit: 'requests',
      limit: 300,
      used: 0,
      reset: { kind: 'monthly', day: 1, time: '00:00', tz: 'UTC' },
      resetsAt: '2026-12-01T00:00:00.000Z',
      windowStartedAt: '2026-11-01T00:00:00.000Z'
    });
    expect(presetAccountInput(provider, plan, '  Work seat ').label).toBe('Work seat');
  });

  it('stores edits to the limit, price and reset rule and leaves the preset as it was', () => {
    // Scenario: Presets are a starting point.
    const frozen = deepFreeze(structuredClone(provider));
    const original = JSON.stringify(frozen);
    const plan = frozen.plans[0] as PresetPlan;
    let state = addAccount(emptyState(), presetAccountInput(frozen, plan), NOW).state;
    const id = (state.accounts[0] as Account).id;
    state = updateMeter(state, `${id}:premium-requests`, { limit: 1500, reset: { kind: 'monthly', day: 15, time: '09:00', tz: 'Europe/Stockholm' } }, NOW);
    state = updateAccount(state, id, { price: { amount: 39, currency: 'USD', period: 'month' } }, NOW);
    state = applyReadingToState(state, id, `${id}:premium-requests`, { used: 12 }, NOW);

    const account = state.accounts[0] as Account;
    expect(account.price).toEqual({ amount: 39, currency: 'USD', period: 'month' });
    expect(account.meters[0]).toMatchObject({
      limit: 1500,
      used: 12,
      reset: { kind: 'monthly', day: 15, time: '09:00', tz: 'Europe/Stockholm' },
      resetsAt: '2026-12-15T08:00:00.000Z'
    });
    expect(JSON.stringify(frozen)).toBe(original);
    // A second account from the same preset still gets the preset's own values.
    const again = addAccount(state, presetAccountInput(frozen, plan), NOW).account;
    expect(again.meters[0]).toMatchObject({ limit: 300, reset: { kind: 'monthly', day: 1, time: '00:00', tz: 'UTC' } });
    expect(again.price).toEqual({ amount: 10, currency: 'USD', period: 'month' });
  });

  it('flags a meter whose reset depends on the billing date until a reset time is given', () => {
    // Scenario: Reset anchor still needed.
    const plan = provider.plans[1] as PresetPlan;
    let state = addAccount(emptyState(), presetAccountInput(provider, plan), NOW).state;
    const id = (state.accounts[0] as Account).id;
    const flags = (): Record<string, boolean> => Object.fromEntries(viewState(state, NOW).map((view) => [view.meter.key, view.needsReset]));
    expect((state.accounts[0] as Account).meters.map((meter) => meter.resetsAt)).toEqual([null, null]);
    // The weekly cap needs the user's own reset day; the session window simply starts on first use.
    expect(flags()).toEqual({ weekly: true, session: false });

    state = updateMeter(state, `${id}:weekly`, { resetsAt: iso(NOW + 3 * DAY) }, NOW);
    expect(flags()).toEqual({ weekly: false, session: false });
    expect(findMeter(state, `${id}:weekly`).meter.windowStartedAt).toBe(iso(NOW + 3 * DAY - 7 * DAY));
  });
});

describe('updateAccount', () => {
  it('changes the fields it is given and nothing else', () => {
    const state = addAccount(one(), base({ label: 'Other' }), NOW).state;
    const later = NOW + HOUR;
    const next = updateAccount(
      state,
      'claude-max',
      {
        label: ' Claude Max 20x ',
        plan: 'Max 20x',
        price: { amount: 200, currency: 'usd', period: 'month' },
        usageUrl: 'https://claude.ai/settings/usage',
        notes: 'Shared with the team',
        snoozedUntil: '2026-11-22T10:00:00+01:00'
      },
      later
    );
    expect(next.accounts[0]).toMatchObject({
      id: 'claude-max',
      label: 'Claude Max 20x',
      plan: 'Max 20x',
      price: { amount: 200, currency: 'USD', period: 'month' },
      usageUrl: 'https://claude.ai/settings/usage',
      notes: 'Shared with the team',
      snoozedUntil: '2026-11-22T09:00:00.000Z',
      createdAt: iso(NOW),
      updatedAt: iso(later)
    });
    expect(next.accounts[0]?.meters).toBe(state.accounts[0]?.meters);
    expect(next.accounts[1]).toBe(state.accounts[1]);
    expect(state.accounts[0]?.label).toBe('Claude Max');
  });

  it('clears optional fields with null', () => {
    let state = updateAccount(one(), 'claude-max', { plan: 'Max', price: { amount: 100, currency: 'USD', period: 'month' }, snoozedUntil: iso(NOW + DAY), notes: 'n' }, NOW);
    state = updateAccount(state, 'claude-max', { plan: null, price: null, snoozedUntil: null, notes: null, usageUrl: null }, NOW);
    expect(state.accounts[0]).toMatchObject({ plan: null, price: null, snoozedUntil: null, notes: null, usageUrl: null });
  });

  it.each([
    ['an empty label', { label: '' }, 'label'],
    ['a label that is too long', { label: 'x'.repeat(61) }, 'label'],
    ['a negative price', { price: { amount: -1, currency: 'USD', period: 'month' } }, 'price.amount'],
    ['a bad currency', { price: { amount: 5, currency: 'US', period: 'month' } }, 'price.currency'],
    ['a bad usage address', { usageUrl: 'ftp://example.com' }, 'usageUrl'],
    ['an unparseable snooze time', { snoozedUntil: 'when I am back' }, 'snoozedUntil'],
    ['notes that are too long', { notes: 'n'.repeat(2001) }, 'notes']
  ])('rejects %s, naming the field', (_name, patch, field) => {
    const state = one();
    const before = JSON.stringify(state);
    expectValidation(() => updateAccount(state, 'claude-max', patch as never, NOW), field);
    expect(JSON.stringify(state)).toBe(before);
  });

  it('says so when the account does not exist', () => {
    expect(() => updateAccount(one(), 'nope', { label: 'X' }, NOW)).toThrow(NotFoundError);
    expect(() => removeAccount(one(), 'nope')).toThrow(NotFoundError);
    expect(() => updateAccount(one(), 'nope', { label: 'X' }, NOW)).toThrow(/nope/);
  });
});

describe('addMeter', () => {
  it('adds a meter with a key of its own', () => {
    const { state, meter } = addMeter(one(), 'claude-max', { label: 'Weekly', reset: { kind: 'interval', hours: 168 }, used: 5 }, NOW + HOUR);
    expect(meter).toMatchObject({ id: 'claude-max:weekly-2', key: 'weekly-2', used: 5, valueShare: 0, source: { kind: 'manual' } });
    expect(state.accounts[0]?.meters.map((entry) => entry.id)).toEqual(['claude-max:weekly', 'claude-max:weekly-2']);
    expect(state.accounts[0]?.updatedAt).toBe(iso(NOW + HOUR));
  });

  it('gives the plan price to the first allowance of an account that had only throttles', () => {
    let state = addAccount(emptyState(), base({ meters: [{ label: 'Session', role: 'throttle', reset: { kind: 'rolling', hours: 5 } }] }), NOW).state;
    const first = addMeter(state, 'claude-max', WEEKLY, NOW);
    state = first.state;
    const second = addMeter(state, 'claude-max', { ...WEEKLY, label: 'Opus' }, NOW);
    expect(first.meter.valueShare).toBe(1);
    expect(second.meter.valueShare).toBe(0);
  });

  it('anchors a wall-clock rule straight away', () => {
    const { meter } = addMeter(one(), 'claude-max', { label: 'Daily', unit: 'requests', limit: 50, reset: { kind: 'daily', time: '00:00', tz: 'UTC' } }, NOW);
    expect(meter.resetsAt).toBe('2026-11-20T00:00:00.000Z');
  });

  it.each([
    ['no label', { reset: { kind: 'none' } }, /\.label$/],
    ['no limit on a counted meter', { label: 'Credits', unit: 'credits', reset: { kind: 'none' } }, /\.limit$/],
    ['an unknown unit', { label: 'X', unit: 'bananas', reset: { kind: 'none' } }, /\.unit$/],
    ['an unknown time zone', { label: 'Daily', reset: { kind: 'daily', time: '00:00', tz: 'Nowhere/Land' } }, /\.reset\.tz$/],
    ['no reset rule', { label: 'X' }, /\.reset$/]
  ])('rejects %s, naming the field', (_name, input, field) => {
    const state = one();
    let caught: unknown;
    try {
      addMeter(state, 'claude-max', input as MeterInput, NOW);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect((caught as ValidationError).field).toMatch(field);
    expect(state.accounts[0]?.meters).toHaveLength(1);
  });

  it('stops at 12 meters and says so when the account does not exist', () => {
    let state = one();
    for (let n = 0; n < 11; n += 1) state = addMeter(state, 'claude-max', { ...WEEKLY, label: `M${n}` }, NOW).state;
    expect(state.accounts[0]?.meters).toHaveLength(12);
    expectValidation(() => addMeter(state, 'claude-max', { ...WEEKLY, label: 'One too many' }, NOW), 'meters');
    expect(() => addMeter(state, 'nope', WEEKLY, NOW)).toThrow(NotFoundError);
  });
});

describe('updateMeter', () => {
  const meterOf = (state: State, id = 'claude-max:weekly'): Meter => findMeter(state, id).meter;

  it('renames without touching the id or the key', () => {
    const next = updateMeter(one(), 'claude-max:weekly', { label: 'All models' }, NOW + HOUR);
    expect(meterOf(next)).toMatchObject({ id: 'claude-max:weekly', key: 'weekly', label: 'All models' });
    expect(next.accounts[0]?.updatedAt).toBe(iso(NOW + HOUR));
  });

  it('treats a new amount as a reading', () => {
    let state = one();
    state = rollState(updateMeter(state, 'claude-max:weekly', { resetsAt: iso(NOW + HOUR) }, NOW), NOW + 2 * HOUR);
    expect(meterOf(state)).toMatchObject({ estimated: true, updatedAt: null });
    state = updateMeter(state, 'claude-max:weekly', { used: 33 }, NOW + 3 * HOUR);
    expect(meterOf(state)).toMatchObject({ used: 33, updatedAt: iso(NOW + 3 * HOUR), estimated: false });
    expect(meterOf(state).samples[meterOf(state).samples.length - 1]).toEqual({ t: iso(NOW + 3 * HOUR), used: 33 });
  });

  it('changes the limit of a counted meter and ignores one for a percentage-only meter', () => {
    let state = addAccount(emptyState(), base({ meters: [WEEKLY, { label: 'Credits', unit: 'credits', limit: 2500, reset: { kind: 'none' } }] }), NOW).state;
    state = updateMeter(state, 'claude-max:credits', { limit: 10_000 }, NOW);
    state = updateMeter(state, 'claude-max:weekly', { limit: 500 }, NOW);
    expect(meterOf(state, 'claude-max:credits').limit).toBe(10_000);
    expect(meterOf(state).limit).toBe(100);
  });

  it('drops the stored window when the reset rule changes, and anchors the new rule', () => {
    let state = updateMeter(one(), 'claude-max:weekly', { resetsAt: iso(NOW + 3 * DAY) }, NOW);
    expect(meterOf(state)).toMatchObject({ resetsAt: iso(NOW + 3 * DAY), windowStartedAt: iso(NOW - 4 * DAY) });

    state = updateMeter(state, 'claude-max:weekly', { reset: { kind: 'monthly', day: 1, time: '00:00', tz: 'UTC' } }, NOW);
    expect(meterOf(state)).toMatchObject({
      reset: { kind: 'monthly', day: 1, time: '00:00', tz: 'UTC' },
      resetsAt: '2026-12-01T00:00:00.000Z',
      windowStartedAt: '2026-11-01T00:00:00.000Z'
    });

    state = updateMeter(state, 'claude-max:weekly', { reset: { kind: 'rolling', hours: 5 } }, NOW);
    expect(meterOf(state)).toMatchObject({ reset: { kind: 'rolling', hours: 5 }, resetsAt: null, windowStartedAt: null });
  });

  it('keeps the window when the same rule is sent again', () => {
    const state = updateMeter(one(), 'claude-max:weekly', { resetsAt: iso(NOW + 3 * DAY) }, NOW);
    const again = updateMeter(state, 'claude-max:weekly', { reset: { kind: 'interval', hours: 168 } }, NOW);
    expect(meterOf(again).resetsAt).toBe(iso(NOW + 3 * DAY));
  });

  it('sets and clears the reset time, deriving the window start from the rule', () => {
    let state = updateMeter(one(), 'claude-max:weekly', { resetsAt: '2026-11-23T09:00:00+01:00' }, NOW);
    expect(meterOf(state)).toMatchObject({ resetsAt: '2026-11-23T08:00:00.000Z', windowStartedAt: '2026-11-16T08:00:00.000Z' });
    state = updateMeter(state, 'claude-max:weekly', { resetsAt: null }, NOW);
    expect(meterOf(state)).toMatchObject({ resetsAt: null, windowStartedAt: null });
    state = updateMeter(state, 'claude-max:weekly', { resetsAt: iso(NOW + 3 * DAY), windowStartedAt: iso(NOW - DAY) }, NOW);
    expect(meterOf(state)).toMatchObject({ resetsAt: iso(NOW + 3 * DAY), windowStartedAt: iso(NOW - DAY) });
  });

  it('keeps a month-long window when a monthly meter is given its exact reset time', () => {
    let state = addAccount(emptyState(), base({ meters: [{ label: 'Weekly', unit: 'credits', limit: 2500, used: 300, reset: { kind: 'monthly', day: 12, time: '00:00', tz: 'UTC' } }] }), NOW).state;
    state = updateMeter(state, 'claude-max:weekly', { resetsAt: '2026-12-12T14:37:00Z' }, NOW);
    expect(meterOf(state)).toMatchObject({ resetsAt: '2026-12-12T14:37:00.000Z', windowStartedAt: '2026-11-12T00:00:00.000Z' });
    const view = viewState(state, NOW)[0];
    expect(view?.elapsedFraction).toBeGreaterThan(0.2);
    expect(view?.tier).toBe('behind');
  });

  it('keeps a one-off pack on the clock when its expiry is edited', () => {
    let state = addAccount(emptyState(), base({ meters: [{ label: 'Weekly', unit: 'credits', limit: 100, used: 10, reset: { kind: 'once' } }] }), NOW).state;
    expect(meterOf(state)).toMatchObject({ resetsAt: null, windowStartedAt: null });
    expect(viewState(state, NOW)[0]?.needsReset).toBe(true);
    state = updateMeter(state, 'claude-max:weekly', { resetsAt: iso(NOW + 30 * DAY) }, NOW);
    expect(meterOf(state)).toMatchObject({ resetsAt: iso(NOW + 30 * DAY), windowStartedAt: iso(NOW) });
    expect(viewState(state, NOW + DAY)[0]).toMatchObject({ needsReset: false, msLeft: 29 * DAY });
    expect(viewState(state, NOW + 10 * DAY)[0]?.tier).not.toBe('idle');
  });

  it('revives an expired one-off meter when it gets a new expiry', () => {
    let state = addAccount(emptyState(), base({ meters: [{ label: 'Weekly', unit: 'credits', limit: 100, used: 10, reset: { kind: 'once' }, resetsAt: iso(NOW + HOUR) }] }), NOW).state;
    state = rollState(state, NOW + 2 * HOUR);
    expect(meterOf(state).expired).toBe(true);
    state = updateMeter(state, 'claude-max:weekly', { resetsAt: iso(NOW + 30 * DAY) }, NOW + 2 * HOUR);
    expect(meterOf(state)).toMatchObject({ expired: false, resetsAt: iso(NOW + 30 * DAY) });
  });

  it('converts the amount when a counted meter becomes percentage-only, and forgets the old samples', () => {
    let state = addAccount(emptyState(), base({ meters: [{ label: 'Weekly', unit: 'credits', limit: 2500, used: 500, reset: { kind: 'none' } }] }), NOW).state;
    expect(meterOf(state).samples).toHaveLength(1);
    state = updateMeter(state, 'claude-max:weekly', { unit: 'percent' }, NOW);
    expect(meterOf(state)).toMatchObject({ unit: 'percent', limit: 100, used: 20, samples: [] });
    state = updateMeter(state, 'claude-max:weekly', { unit: 'requests', limit: 300 }, NOW);
    expect(meterOf(state)).toMatchObject({ unit: 'requests', limit: 300 });
  });

  it('takes the plan price away from a meter that becomes a throttle', () => {
    let state = updateMeter(one(), 'claude-max:weekly', { role: 'throttle' }, NOW);
    expect(meterOf(state)).toMatchObject({ role: 'throttle', valueShare: 0 });
    state = updateMeter(state, 'claude-max:weekly', { valueShare: 0.5 }, NOW);
    expect(meterOf(state).valueShare).toBe(0);
    state = updateMeter(state, 'claude-max:weekly', { role: 'allowance', valueShare: 0.5 }, NOW);
    expect(meterOf(state)).toMatchObject({ role: 'allowance', valueShare: 0.5 });
  });

  it('sets and clears the unit noun and the carry-over flag', () => {
    let state = updateMeter(one(), 'claude-max:weekly', { unitLabel: 'songs', rollover: 'carries' }, NOW);
    expect(meterOf(state)).toMatchObject({ unitLabel: 'songs', rollover: 'carries' });
    state = updateMeter(state, 'claude-max:weekly', { unitLabel: '', rollover: 'none' }, NOW);
    expect(meterOf(state)).not.toHaveProperty('unitLabel');
    expect(meterOf(state).rollover).toBe('none');
  });

  it.each([
    ['an empty label', { label: ' ' }, 'label'],
    ['an unknown unit', { unit: 'bananas' }, 'unit'],
    ['a limit of zero', { unit: 'credits', limit: 0 }, 'limit'],
    ['a limit that is not a number', { unit: 'credits', limit: 'many' }, 'limit'],
    ['a negative amount', { used: -3 }, 'used'],
    ['an amount that is not a number', { used: '12' }, 'used'],
    ['an unknown reset kind', { reset: { kind: 'fortnightly' } }, 'reset.kind'],
    ['an interval of zero hours', { reset: { kind: 'interval', hours: 0 } }, 'reset.hours'],
    ['an unknown time zone', { reset: { kind: 'daily', time: '00:00', tz: 'Mars/Olympus_Mons' } }, 'reset.tz'],
    ['a bad clock', { reset: { kind: 'daily', time: 'noon', tz: 'UTC' } }, 'reset.time'],
    ['a bad monthly day', { reset: { kind: 'monthly', day: 40, time: '00:00', tz: 'UTC' } }, 'reset.day'],
    ['an unparseable reset time', { resetsAt: 'soon' }, 'resetsAt'],
    ['an unparseable window start', { windowStartedAt: 'a while ago' }, 'windowStartedAt'],
    ['a window that starts after it resets', { resetsAt: '2026-11-23T00:00:00Z', windowStartedAt: '2026-11-24T00:00:00Z' }, 'windowStartedAt'],
    ['a value share above 1', { valueShare: 2 }, 'valueShare'],
    ['a unit noun that is too long', { unitLabel: 'n'.repeat(25) }, 'unitLabel']
  ])('rejects %s, naming the field, and changes nothing', (_name, patch, field) => {
    const state = one();
    const before = JSON.stringify(state);
    const error = expectValidation(() => updateMeter(state, 'claude-max:weekly', patch as never, NOW), field);
    if (field === 'reset.tz') expect(error.message).toContain('Mars/Olympus_Mons');
    expect(JSON.stringify(state)).toBe(before);
  });

  it('says so when the meter does not exist', () => {
    expect(() => updateMeter(one(), 'claude-max:nope', { label: 'X' }, NOW)).toThrow(NotFoundError);
    expect(() => findMeter(one(), 'nope')).toThrow(NotFoundError);
    expect(() => removeMeter(one(), 'claude-max:nope', NOW)).toThrow(NotFoundError);
  });
});

describe('removeMeter and removeAccount', () => {
  it('removes one meter and keeps the rest', () => {
    const state = addMeter(one(), 'claude-max', { label: 'Opus', reset: { kind: 'none' } }, NOW).state;
    const next = removeMeter(state, 'claude-max:weekly', NOW + HOUR);
    expect(next.accounts[0]?.meters.map((meter) => meter.id)).toEqual(['claude-max:opus']);
    expect(next.accounts[0]?.updatedAt).toBe(iso(NOW + HOUR));
    expect(state.accounts[0]?.meters).toHaveLength(2);
  });

  it('refuses to remove the last meter of an account', () => {
    const state = one();
    const error = expectValidation(() => removeMeter(state, 'claude-max:weekly', NOW), 'meter', /account/i);
    expect(error.message).toMatch(/at least one meter/);
    expect(state.accounts[0]?.meters).toHaveLength(1);
  });

  it('removes an account and only that account', () => {
    const state = addAccount(one(), base({ label: 'Other' }), NOW).state;
    const next = removeAccount(state, 'claude-max');
    expect(next.accounts.map((account) => account.id)).toEqual(['other']);
    expect(next.accounts[0]).toBe(state.accounts[1]);
  });
});

describe('updateSettings', () => {
  it('normalises the currency and the collector list', () => {
    const next = updateSettings(emptyState(), { currency: ' sek ', enabledCollectors: ['codex-sessions', ' elevenlabs ', 'codex-sessions', ''] });
    expect(next.settings).toEqual({ currency: 'SEK', enabledCollectors: ['codex-sessions', 'elevenlabs'] });
    expect(updateSettings(next, {}).settings).toEqual(next.settings);
    expect(updateSettings(next, { enabledCollectors: [] }).settings).toEqual({ currency: 'SEK', enabledCollectors: [] });
  });

  it('rejects bad values, naming the field', () => {
    expectValidation(() => updateSettings(emptyState(), { currency: 'kronor' }), 'currency');
    expectValidation(() => updateSettings(emptyState(), { enabledCollectors: 'all' as never }), 'enabledCollectors');
    expectValidation(() => updateSettings(emptyState(), { enabledCollectors: [1, 2] as never }), 'enabledCollectors');
  });
});

describe('validateResetRule', () => {
  it('returns a clean copy with defaults filled in', () => {
    expect(validateResetRule({ kind: 'daily' })).toEqual({ kind: 'daily', time: '00:00', tz: 'UTC' });
    expect(validateResetRule({ kind: 'daily', time: '9:05', tz: 'Europe/Stockholm', extra: true })).toEqual({ kind: 'daily', time: '09:05', tz: 'Europe/Stockholm' });
    expect(validateResetRule({ kind: 'monthly', day: 31 })).toEqual({ kind: 'monthly', day: 31, time: '00:00', tz: 'UTC' });
    expect(validateResetRule({ kind: 'interval', hours: 168, tz: 'ignored' })).toEqual({ kind: 'interval', hours: 168 });
    expect(validateResetRule({ kind: 'once', hours: 3 })).toEqual({ kind: 'once' });
    expect(validateResetRule({ kind: 'none' })).toEqual({ kind: 'none' });
  });

  it('names the field it was given as a prefix', () => {
    expectValidation(() => validateResetRule(null), 'reset');
    expectValidation(() => validateResetRule({ kind: 'rolling', hours: -1 }, 'meters[2].reset'), 'meters[2].reset.hours');
  });
});

// ---------------------------------------------------------------------------
// Export and import
// ---------------------------------------------------------------------------

/** A state that exercises every part of the document, built only through the public transitions. */
function richState(): State {
  const start = utc(2026, 11, 1, 8, 0);
  let state = emptyState();
  state = addAccount(
    state,
    {
      label: 'Claude Max',
      providerId: 'claude',
      plan: 'Max 20x',
      price: { amount: 200, currency: 'USD', period: 'month' },
      usageUrl: 'https://claude.ai/settings/usage',
      notes: 'Shared with the team',
      meters: [
        { label: 'Session', key: 'session', role: 'throttle', reset: { kind: 'rolling', hours: 5 } },
        { label: 'Opus session', key: 'opus-session', role: 'throttle', partial: true, reset: { kind: 'rolling', hours: 5 } },
        { label: 'Weekly', key: 'weekly', reset: { kind: 'interval', hours: 168 }, resetsAt: '2026-11-06T09:00:00Z' },
        { label: 'Weekly Opus', key: 'weekly-opus', reset: { kind: 'interval', hours: 168 }, resetsAt: '2026-11-06T09:00:00Z', valueShare: 0.4 }
      ]
    },
    start,
    { kind: 'statusline', id: 'claude-statusline' }
  ).state;
  state = addAccount(
    state,
    {
      label: 'Suno Pro',
      providerId: 'suno',
      price: { amount: 96, currency: 'USD', period: 'year' },
      meters: [{ label: 'Monthly credits', unit: 'credits', limit: 2500, reset: { kind: 'monthly', day: 12, time: '09:00', tz: 'Europe/Stockholm' } }]
    },
    start
  ).state;
  state = addAccount(
    state,
    {
      label: 'Svensk tjänst',
      price: { amount: 249, currency: 'SEK', period: 'month' },
      meters: [
        { label: 'Låtar', key: 'songs', unit: 'count', unitLabel: 'songs', limit: 500, used: 120, reset: { kind: 'daily', time: '00:00', tz: 'America/Los_Angeles' } },
        { label: 'Characters', unit: 'characters', limit: 100_000, used: 20_000, reset: { kind: 'interval', hours: 720 }, resetsAt: '2026-11-25T00:00:00Z', rollover: 'carries', valueShare: 0.5 }
      ]
    },
    start
  ).state;
  state = addAccount(
    state,
    {
      label: 'Credit pack',
      meters: [
        { label: 'Credits', unit: 'usd', limit: 25, used: 5, reset: { kind: 'once' }, resetsAt: '2026-11-10T00:00:00Z' },
        { label: 'Live pack', unit: 'credits', limit: 500, used: 100, reset: { kind: 'once' }, resetsAt: '2026-12-24T00:00:00Z' },
        { label: 'Balance', unit: 'tokens', limit: 1_000_000, reset: { kind: 'none' } },
        { label: 'Unanchored', reset: { kind: 'interval', hours: 168 } }
      ]
    },
    start
  ).state;

  // Readings from every kind of source, over three weeks, so windows close and samples build up.
  const statusline: MeterSource = { kind: 'statusline', id: 'claude-statusline' };
  const agent: MeterSource = { kind: 'agent', id: 'claude-code', note: 'read from the usage page' };
  const readings: [number, string, string, Reading][] = [
    [utc(2026, 11, 2, 9, 0), 'Claude Max', 'weekly', { usedPercent: 31, source: statusline }],
    [utc(2026, 11, 2, 9, 0), 'Claude Max', 'session', { usedPercent: 80, source: statusline }],
    [utc(2026, 11, 5, 21, 0), 'Claude Max', 'weekly', { usedPercent: 74, source: statusline }],
    [utc(2026, 11, 5, 21, 0), 'Claude Max', 'weekly-opus', { usedPercent: 12, source: { kind: 'collector', id: 'claude-usage' } }],
    [utc(2026, 11, 6, 10, 0), 'Suno Pro', 'monthly-credits', { remaining: 1200, source: agent }],
    [utc(2026, 11, 14, 12, 0), 'Claude Max', 'weekly', { usedPercent: 55.5, resetsAt: '2026-11-20T09:00:00Z', source: statusline }],
    [utc(2026, 11, 15, 12, 0), 'Suno Pro', 'monthly-credits', { used: 300, source: agent }],
    [utc(2026, 11, 18, 23, 0), 'Svensk tjänst', 'songs', { used: 410 }],
    [utc(2026, 11, 19, 9, 30), 'Claude Max', 'session', { usedPercent: 100, source: statusline }],
    [utc(2026, 11, 19, 9, 30), 'Claude Max', 'opus-session', { usedPercent: 100, source: statusline }],
    [utc(2026, 11, 19, 9, 45), 'Claude Max', 'weekly', { usedPercent: 62, source: statusline }]
  ];
  for (const [at, label, key, reading] of readings) {
    // Ids are looked up, not spelled out: how a label with "ä" becomes an id is not this fixture's business.
    const account = state.accounts.find((candidate) => candidate.label === label) as Account;
    state = applyReadingToState(state, account.id, `${account.id}:${key}`, reading, at);
  }
  state = updateAccount(state, 'suno-pro', { snoozedUntil: iso(NOW + 3 * DAY) }, utc(2026, 11, 19, 9, 50));

  state = addSpendSource(state, { label: 'OpenAI API', providerId: 'openai', currency: 'USD', monthlyBudget: 50 }, start).state;
  state = addSpendSource(state, { label: 'Anthropic API', providerId: 'anthropic', currency: 'USD' }, start, { kind: 'collector', id: 'anthropic-costs' }).state;
  state = recordSpend(state, 'openai-api', { date: '2026-10-31', amount: 4.2 }, start, 'UTC');
  state = recordSpend(state, 'openai-api', { date: '2026-11-18', amount: 2.1 }, NOW, 'UTC');
  state = recordSpend(state, 'openai-api', { date: '2026-11-18', amount: 1.25, mode: 'add' }, NOW, 'UTC');
  state = recordSpend(state, 'anthropic-api', { date: '2026-11-17', amount: 7.5 }, NOW, 'UTC', { kind: 'collector', id: 'anthropic-costs' });
  state = updateSettings(state, { currency: 'SEK', enabledCollectors: ['claude-statusline', 'anthropic-costs'] });
  return rollState(state, NOW);
}

/** What a value looks like once it has been written out as JSON and read back. */
const asDocument = (value: unknown): unknown => JSON.parse(JSON.stringify(value)) as unknown;

describe('parseState', () => {
  it('builds a fixture that really covers the document', () => {
    const state = richState();
    expect(state.accounts).toHaveLength(4);
    expect(state.cycles.length).toBeGreaterThanOrEqual(4);
    expect(new Set(state.cycles.map((cycle) => cycle.confidence))).toEqual(new Set(['measured', 'estimated']));
    expect(state.spend).toHaveLength(2);
    const meters = state.accounts.flatMap((account) => account.meters);
    expect(new Set(meters.map((meter) => meter.source.kind))).toEqual(new Set(['manual', 'agent', 'collector', 'statusline']));
    expect(meters.some((meter) => meter.expired)).toBe(true);
    expect(meters.some((meter) => meter.estimated)).toBe(true);
    expect(meters.some((meter) => meter.samples.length > 1)).toBe(true);
    expect(meters.some((meter) => meter.resetsAt === null)).toBe(true);
    expect(meters.some((meter) => meter.rollover === 'carries')).toBe(true);
    expect(meters.some((meter) => meter.unitLabel === 'songs')).toBe(true);
    expect(meters.some((meter) => meter.partial === true)).toBe(true);
    expect(meters.some((meter) => meter.source.note !== undefined)).toBe(true);
    expect(state.accounts.some((account) => account.snoozedUntil !== null)).toBe(true);
  });

  it('imports its own export into an empty installation as an identical state', () => {
    // Scenario: Round trip.
    const exported = richState();
    const document = asDocument(exported);
    const imported = parseState(document, NOW);
    expect(asDocument(imported)).toEqual(document);
    // Piece by piece, as the scenario lists them.
    expect(asDocument(imported.accounts)).toEqual(asDocument(exported.accounts));
    expect(asDocument(imported.accounts.flatMap((account) => account.meters))).toEqual(asDocument(exported.accounts.flatMap((account) => account.meters)));
    expect(asDocument(imported.cycles)).toEqual(asDocument(exported.cycles));
    expect(asDocument(imported.spend)).toEqual(asDocument(exported.spend));
    expect(imported.settings).toEqual(exported.settings);
    expect(imported.version).toBe(STATE_VERSION);
  });

  it('is stable: importing the import changes nothing more', () => {
    const once = parseState(asDocument(richState()), NOW);
    const twice = parseState(asDocument(once), NOW);
    expect(asDocument(twice)).toEqual(asDocument(once));
  });

  it('round-trips an empty state and tolerates missing optional sections', () => {
    expect(parseState(asDocument(emptyState()), NOW)).toEqual(emptyState());
    expect(parseState({ version: STATE_VERSION }, NOW)).toEqual(emptyState());
  });

  it('does not share objects with the document it read', () => {
    const document = asDocument(richState()) as State;
    const imported = parseState(document, NOW);
    (document.accounts[0] as Account).label = 'Changed afterwards';
    ((document.accounts[0] as Account).meters[2] as Meter).reset = { kind: 'none' };
    expect(imported.accounts[0]?.label).toBe('Claude Max');
    expect(imported.accounts[0]?.meters[2]?.reset).toEqual({ kind: 'interval', hours: 168 });
  });

  it('rolls windows that ended between the export and the import', () => {
    const exported = richState();
    const later = NOW + 30 * DAY;
    const imported = parseState(asDocument(exported), later);
    expect(asDocument(imported)).toEqual(asDocument(rollState(exported, later)));
    expect(imported.cycles.length).toBeGreaterThan(exported.cycles.length);
  });

  it('keeps ids apart when a document repeats one', () => {
    const document = asDocument(one()) as State;
    document.accounts.push(structuredClone(document.accounts[0] as Account));
    const imported = parseState(document, NOW);
    expect(imported.accounts.map((account) => account.id)).toEqual(['claude-max', 'claude-max-2']);
    expect(imported.accounts.map((account) => account.meters[0]?.id)).toEqual(['claude-max:weekly', 'claude-max-2:weekly']);
  });

  const valid = (): Record<string, unknown> => asDocument(richState()) as Record<string, unknown>;
  const account = (document: Record<string, unknown>, index: number): Record<string, unknown> =>
    (document['accounts'] as Record<string, unknown>[])[index] as Record<string, unknown>;
  const meter = (document: Record<string, unknown>, accountIndex: number, meterIndex: number): Record<string, unknown> =>
    (account(document, accountIndex)['meters'] as Record<string, unknown>[])[meterIndex] as Record<string, unknown>;

  const broken: [string, (document: Record<string, unknown>) => unknown, string][] = [
    ['a document that is not an object', () => 'state', 'state'],
    ['a list instead of an object', () => [], 'state'],
    ['null', () => null, 'state'],
    ['a missing version', (d) => { delete d['version']; return d; }, 'version'],
    ['a future version', (d) => { d['version'] = 2; return d; }, 'version'],
    ['accounts that are not a list', (d) => { d['accounts'] = { claude: {} }; return d; }, 'accounts'],
    ['more than 200 accounts', (d) => { d['accounts'] = Array.from({ length: 201 }, () => account(d, 0)); return d; }, 'accounts'],
    ['an account that is not an object', (d) => { (d['accounts'] as unknown[])[1] = 'suno'; return d; }, 'accounts[1]'],
    ['an account without meters', (d) => { account(d, 2)['meters'] = []; return d; }, 'accounts[2].meters'],
    ['an account whose meters are not a list', (d) => { account(d, 0)['meters'] = 'weekly'; return d; }, 'accounts[0].meters'],
    ['an account without a label', (d) => { delete account(d, 1)['label']; return d; }, 'accounts[1].label'],
    ['an account with a bad price', (d) => { account(d, 0)['price'] = { amount: -1, currency: 'USD' }; return d; }, 'accounts[0].price.amount'],
    ['an account with a bad usage address', (d) => { account(d, 0)['usageUrl'] = 'file:///etc/passwd'; return d; }, 'accounts[0].usageUrl'],
    ['an account with a bad snooze time', (d) => { account(d, 1)['snoozedUntil'] = 'later'; return d; }, 'accounts[1].snoozedUntil'],
    ['a meter that is not an object', (d) => { (account(d, 0)['meters'] as unknown[])[1] = 7; return d; }, 'accounts[0].meters[1].label'],
    ['a meter without a label', (d) => { meter(d, 0, 2)['label'] = ''; return d; }, 'accounts[0].meters[2].label'],
    ['a meter with an unknown unit', (d) => { meter(d, 1, 0)['unit'] = 'bananas'; return d; }, 'accounts[1].meters[0].unit'],
    ['a counted meter without a limit', (d) => { delete meter(d, 1, 0)['limit']; return d; }, 'accounts[1].meters[0].limit'],
    ['a meter with a negative amount', (d) => { meter(d, 0, 1)['used'] = -4; return d; }, 'accounts[0].meters[1].used'],
    ['a meter without a reset rule', (d) => { delete meter(d, 0, 1)['reset']; return d; }, 'accounts[0].meters[1].reset'],
    ['a meter with an unknown time zone', (d) => { (meter(d, 1, 0)['reset'] as Record<string, unknown>)['tz'] = 'Mars/Olympus_Mons'; return d; }, 'accounts[1].meters[0].reset.tz'],
    ['a meter with an unparseable reset time', (d) => { meter(d, 0, 1)['resetsAt'] = 'friday'; return d; }, 'accounts[0].meters[1].resetsAt'],
    ['cycles that are not a list', (d) => { d['cycles'] = 'none'; return d; }, 'cycles'],
    ['spend that is not a list', (d) => { d['spend'] = {}; return d; }, 'spend'],
    ['a spend source without a label', (d) => { delete ((d['spend'] as Record<string, unknown>[])[1] as Record<string, unknown>)['label']; return d; }, 'spend[1].label'],
    ['a settings currency that is not a code', (d) => { (d['settings'] as Record<string, unknown>)['currency'] = 'kronor'; return d; }, 'currency']
  ];

  it.each(broken)('rejects %s, naming the field', (_name, breakIt, field) => {
    // Scenario: Invalid document.
    expectValidation(() => parseState(breakIt(valid()), NOW), field);
  });

  it('names the first invalid field when several are wrong', () => {
    const document = valid();
    meter(document, 2, 0)['unit'] = 'bananas';
    account(document, 1)['label'] = '';
    meter(document, 0, 1)['used'] = -4;
    expectValidation(() => parseState(document, NOW), 'accounts[0].meters[1].used');
    meter(document, 0, 1)['used'] = 4;
    expectValidation(() => parseState(document, NOW), 'accounts[1].label');
  });

  it('drops fields it does not know and never trusts derived ones', () => {
    const document = valid();
    account(document, 0)['admin'] = true;
    meter(document, 0, 2)['tier'] = 'spent';
    meter(document, 0, 2)['id'] = 'somebody-else:weekly';
    (document as Record<string, unknown>)['extra'] = { anything: 1 };
    const imported = parseState(document, NOW);
    expect(imported).not.toHaveProperty('extra');
    expect(imported.accounts[0]).not.toHaveProperty('admin');
    expect(imported.accounts[0]?.meters[2]).not.toHaveProperty('tier');
    // A meter id always follows from its account and key.
    expect(imported.accounts[0]?.meters[2]?.id).toBe('claude-max:weekly');
    expect(asDocument(imported)).toEqual(asDocument(richState()));
  });
});
