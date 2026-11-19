import { describe, expect, it } from 'vitest';

import { addAccount } from '../src/core/accounts.js';
import { CATALOG, CATALOG_CHECKED } from '../src/core/catalog.js';
import { findPlan, findProvider, monogramFor, planNeedsBillingDay, presetAccountInput } from '../src/core/catalog-types.js';
import { demoState } from '../src/core/demo.js';
import { summarise, viewState } from '../src/core/forecast.js';
import { emptyState } from '../src/core/types.js';

const NOW = Date.parse('2026-11-19T10:00:00Z');

describe('provider catalog', () => {
  it('covers the providers the proposal names', () => {
    const ids = CATALOG.map((provider) => provider.id);
    for (const required of ['claude', 'codex', 'copilot', 'gemini', 'elevenlabs', 'suno']) expect(ids).toContain(required);
    expect(CATALOG_CHECKED).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('has unique ids, two-character monograms and an https usage page everywhere', () => {
    expect(new Set(CATALOG.map((provider) => provider.id)).size).toBe(CATALOG.length);
    for (const provider of CATALOG) {
      expect(provider.monogram, provider.id).toMatch(/^.{1,2}$/u);
      expect(provider.usageUrl, provider.id).toMatch(/^https:\/\//);
      expect(provider.howToRead.length, provider.id).toBeGreaterThan(20);
      expect(provider.plans.length, provider.id).toBeGreaterThan(0);
      expect(new Set(provider.plans.map((plan) => plan.id)).size, provider.id).toBe(provider.plans.length);
    }
  });

  it('links every documented way to use quota to an https page and says what it is in one sentence', () => {
    const withUses = CATALOG.filter((provider) => (provider.uses ?? []).length > 0);
    expect(withUses.map((provider) => provider.id)).toEqual(expect.arrayContaining(['claude', 'codex', 'copilot']));
    for (const provider of withUses) {
      for (const use of provider.uses ?? []) {
        expect(use.title.length, provider.id).toBeGreaterThan(3);
        expect(use.note, provider.id).toMatch(/^[A-Z].{30,200}\.$/);
        expect(use.url, provider.id).toMatch(/^https:\/\/[a-z0-9.-]+\//);
        // Nothing here may read as an instruction to keep a window warm or to run something for its own sake.
        expect(use.note.toLowerCase()).not.toMatch(/warm|ping|keep.?alive|burn/);
      }
    }
  });

  it('builds a valid account from every plan of every provider', () => {
    for (const provider of CATALOG) {
      for (const plan of provider.plans) {
        const where = `${provider.id}/${plan.id}`;
        const { account } = addAccount(emptyState(), presetAccountInput(provider, plan), NOW);
        expect(account.providerId, where).toBe(provider.id);
        expect(account.meters.length, where).toBe(plan.meters.length);
        expect(new Set(account.meters.map((meter) => meter.key)).size, where).toBe(plan.meters.length);
        // At most one plan price is ever attributed across a plan's meters.
        const share = account.meters.filter((meter) => meter.unit !== 'usd').reduce((sum, meter) => sum + meter.valueShare, 0);
        expect(share, where).toBeLessThanOrEqual(1.0001);
        for (const meter of account.meters) {
          if (meter.role === 'throttle') expect(meter.valueShare, where).toBe(0);
          if (meter.unit === 'percent') expect(meter.limit, where).toBe(100);
        }
      }
    }
  });

  it('adds the Copilot Pro plan with a calendar-month allowance at 00:00 UTC on the 1st', () => {
    const provider = findProvider(CATALOG, 'copilot');
    const plan = provider ? findPlan(provider, 'pro') : null;
    expect(provider && plan).toBeTruthy();
    const { account } = addAccount(emptyState(), presetAccountInput(provider!, plan!), NOW);
    expect(account.price).toEqual({ amount: 10, currency: 'USD', period: 'month' });
    const meter = account.meters[0]!;
    expect(meter.reset).toEqual({ kind: 'monthly', day: 1, time: '00:00', tz: 'UTC' });
    expect(meter.resetsAt).toBe('2026-12-01T00:00:00.000Z');
  });

  it('flags a billing-cycle meter as needing its reset time until a billing day is given', () => {
    const provider = findProvider(CATALOG, 'suno')!;
    const plan = findPlan(provider, 'pro')!;
    expect(planNeedsBillingDay(plan)).toBe(true);

    const unanchored = addAccount(emptyState(), presetAccountInput(provider, plan), NOW).account;
    expect(unanchored.meters[0]?.reset.kind).toBe('interval');
    expect(unanchored.meters[0]?.resetsAt).toBeNull();
    const view = viewState({ ...emptyState(), accounts: [unanchored] }, NOW)[0]!;
    expect(view.needsReset).toBe(true);
    expect(view.tier).toBe('idle');

    const anchored = addAccount(emptyState(), presetAccountInput(provider, plan, undefined, 12), NOW).account;
    expect(anchored.meters[0]?.reset).toMatchObject({ kind: 'monthly', day: 12 });
    expect(anchored.meters[0]?.resetsAt).not.toBeNull();
  });

  it('models a model-family cap as a partial throttle that does not block the account', () => {
    const provider = findProvider(CATALOG, 'claude')!;
    const plan = findPlan(provider, 'max')!;
    const account = addAccount(emptyState(), presetAccountInput(provider, plan), NOW).account;
    const fable = account.meters.find((meter) => meter.key === 'weekly-fable')!;
    expect(fable.role).toBe('throttle');
    expect(fable.partial).toBe(true);
    const end = new Date(NOW + 2 * 86_400_000).toISOString();
    const state = {
      ...emptyState(),
      accounts: [
        {
          ...account,
          meters: account.meters.map((meter) =>
            meter.key === 'weekly-fable' ? { ...meter, used: 100, resetsAt: end } : meter.key === 'weekly' ? { ...meter, used: 60, resetsAt: end } : meter
          )
        }
      ]
    };
    const views = viewState(state, NOW);
    expect(views.find((view) => view.meter.key === 'weekly-fable')?.throttle).toBe('blocked');
    expect(views.find((view) => view.meter.key === 'weekly')?.blockedBy).toBeNull();
  });

  it('finds providers and plans loosely, and gives custom accounts a monogram', () => {
    expect(findProvider(CATALOG, 'Claude')?.id).toBe('claude');
    expect(findProvider(CATALOG, 'nope')).toBeNull();
    const claude = findProvider(CATALOG, 'claude')!;
    expect(findPlan(claude, 'Max')?.id).toBe('max');
    expect(findPlan(claude, null)?.id).toBe(claude.plans[0]?.id);
    expect(findPlan(claude, 'does-not-exist')).toBeNull();
    expect(monogramFor(CATALOG, 'claude', 'anything')).toBe('Cl');
    expect(monogramFor(CATALOG, 'custom', 'my thing')).toBe('My');
  });
});

describe('sample data', () => {
  const state = demoState(NOW);
  const views = viewState(state, NOW);

  it('shows the whole range of states', () => {
    const tiers = new Set(views.map((view) => view.tier ?? view.throttle));
    for (const expected of ['use-now', 'behind', 'hot', 'on-pace', 'spent', 'fresh', 'blocked', 'open']) expect(tiers, expected).toContain(expected);
  });

  it('has money at risk, a blocked account and history', () => {
    const summary = summarise(state, NOW);
    expect(summary.useNow).toBeGreaterThanOrEqual(2);
    expect(summary.atRiskNow['USD']).toBeGreaterThan(1);
    expect(summary.lost30['USD']).toBeGreaterThan(1);
    expect(views.some((view) => view.blockedBy !== null)).toBe(true);
    expect(state.cycles.length).toBeGreaterThan(10);
    expect(state.spend.length).toBe(2);
  });

  it('is deterministic for a given moment', () => {
    expect(JSON.stringify(demoState(NOW))).toBe(JSON.stringify(state));
  });

  it('marks every meter as sample data', () => {
    for (const account of state.accounts) for (const meter of account.meters) expect(meter.source.kind).toBe('demo');
  });
});
