// The dashboard's data layer has no DOM in it, so its sample backend and the shared list that every view
// is built from can be tested here.

import { describe, expect, it } from 'vitest';

import { demoState } from '../src/core/demo.js';
import { emptyState } from '../src/core/types.js';
import { App } from '../src/web/app.js';
import { BackendError, MemoryBackend } from '../src/web/backend.js';

describe('in-memory backend', () => {
  it('starts on sample data and says so', async () => {
    const loaded = await new MemoryBackend().load();
    expect(loaded.demo).toBe(true);
    expect(loaded.state.accounts.length).toBeGreaterThan(5);
  });

  it('adds from the catalog, applies quick entry and reports changes', async () => {
    const backend = new MemoryBackend(emptyState());
    let changes = 0;
    const stop = backend.subscribe(
      () => (changes += 1),
      () => undefined
    );
    await backend.addPreset({ provider: 'suno', plan: 'pro', billingDay: 12 });
    const preview = await backend.quick('suno 1200 left');
    expect(preview).toContain('1,300 credits used');
    const state = (await backend.load()).state;
    expect(state.accounts[0]?.meters[0]?.used).toBe(1300);
    expect(state.accounts[0]?.meters[0]?.reset).toMatchObject({ kind: 'monthly', day: 12 });
    expect(changes).toBe(2);
    stop();
  });

  it('rejects an ambiguous quick entry with candidates and changes nothing', async () => {
    const backend = new MemoryBackend(emptyState());
    await backend.addPreset({ provider: 'claude', plan: 'pro', label: 'Claude work' });
    await backend.addPreset({ provider: 'claude', plan: 'pro', label: 'Claude home' });
    const error = (await backend.quick('claude 50%').catch((caught: unknown) => caught)) as BackendError;
    expect(error).toBeInstanceOf(BackendError);
    expect(error.candidates?.length).toBe(2);
    const state = (await backend.load()).state;
    expect(state.accounts.every((account) => account.meters.every((meter) => meter.used === 0))).toBe(true);
  });

  it('surfaces validation errors with their field', async () => {
    const backend = new MemoryBackend(emptyState());
    const error = (await backend.addAccount({ label: 'X', meters: [] }).catch((caught: unknown) => caught)) as BackendError;
    expect(error.field).toBe('meters');
  });

  it('edits, snoozes and removes', async () => {
    const backend = new MemoryBackend(emptyState());
    await backend.addPreset({ provider: 'copilot', plan: 'pro' });
    let state = (await backend.load()).state;
    const account = state.accounts[0]!;
    await backend.updateMeter(account.meters[0]!.id, { limit: 2000 });
    await backend.updateAccount(account.id, { snoozedUntil: new Date(Date.now() + 3_600_000).toISOString() });
    await backend.report(account.meters[0]!.id, { used: 500 });
    state = (await backend.load()).state;
    expect(state.accounts[0]?.meters[0]).toMatchObject({ limit: 2000, used: 500 });
    expect(state.accounts[0]?.snoozedUntil).not.toBeNull();
    await backend.removeAccount(account.id);
    expect((await backend.load()).state.accounts).toHaveLength(0);
  });

  it('tracks spend', async () => {
    const backend = new MemoryBackend(emptyState());
    await backend.addSpend({ label: 'OpenAI API', currency: 'USD', monthlyBudget: 50 });
    const id = (await backend.load()).state.spend[0]!.id;
    await backend.recordSpend(id, { amount: 2.1, date: '2026-11-18', mode: 'set' });
    await backend.recordSpend(id, { amount: 1.25, date: '2026-11-18', mode: 'add' });
    expect((await backend.load()).state.spend[0]?.entries).toEqual([{ date: '2026-11-18', amount: 3.35 }]);
  });

  it('refuses collectors, which need the local service', async () => {
    await expect(new MemoryBackend().setCollector('codex-sessions', true)).rejects.toThrow(/local service/);
  });
});

describe('the shared list behind every view', () => {
  async function app(): Promise<App> {
    const instance = new App(new MemoryBackend(demoState(Date.now())));
    await instance.use(instance.model.backend);
    return instance;
  }

  it('puts the most urgent meter first and leaves throttles out', async () => {
    const instance = await app();
    const queue = instance.queue();
    expect(queue[0]?.tier).toBe('use-now');
    expect(queue.every((view) => view.tier !== null)).toBe(true);
    expect(instance.filtered().some((view) => view.tier === null)).toBe(true);
  });

  it('applies the chosen order', async () => {
    const instance = await app();
    instance.setPrefs({ sort: 'value' });
    const values = instance.queue().map((view) => view.valueAtRisk ?? -1);
    expect(values).toEqual([...values].sort((a, b) => b - a));
    instance.setPrefs({ sort: 'reset' });
    const times = instance.queue().map((view) => view.msLeft).filter((value): value is number => value !== null);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('filters by text, category and used-up', async () => {
    const instance = await app();
    instance.setFilter('cla');
    expect(instance.queue().length).toBeGreaterThan(0);
    expect(instance.queue().every((view) => /cla/i.test(`${view.account.label} ${view.account.providerId} ${view.account.plan} ${view.meter.label}`))).toBe(true);
    instance.setFilter('');
    instance.setPrefs({ category: 'music' });
    expect(instance.queue().map((view) => view.account.providerId)).toEqual(['suno']);
    instance.setPrefs({ category: 'all', hideSpent: true });
    expect(instance.queue().some((view) => view.tier === 'spent')).toBe(false);
  });

  it('keeps the selection addressable by meter id and notifies listeners', async () => {
    const instance = await app();
    let notified = 0;
    instance.onChange(() => (notified += 1));
    const first = instance.queue()[0]!;
    instance.select(first.id);
    expect(instance.selected()?.id).toBe(first.id);
    instance.select(first.id);
    expect(notified).toBe(1);
  });
});
