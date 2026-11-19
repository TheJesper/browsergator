import { beforeEach, describe, expect, it } from 'vitest';

import type { AccountInput } from '../src/core/accounts.js';
import { DAY, HOUR, MINUTE, iso } from '../src/core/time.js';
import { emptyState, type Account, type Meter, type State } from '../src/core/types.js';
import {
  AmbiguousTargetError,
  NotFoundError,
  ReadingError,
  TokengatorService,
  ValidationError
} from '../src/server/service.js';
import { MemoryStateStore } from '../src/server/store.js';

/** Thursday 19 November 2026, 10:00 UTC. */
const NOW = Date.UTC(2026, 10, 19, 10, 0, 0);
const WEEK = 7 * DAY;

let clock: number;
let store: MemoryStateStore;
let service: TokengatorService;
let events: number;

beforeEach(() => {
  clock = NOW;
  store = new MemoryStateStore();
  service = new TokengatorService(store, { now: () => clock, timeZone: 'UTC' });
  events = 0;
  service.onChange(() => (events += 1));
});

const claude = (overrides: Partial<AccountInput> = {}): AccountInput => ({
  label: 'Claude Max',
  providerId: 'claude',
  price: { amount: 100, currency: 'USD', period: 'month' },
  meters: [
    { label: 'Session', role: 'throttle', reset: { kind: 'rolling', hours: 5 } },
    { label: 'Weekly', reset: { kind: 'interval', hours: 168 }, resetsAt: iso(NOW + 2 * DAY) }
  ],
  ...overrides
});

const suno: AccountInput = {
  label: 'Suno Pro',
  providerId: 'suno',
  meters: [{ label: 'Monthly credits', unit: 'credits', limit: 2500, reset: { kind: 'monthly', day: 12, time: '00:00', tz: 'UTC' } }]
};

const meterOf = (state: State, id: string): Meter =>
  state.accounts.flatMap((account) => account.meters).find((meter) => meter.id === id) as Meter;

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('Expected the call to fail.');
    },
    (error: unknown) => error
  );
}

describe('TokengatorService', () => {
  it('runs on the injected clock and zone', async () => {
    expect(service.nowMs()).toBe(NOW);
    expect(service.timeZone).toBe('UTC');
    const account = await service.addAccount(claude());
    expect(account.createdAt).toBe(iso(NOW));
    clock += HOUR;
    expect(service.nowMs()).toBe(NOW + HOUR);
    const snap = await service.snapshot();
    expect(snap.generatedAt).toBe(iso(NOW + HOUR));
    expect(snap.timeZone).toBe('UTC');
    expect(await service.brief()).toContain('_As of 11:00 UTC (2026-11-19T11:00:00.000Z)_');
  });

  describe('report', () => {
    beforeEach(async () => {
      await service.addAccount(claude());
      await service.addAccount(suno);
    });

    it.each([
      [{ account: 'claude', meter: 'weekly' }, 'claude-max:weekly'],
      [{ account: 'Claude Max', meter: 'Weekly' }, 'claude-max:weekly'],
      [{ account: 'claude' }, 'claude-max:weekly'],
      [{ account: 'max' }, 'claude-max:weekly'],
      [{ account: 'claude-max', meter: 'sess' }, 'claude-max:session'],
      [{ account: 'claude weekly' }, 'claude-max:weekly'],
      [{ account: 'claude', meter: 'session' }, 'claude-max:session'],
      [{ meterId: 'claude-max:weekly' }, 'claude-max:weekly'],
      [{ meterId: 'claude-max:session', account: 'suno' }, 'claude-max:session'],
      [{ account: 'suno' }, 'suno-pro:monthly-credits'],
      [{ account: 'suno', meter: 'monthly' }, 'suno-pro:monthly-credits'],
      [{ account: 'suno-pro', meter: 'credits' }, 'suno-pro:monthly-credits']
    ])('finds %j', async (target, expected) => {
      const outcome = await service.report(target, { usedPercent: 40 });
      expect(outcome.meter.id).toBe(expected);
      expect(outcome.account.id).toBe(expected.slice(0, expected.indexOf(':')));
      expect(outcome.account.meters).toContain(outcome.meter);
    });

    it('stores the reading and returns the updated account and meter', async () => {
      const outcome = await service.report({ account: 'claude', meter: 'weekly' }, { usedPercent: 62 });
      expect(outcome.meter).toMatchObject({ id: 'claude-max:weekly', used: 62, updatedAt: iso(NOW), source: { kind: 'manual' } });
      expect(outcome.account.updatedAt).toBe(iso(NOW));
      expect(meterOf(await store.read(), 'claude-max:weekly').used).toBe(62);

      const credits = await service.report({ account: 'suno' }, { remaining: 1200 }, { kind: 'agent', id: 'claude-code' });
      expect(credits.meter).toMatchObject({ used: 1300, source: { kind: 'agent', id: 'claude-code' } });
      expect(events).toBe(4); // two accounts, two readings
    });

    it('names the candidates when a name fits more than one meter', async () => {
      await service.addAccount(claude({ label: 'Claude Pro' }));
      const error = await failure(service.report({ account: 'claude' }, { usedPercent: 40 }));
      expect(error).toBeInstanceOf(AmbiguousTargetError);
      expect((error as AmbiguousTargetError).candidates).toEqual([
        { accountId: 'claude-max', meterId: 'claude-max:weekly', label: 'Claude Max · Weekly' },
        { accountId: 'claude-pro', meterId: 'claude-pro:weekly', label: 'Claude Pro · Weekly' }
      ]);
      expect((error as Error).message).toMatch(/more than one/);
      // Nothing was stored.
      expect(meterOf(await store.read(), 'claude-max:weekly').updatedAt).toBeNull();
      expect(meterOf(await store.read(), 'claude-pro:weekly').updatedAt).toBeNull();

      // A candidate's ids settle it.
      const picked = await service.report({ meterId: 'claude-pro:weekly' }, { usedPercent: 40 });
      expect(picked.meter.id).toBe('claude-pro:weekly');
      const scoped = await service.report({ account: 'claude-max', meter: 'weekly' }, { usedPercent: 41 });
      expect(scoped.meter.id).toBe('claude-max:weekly');
    });

    it('is not confused by another account when the account is named by its exact id', async () => {
      await service.addAccount(claude({ label: 'Claude' }));
      // "claude" is the id of the new account and a prefix of the label of the old one.
      const outcome = await service.report({ account: 'claude', meter: 'weekly' }, { usedPercent: 12 });
      expect(outcome.meter.id).toBe('claude:weekly');
    });

    it('offers every account when the name matches none', async () => {
      const before = await store.read();
      const error = await failure(service.report({ account: 'midjourney' }, { usedPercent: 40 }));
      expect(error).toBeInstanceOf(AmbiguousTargetError);
      expect((error as AmbiguousTargetError).candidates).toEqual([
        { accountId: 'claude-max', meterId: null, label: 'Claude Max' },
        { accountId: 'suno-pro', meterId: null, label: 'Suno Pro' }
      ]);
      expect((error as Error).message).toContain('midjourney');
      expect(await store.read()).toBe(before);
    });

    it('rejects a target without a name, an unknown meter id and an invalid reading', async () => {
      const before = await store.read();
      const unnamed = await failure(service.report({}, { usedPercent: 40 }));
      expect(unnamed).toBeInstanceOf(ValidationError);
      expect((unnamed as ValidationError).field).toBe('account');

      expect(await failure(service.report({ meterId: 'claude-max:nope' }, { usedPercent: 40 }))).toBeInstanceOf(NotFoundError);

      const invalid = await failure(service.report({ account: 'claude' }, { usedPercent: 140 }));
      expect(invalid).toBeInstanceOf(ReadingError);
      expect((invalid as ReadingError).field).toBe('usedPercent');
      const several = await failure(service.report({ account: 'claude' }, { used: 10, remaining: 90 }));
      expect(several).toBeInstanceOf(ReadingError);
      const past = await failure(service.report({ account: 'claude' }, { usedPercent: 10, resetsAt: 'not a date' }));
      expect((past as ReadingError).field).toBe('resetsAt');

      expect(await store.read()).toBe(before);
      expect(events).toBe(2);
    });

    it('rolls a passed window before applying the reading, recording the finished cycle', async () => {
      await service.report({ account: 'claude' }, { usedPercent: 70 });
      clock = NOW + 2 * DAY + HOUR; // the weekly window ended an hour ago
      const outcome = await service.report({ account: 'claude' }, { usedPercent: 3 });
      expect(outcome.meter).toMatchObject({ used: 3, estimated: false, resetsAt: iso(NOW + 2 * DAY + WEEK), windowStartedAt: iso(NOW + 2 * DAY) });
      const state = await store.read();
      expect(state.cycles).toHaveLength(1);
      expect(state.cycles[0]).toMatchObject({ meterId: 'claude-max:weekly', endedAt: iso(NOW + 2 * DAY), used: 70, accountLabel: 'Claude Max' });
      expect(Math.abs((state.cycles[0]?.wastedValue as number) - 6.9)).toBeLessThan(0.01);
    });
  });

  describe('quick', () => {
    beforeEach(async () => {
      await service.addAccount(claude({ label: 'Claude' }));
      await service.addAccount(suno);
    });

    it('stores "claude weekly 62%" and returns how it was understood', async () => {
      const outcome = await service.quick('claude weekly 62%');
      expect(outcome.preview).toBe('Claude, Weekly: 62% used, 38% left');
      expect(outcome.meter).toMatchObject({ id: 'claude:weekly', used: 62, updatedAt: iso(NOW), source: { kind: 'manual' } });
      expect(outcome.account.id).toBe('claude');
      expect(meterOf(await store.read(), 'claude:weekly').used).toBe(62);
    });

    it('stores an amount left together with a new reset time', async () => {
      const outcome = await service.quick('suno 1200 left resets in 9d', { kind: 'agent', id: 'codex' });
      expect(outcome.preview).toBe('Suno Pro, Monthly credits: 1,300 credits used, 1,200 credits left (48%) · resets Sat 28 Nov 10:00 (in 9d)');
      expect(outcome.meter).toMatchObject({ used: 1300, resetsAt: iso(NOW + 9 * DAY), source: { kind: 'agent', id: 'codex' } });
    });

    it('reads wall-clock times in the service zone', async () => {
      const stockholm = new TokengatorService(store, { now: () => clock, timeZone: 'Europe/Stockholm' });
      const outcome = await stockholm.quick('claude weekly 62% resets tomorrow 09:00');
      expect(outcome.meter.resetsAt).toBe('2026-11-20T08:00:00.000Z');
    });

    it('previews without saving', async () => {
      const before = await store.read();
      const preview = await service.previewQuick('claude weekly 62%');
      expect(preview.ok).toBe(true);
      if (preview.ok) {
        expect(preview.preview).toBe('Claude, Weekly: 62% used, 38% left');
        expect(preview.reading).toEqual({ usedPercent: 62 });
      }
      expect(await store.read()).toBe(before);
      expect(events).toBe(2);
      const bad = await service.previewQuick('midjourney 5%');
      expect(bad.ok).toBe(false);
    });

    it('saves nothing and offers candidates when the line matches no account or several', async () => {
      await service.addAccount(claude({ label: 'Claude Pro' }));
      const before = await store.read();

      const unknown = await failure(service.quick('midjourney 50%'));
      expect(unknown).toBeInstanceOf(AmbiguousTargetError);
      expect((unknown as AmbiguousTargetError).candidates.map((candidate) => candidate.label)).toEqual(['Claude', 'Suno Pro', 'Claude Pro']);

      const several = await failure(service.quick('cl 50%'));
      expect(several).toBeInstanceOf(AmbiguousTargetError);
      expect((several as AmbiguousTargetError).candidates.map((candidate) => candidate.meterId)).toEqual(['claude:weekly', 'claude-pro:weekly']);

      expect(await store.read()).toBe(before);
    });

    it('saves nothing when the line cannot be understood', async () => {
      const before = await store.read();
      for (const line of ['claude 140%', 'claude', '', 'claude weekly 62% resets someday', 'claude 62% banana']) {
        const error = await failure(service.quick(line));
        expect(error).toBeInstanceOf(AmbiguousTargetError);
        expect((error as Error).message.length).toBeGreaterThan(0);
      }
      expect(await store.read()).toBe(before);
    });
  });

  describe('state', () => {
    it('persists a roll that closed a cycle', async () => {
      await service.addAccount(claude());
      await service.report({ account: 'claude' }, { usedPercent: 70 });
      const stored = await store.read();
      expect(stored.cycles).toEqual([]);
      const before = events;

      clock = NOW + 2 * DAY + MINUTE;
      const state = await service.state();
      expect(state.cycles).toHaveLength(1);
      expect(state.cycles[0]).toMatchObject({ meterId: 'claude-max:weekly', used: 70, endedAt: iso(NOW + 2 * DAY), confidence: 'estimated' });
      expect(meterOf(state, 'claude-max:weekly')).toMatchObject({ used: 0, estimated: true, resetsAt: iso(NOW + 2 * DAY + WEEK) });

      // It is on record now, not just computed for this call.
      const persisted = await store.read();
      expect(persisted).not.toBe(stored);
      expect(persisted.cycles).toEqual(state.cycles);
      expect(meterOf(persisted, 'claude-max:weekly').resetsAt).toBe(iso(NOW + 2 * DAY + WEEK));
      expect(events).toBe(before + 1);

      // Asking again changes nothing and records nothing twice.
      const again = await service.state();
      expect(again).toBe(persisted);
      expect(events).toBe(before + 1);
      clock += HOUR;
      expect((await service.state()).cycles).toHaveLength(1);
    });

    it('returns rolled meters without writing when no cycle closed', async () => {
      await service.addAccount(claude());
      await service.report({ account: 'claude', meter: 'session' }, { usedPercent: 90 });
      const stored = await store.read();
      expect(meterOf(stored, 'claude-max:session').resetsAt).toBe(iso(NOW + 5 * HOUR));
      const before = events;

      clock = NOW + 6 * HOUR; // the session window is over; throttles leave no cycle
      const state = await service.state();
      expect(meterOf(state, 'claude-max:session')).toMatchObject({ resetsAt: null, used: 0 });
      expect(state.cycles).toEqual([]);
      expect(await store.read()).toBe(stored);
      expect(events).toBe(before);
      // The snapshot is built from the rolled state all the same.
      expect((await service.snapshot()).throttles[0]).toMatchObject({ id: 'claude-max:session', tier: 'idle' });
    });

    it('returns the stored object untouched while nothing is due', async () => {
      await service.addAccount(claude());
      expect(await service.state()).toBe(await store.read());
      expect(await service.exportState()).toBe(await store.read());
    });

    it('records each finished window once when asked repeatedly over time', async () => {
      await service.addAccount({ label: 'Copilot', meters: [{ label: 'Daily', unit: 'requests', limit: 50, reset: { kind: 'daily', time: '00:00', tz: 'UTC' } }] });
      for (let day = 0; day < 5; day += 1) {
        clock = NOW + day * DAY;
        await service.report({ account: 'copilot' }, { used: 10 + day });
        for (let n = 0; n < 3; n += 1) await service.state();
      }
      clock = NOW + 5 * DAY;
      const state = await service.state();
      expect(state.cycles.map((cycle) => cycle.used)).toEqual([10, 11, 12, 13, 14]);
      expect(new Set(state.cycles.map((cycle) => cycle.endedAt)).size).toBe(5);
    });
  });

  describe('accounts and meters', () => {
    it('passes every transition through to the store', async () => {
      const account = await service.addAccount(suno, { kind: 'agent', id: 'claude-code' });
      expect(account.meters[0]?.source).toEqual({ kind: 'agent', id: 'claude-code' });

      clock += HOUR;
      const renamed = await service.updateAccount('suno-pro', { label: 'Suno Premier', snoozedUntil: iso(NOW + 3 * DAY) });
      expect(renamed).toMatchObject({ id: 'suno-pro', label: 'Suno Premier', snoozedUntil: iso(NOW + 3 * DAY), updatedAt: iso(NOW + HOUR) });

      const added = await service.addMeter('suno-pro', { label: 'Daily songs', unit: 'count', unitLabel: 'songs', limit: 10, reset: { kind: 'daily', time: '00:00', tz: 'UTC' } });
      expect(added).toMatchObject({ id: 'suno-pro:daily-songs', resetsAt: '2026-11-20T00:00:00.000Z' });

      const edited = await service.updateMeter('suno-pro:monthly-credits', { limit: 10_000, used: 250 });
      expect(edited).toMatchObject({ limit: 10_000, used: 250, updatedAt: iso(NOW + HOUR) });

      await service.removeMeter('suno-pro:daily-songs');
      const state = await store.read();
      expect(state.accounts[0]?.meters.map((meter) => meter.id)).toEqual(['suno-pro:monthly-credits']);

      await service.removeAccount('suno-pro');
      expect((await store.read()).accounts).toEqual([]);
    });

    it('rejects invalid input with the field named, changing nothing', async () => {
      await service.addAccount(suno);
      const before = await store.read();
      const cases: [Promise<unknown>, string][] = [
        [service.addAccount({ label: 'Empty', meters: [] }), 'meters'],
        [service.addAccount({ label: '', meters: suno.meters }), 'label'],
        [service.updateAccount('suno-pro', { snoozedUntil: 'later' }), 'snoozedUntil'],
        [service.addMeter('suno-pro', { label: 'X', unit: 'credits', reset: { kind: 'none' } }), 'meters[1].limit'],
        [service.updateMeter('suno-pro:monthly-credits', { reset: { kind: 'daily', time: '00:00', tz: 'Mars/Olympus_Mons' } }), 'reset.tz'],
        [service.removeMeter('suno-pro:monthly-credits'), 'meter'],
        [service.updateSettings({ currency: 'kronor' }), 'currency'],
        [service.addFromPreset('definitely-not-a-provider'), 'provider']
      ];
      for (const [call, field] of cases) {
        const error = await failure(call);
        expect(error).toBeInstanceOf(ValidationError);
        expect((error as ValidationError).field).toBe(field);
      }
      for (const call of [service.updateAccount('nope', { label: 'X' }), service.removeAccount('nope'), service.addMeter('nope', suno.meters[0] as never), service.updateMeter('nope:x', { label: 'X' })]) {
        expect(await failure(call)).toBeInstanceOf(NotFoundError);
      }
      expect(await store.read()).toBe(before);
      expect(events).toBe(1);
    });

    it('excludes a snoozed account from the summary until the snooze ends', async () => {
      await service.addAccount(claude({ meters: [{ label: 'Weekly', reset: { kind: 'interval', hours: 168 }, used: 50, resetsAt: iso(NOW + 5 * DAY) }] }));
      expect((await service.snapshot()).summary.behind).toBe(1);
      await service.updateAccount('claude-max', { snoozedUntil: iso(NOW + 3 * DAY) });
      const during = await service.snapshot();
      expect(during.summary).toMatchObject({ behind: 0, atRisk: {} });
      expect(during.queue[0]).toMatchObject({ id: 'claude-max:weekly', snoozed: true });
      clock = NOW + 3 * DAY + MINUTE;
      const after = await service.snapshot();
      expect(after.queue[0]?.snoozed).toBe(false);
      expect(after.summary.useNow + after.summary.behind).toBe(1);
    });

    it('updates the settings', async () => {
      expect(await service.updateSettings({ currency: 'sek', enabledCollectors: ['a', 'a', 'b'] })).toEqual({ currency: 'SEK', enabledCollectors: ['a', 'b'] });
      expect((await store.read()).settings.currency).toBe('SEK');
    });
  });

  describe('spend', () => {
    it('adds sources and records days on the service clock and zone', async () => {
      const source = await service.addSpendSource({ label: 'OpenAI API', providerId: 'openai', monthlyBudget: 50 });
      expect(source).toMatchObject({ id: 'openai-api', monthlyBudget: 50, entries: [] });

      clock = Date.UTC(2026, 10, 19, 23, 30, 0);
      let updated = await service.recordSpend('openai-api', { amount: 2.1 });
      expect(updated.entries).toEqual([{ date: '2026-11-19', amount: 2.1 }]);
      updated = await service.recordSpend('openai-api', { amount: 1.25, mode: 'add' });
      expect(updated.entries[0]?.amount).toBeCloseTo(3.35, 10);
      updated = await service.recordSpend('openai-api', { date: '2026-11-18', amount: 3.4 }, { kind: 'agent', id: 'codex' });
      expect(updated.entries.map((entry) => entry.date)).toEqual(['2026-11-18', '2026-11-19']);
      expect(updated.source).toEqual({ kind: 'agent', id: 'codex' });

      // The same instant is already the 20th in Stockholm.
      const stockholm = new TokengatorService(store, { now: () => clock, timeZone: 'Europe/Stockholm' });
      expect((await stockholm.recordSpend('openai-api', { amount: 9 })).entries.map((entry) => entry.date)).toContain('2026-11-20');

      await service.updateSpendSource('openai-api', { monthlyBudget: 80 });
      expect((await store.read()).spend[0]?.monthlyBudget).toBe(80);
      await service.removeSpendSource('openai-api');
      expect((await store.read()).spend).toEqual([]);
    });

    it('finds a source by id, label, part of the label or provider, and refuses a name that fits several', async () => {
      await service.addSpendSource({ label: 'OpenAI API', providerId: 'openai' });
      await service.addSpendSource({ label: 'Anthropic API', providerId: 'anthropic' });
      expect((await service.findSpendSource('openai-api')).id).toBe('openai-api');
      expect((await service.findSpendSource('OpenAI API')).id).toBe('openai-api');
      expect((await service.findSpendSource('anthro')).id).toBe('anthropic-api');
      expect((await service.findSpendSource('anthropic')).id).toBe('anthropic-api');
      const several = await failure(service.findSpendSource('api'));
      expect(several).toBeInstanceOf(NotFoundError);
      expect((several as Error).message).toContain('openai-api');
      expect((several as Error).message).toContain('anthropic-api');
      const none = await failure(service.findSpendSource('mistral'));
      expect(none).toBeInstanceOf(NotFoundError);
      expect((none as Error).message).toContain('mistral');
    });

    it('rejects a bad entry and an unknown source', async () => {
      await service.addSpendSource({ label: 'OpenAI API' });
      const negative = await failure(service.recordSpend('openai-api', { amount: -1 }));
      expect((negative as ValidationError).field).toBe('amount');
      expect(await failure(service.recordSpend('nope', { amount: 1 }))).toBeInstanceOf(NotFoundError);
      expect((await store.read()).spend[0]?.entries).toEqual([]);
    });
  });

  describe('applyCollected', () => {
    // An id no catalog will ever carry, so the fallback path is what runs.
    const PROVIDER = 'acme-quota-test';

    it('creates an account for an unknown provider and applies the readings by meter key', async () => {
      const changed = await service.applyCollected(
        'acme-collector',
        [
          {
            providerId: PROVIDER,
            meters: [
              { key: 'weekly', label: 'Weekly limit', reading: { usedPercent: 40 } },
              { key: 'session', reading: { usedPercent: 15 } }
            ]
          }
        ],
        []
      );
      expect(changed).toEqual([`${PROVIDER}:weekly`, `${PROVIDER}:session`]);

      const state = await store.read();
      expect(state.accounts).toHaveLength(1);
      const account = state.accounts[0] as Account;
      expect(account).toMatchObject({ id: PROVIDER, providerId: PROVIDER, label: PROVIDER });
      expect(account.meters.map((meter) => [meter.key, meter.label, meter.unit, meter.used])).toEqual([
        ['weekly', 'Weekly limit', 'percent', 40],
        ['session', 'session', 'percent', 15]
      ]);
      for (const meter of account.meters) {
        expect(meter.source).toEqual({ kind: 'collector', id: 'acme-collector' });
        expect(meter.updatedAt).toBe(iso(NOW));
      }
      expect(events).toBe(1); // one write for the whole collection
    });

    it('updates the same account by meter key on later runs and adds a meter for a new key', async () => {
      const first = [{ providerId: PROVIDER, meters: [{ key: 'weekly', label: 'Weekly limit', reading: { usedPercent: 40 } }] }];
      await service.applyCollected('acme-collector', first, []);
      clock += HOUR;
      const changed = await service.applyCollected(
        'acme-collector',
        [
          {
            providerId: PROVIDER,
            meters: [
              { key: 'weekly', label: 'Ignored once the meter exists', reading: { usedPercent: 55 } },
              { key: 'opus', label: 'Opus', reading: { usedPercent: 5 } }
            ]
          }
        ],
        []
      );
      expect(changed).toEqual([`${PROVIDER}:weekly`, `${PROVIDER}:opus`]);
      const state = await store.read();
      expect(state.accounts).toHaveLength(1);
      expect(state.accounts[0]?.meters.map((meter) => [meter.key, meter.label, meter.used, meter.updatedAt])).toEqual([
        ['weekly', 'Weekly limit', 55, iso(NOW + HOUR)],
        ['opus', 'Opus', 5, iso(NOW + HOUR)]
      ]);
      expect(meterOf(state, `${PROVIDER}:weekly`).samples.map((sample) => sample.used)).toEqual([40, 55]);
      expect(meterOf(state, `${PROVIDER}:opus`).source).toEqual({ kind: 'collector', id: 'acme-collector' });
    });

    it('feeds an account the user already has for that provider and leaves its other meters alone', async () => {
      await service.addAccount({
        label: 'My Acme seat',
        providerId: PROVIDER,
        price: { amount: 30, currency: 'USD', period: 'month' },
        meters: [
          { label: 'Weekly', key: 'weekly', unit: 'requests', limit: 400, reset: { kind: 'interval', hours: 168 }, resetsAt: iso(NOW + 2 * DAY) },
          { label: 'Hand kept', key: 'notes', unit: 'credits', limit: 100, used: 7, reset: { kind: 'none' } }
        ]
      });
      const untouched = meterOf(await store.read(), 'my-acme-seat:notes');
      clock += HOUR;
      const changed = await service.applyCollected(
        'acme-collector',
        [{ providerId: PROVIDER, meters: [{ key: 'weekly', reading: { usedPercent: 25, resetsAt: iso(NOW + 2 * DAY + 3 * HOUR) } }] }],
        []
      );
      expect(changed).toEqual(['my-acme-seat:weekly']);
      const state = await store.read();
      expect(state.accounts).toHaveLength(1);
      expect(state.accounts[0]).toMatchObject({ label: 'My Acme seat', price: { amount: 30, currency: 'USD', period: 'month' } });
      expect(meterOf(state, 'my-acme-seat:weekly')).toMatchObject({
        used: 100, // 25% of 400 requests
        limit: 400,
        resetsAt: iso(NOW + 2 * DAY + 3 * HOUR),
        source: { kind: 'collector', id: 'acme-collector' }
      });
      expect(meterOf(state, 'my-acme-seat:notes')).toBe(untouched);
    });

    it('marks status line readings as such', async () => {
      await service.applyCollected('claude-statusline', [{ providerId: PROVIDER, meters: [{ key: 'weekly', reading: { usedPercent: 40 } }] }], []);
      expect(meterOf(await store.read(), `${PROVIDER}:weekly`).source).toEqual({ kind: 'statusline', id: 'claude-statusline' });
    });

    it('skips one unusable reading without discarding the rest', async () => {
      const changed = await service.applyCollected(
        'acme-collector',
        [
          {
            providerId: PROVIDER,
            meters: [
              { key: 'weekly', reading: { usedPercent: 40, resetsAt: iso(NOW - DAY) } },
              { key: 'session', reading: { usedPercent: 140 } },
              { key: 'monthly', reading: { usedPercent: 15 } }
            ]
          }
        ],
        []
      );
      expect(changed).toEqual([`${PROVIDER}:monthly`]);
      const state = await store.read();
      expect(meterOf(state, `${PROVIDER}:monthly`).used).toBe(15);
      expect(meterOf(state, `${PROVIDER}:weekly`).updatedAt).toBeNull();
      expect(meterOf(state, `${PROVIDER}:session`).updatedAt).toBeNull();
    });

    it('does nothing for a provider that reported no meters', async () => {
      const changed = await service.applyCollected('acme-collector', [{ providerId: PROVIDER, meters: [] }], []);
      expect(changed).toEqual([]);
      expect(await store.read()).toEqual(emptyState());
      expect(events).toBe(0);
    });

    it('lets automatic silence count as waste afterwards', async () => {
      await service.addAccount({
        label: 'Acme',
        providerId: PROVIDER,
        meters: [{ label: 'Daily', key: 'daily', unit: 'requests', limit: 50, reset: { kind: 'daily', time: '00:00', tz: 'UTC' } }]
      });
      clock = Date.UTC(2026, 10, 19, 23, 30, 0);
      await service.applyCollected('acme-collector', [{ providerId: PROVIDER, meters: [{ key: 'daily', reading: { used: 20 } }] }], []);
      clock = Date.UTC(2026, 10, 20, 6, 0, 0);
      await service.state();
      clock = Date.UTC(2026, 10, 21, 6, 0, 0);
      const state = await service.state();
      expect(state.cycles.map((cycle) => [cycle.used, cycle.wastedFraction, cycle.confidence])).toEqual([
        [20, 0.6, 'measured'],
        [0, 1, 'estimated']
      ]);
    });

    it('creates one spend source per collector and replaces each day it reports', async () => {
      const days = [
        { date: '2026-11-17', amount: 7.5 },
        { date: '2026-11-18', amount: 2.1 }
      ];
      await service.applyCollected('acme-costs', [], [{ providerId: PROVIDER, label: 'Acme API', currency: 'USD', days }]);
      let state = await store.read();
      expect(state.spend).toHaveLength(1);
      expect(state.spend[0]).toMatchObject({
        id: 'acme-api',
        providerId: PROVIDER,
        label: 'Acme API',
        currency: 'USD',
        entries: days,
        source: { kind: 'collector', id: 'acme-costs' }
      });

      // A cost report gives totals, so a second run sets the day instead of adding to it.
      clock += HOUR;
      await service.applyCollected('acme-costs', [], [{ providerId: PROVIDER, label: 'Acme API', currency: 'USD', days: [{ date: '2026-11-18', amount: 3.4 }, { date: '2026-11-19', amount: 0.5 }] }]);
      state = await store.read();
      expect(state.spend).toHaveLength(1);
      expect(state.spend[0]?.entries).toEqual([
        { date: '2026-11-17', amount: 7.5 },
        { date: '2026-11-18', amount: 3.4 },
        { date: '2026-11-19', amount: 0.5 }
      ]);
      expect(state.spend[0]?.updatedAt).toBe(iso(NOW + HOUR));

      // Spend never shows up as an account or as waste.
      expect(state.accounts).toEqual([]);
      expect((await service.snapshot()).summary.atRisk).toEqual({});
    });

    it('finds its spend source again after an export and import', async () => {
      const report = [{ providerId: PROVIDER, label: 'Acme API', currency: 'USD', days: [{ date: '2026-11-18', amount: 2.1 }] }];
      await service.applyCollected('acme-costs', [], report);
      const document = JSON.parse(JSON.stringify(await service.exportState())) as unknown;

      const other = new TokengatorService(new MemoryStateStore(), { now: () => clock, timeZone: 'UTC' });
      await other.importState(document);
      await other.applyCollected('acme-costs', [], report);
      expect((await other.state()).spend.map((source) => source.id)).toEqual(['acme-api']);
    });
  });

  describe('export and import', () => {
    async function populated(): Promise<TokengatorService> {
      await service.addAccount(claude());
      await service.addAccount(suno);
      await service.report({ account: 'claude' }, { usedPercent: 70 }, { kind: 'agent', id: 'claude-code' });
      await service.addSpendSource({ label: 'OpenAI API', monthlyBudget: 50 });
      await service.recordSpend('openai-api', { date: '2026-11-18', amount: 3.4 });
      await service.updateSettings({ currency: 'SEK', enabledCollectors: ['acme-collector'] });
      clock = NOW + 2 * DAY + HOUR;
      await service.report({ account: 'claude' }, { usedPercent: 5 });
      await service.updateAccount('suno-pro', { snoozedUntil: iso(clock + DAY) });
      return service;
    }

    it('imports an export into an empty installation as an identical state', async () => {
      // Scenario: Round trip.
      const exported = await (await populated()).exportState();
      expect(exported.cycles).toHaveLength(1);
      const document = JSON.parse(JSON.stringify(exported)) as unknown;

      const emptyStore = new MemoryStateStore();
      const other = new TokengatorService(emptyStore, { now: () => clock, timeZone: 'UTC' });
      const imported = await other.importState(document);
      expect(JSON.parse(JSON.stringify(imported))).toEqual(document);
      expect(JSON.parse(JSON.stringify(await emptyStore.read()))).toEqual(document);
      expect(JSON.parse(JSON.stringify(await other.exportState()))).toEqual(document);
    });

    it('replaces the current state on a valid import', async () => {
      await service.addAccount(suno);
      const other = new TokengatorService(new MemoryStateStore(), { now: () => clock, timeZone: 'UTC' });
      await other.addAccount(claude());
      const document = JSON.parse(JSON.stringify(await other.exportState())) as unknown;
      const before = events;
      const state = await service.importState(document);
      expect(state.accounts.map((account) => account.id)).toEqual(['claude-max']);
      expect((await store.read()).accounts.map((account) => account.id)).toEqual(['claude-max']);
      expect(events).toBe(before + 1);
    });

    it('rejects an invalid document without changing anything, naming the first invalid field', async () => {
      // Scenario: Invalid document.
      const current = await (await populated()).exportState();
      const stored = await store.read();
      const before = events;

      const broken = JSON.parse(JSON.stringify(current)) as State;
      (broken.accounts[1] as Account).label = '';
      ((broken.accounts[0] as Account).meters[1] as Meter).used = -5;

      const error = await failure(service.importState(broken));
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).field).toBe('accounts[0].meters[1].used');
      expect(await store.read()).toBe(stored);
      expect(events).toBe(before);

      for (const [document, field] of [
        [null, 'state'],
        ['{"version":1}', 'state'],
        [{ version: 7, accounts: [] }, 'version'],
        [{ version: 1, accounts: [{ label: 'No meters', meters: [] }] }, 'accounts[0].meters'],
        [{ version: 1, accounts: 'none' }, 'accounts']
      ] as [unknown, string][]) {
        const rejected = await failure(service.importState(document));
        expect(rejected).toBeInstanceOf(ValidationError);
        expect((rejected as ValidationError).field).toBe(field);
      }
      expect(await store.read()).toBe(stored);
      expect(await service.exportState()).toBe(stored);
    });
  });

  describe('change notifications', () => {
    it('announces every successful mutation and nothing else', async () => {
      await service.addAccount(claude());
      expect(events).toBe(1);
      await service.report({ account: 'claude' }, { usedPercent: 10 });
      expect(events).toBe(2);
      await failure(service.report({ account: 'nobody' }, { usedPercent: 10 }));
      await service.state();
      await service.snapshot();
      await service.brief();
      await service.previewQuick('claude 20%');
      expect(events).toBe(2);

      let late = 0;
      const unsubscribe = service.onChange(() => (late += 1));
      await service.quick('claude 20%');
      unsubscribe();
      await service.quick('claude 30%');
      expect(late).toBe(1);
      expect(events).toBe(4);
    });
  });
});
