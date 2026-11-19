// The dashboard's data layer has no DOM in it, so its sample backend and the shared list that every view
// is built from can be tested here.

import { describe, expect, it, vi } from 'vitest';

import { demoState } from '../src/core/demo.js';
import { emptyState } from '../src/core/types.js';
import { App } from '../src/web/app.js';
import { BackendError, MemoryBackend } from '../src/web/backend.js';
import type { MeterView } from '../src/core/forecast.js';
import type { ExpiryOutlook, LedgerWeek } from '../src/core/insights.js';
import { attentionRoom, figuresInTiles, fitMoneyText, fitTarget, nextWeek, visibleTiles, weekMoney, willExpireText, windowsStateLost } from '../src/web/overview.js';

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

  it('answers an added or edited meter with the meter as saved, so a form can carry on from it (review finding)', async () => {
    const backend = new MemoryBackend(emptyState());
    await backend.addPreset({ provider: 'copilot', plan: 'pro' });
    const account = (await backend.load()).state.accounts[0]!;
    const added = await backend.addMeter(account.id, { label: 'Extra', reset: { kind: 'interval', hours: 168 } });
    expect(added).toMatchObject({ id: `${account.id}:extra`, label: 'Extra', unit: 'percent' });
    const edited = await backend.updateMeter(added.id, { label: 'Extra weekly', used: 40 });
    expect(edited).toMatchObject({ id: added.id, label: 'Extra weekly', used: 40 });
    expect((await backend.load()).state.accounts[0]?.meters.filter((meter) => meter.label.startsWith('Extra'))).toHaveLength(1);
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

  it('stops filtering by a category that nothing belongs to any more (review finding)', async () => {
    const backend = new MemoryBackend(emptyState());
    await backend.addPreset({ provider: 'suno', plan: 'pro' });
    await backend.addPreset({ provider: 'claude', plan: 'pro' });
    const instance = new App(backend);
    await instance.use(backend);
    instance.setPrefs({ category: 'music' });
    expect(instance.queue().map((view) => view.account.providerId)).toEqual(['suno']);

    // The last music subscription goes. No chip is drawn for a single category, so nothing could clear it.
    await backend.removeAccount(instance.queue()[0]!.account.id);
    await instance.reload();
    expect(instance.model.prefs.category).toBe('all');
    expect(instance.queue().length).toBeGreaterThan(0);
    expect(instance.filtered().every((view) => view.account.providerId === 'claude')).toBe(true);
  });

  it('raises one browser reminder for everything due, and none on sample data (review findings)', async () => {
    const now = Date.now();
    const backend = new MemoryBackend(emptyState());
    // Three weekly quotas with a third left, all resetting within the same half day.
    for (const [index, label] of ['Alpha', 'Bravo', 'Charlie'].entries()) {
      await backend.addAccount({ label, meters: [{ label: 'Weekly limit', reset: { kind: 'interval', hours: 168 }, used: 60, resetsAt: new Date(now + (3 + index) * 3_600_000).toISOString() }] });
    }
    const instance = new App(backend);
    await instance.use(backend);
    instance.setPrefs({ notify: true });

    // The in-memory backend is sample data: nothing is raised, whatever the preference says.
    expect(instance.model.demo).toBe(true);
    expect(instance.tabReminder()).toBeNull();

    // The same state as the person's own data: one message for the three, most urgent first.
    instance.model.demo = false;
    const reminder = instance.tabReminder();
    expect(reminder?.title).toBe('3 quotas to use now');
    expect(reminder?.body.split('\n')).toHaveLength(3);
    expect(reminder?.body).toMatch(/^Alpha: 40% left of the weekly limit/);
    expect(reminder?.keys).toHaveLength(3);
    expect(reminder?.tag).toBe(reminder?.keys[0]);

    // Once raised they stay quiet, the service's own channel takes over when it is on, and off is off.
    instance.setPrefs({ notified: reminder?.keys ?? [] });
    expect(instance.tabReminder()).toBeNull();
    instance.setPrefs({ notified: [] });
    instance.model.reminders = { ...instance.model.reminders, desktop: { ...instance.model.reminders.desktop, enabled: true } };
    expect(instance.tabReminder()).toBeNull();
    instance.model.reminders = { ...instance.model.reminders, desktop: { ...instance.model.reminders.desktop, enabled: false } };
    instance.setPrefs({ notify: false });
    expect(instance.tabReminder()).toBeNull();
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

describe('the Overview', () => {
  async function app(): Promise<App> {
    const instance = new App(new MemoryBackend(demoState(Date.now())));
    await instance.use(instance.model.backend);
    return instance;
  }

  it('scopes finished windows by category and text, and says when a filter applies', async () => {
    const instance = await app();
    const all = instance.cycles();
    expect(all.length).toBeGreaterThan(0);
    expect(instance.filtering()).toBe(false);
    instance.setFilter('claude');
    expect(instance.filtering()).toBe(true);
    const claude = instance.cycles();
    expect(claude.length).toBeGreaterThan(0);
    expect(claude.length).toBeLessThan(all.length);
    expect(claude.every((cycle) => cycle.providerId === 'claude' || /claude/i.test(cycle.accountLabel))).toBe(true);
    instance.setFilter('');
    instance.setPrefs({ category: 'music' });
    expect(instance.cycles().every((cycle) => cycle.providerId === 'suno')).toBe(true);
    // "Hide used up" is about current windows and leaves finished ones alone.
    instance.setPrefs({ category: 'all', hideSpent: true });
    expect(instance.cycles()).toHaveLength(all.length);
  });

  it('matches a finished window through the names it recorded once its subscription is gone', async () => {
    const instance = await app();
    const cycle = instance.cycles()[0]!;
    const backend = instance.model.backend;
    await backend.removeAccount(cycle.accountId);
    await instance.reload();
    instance.setFilter(cycle.accountLabel);
    expect(instance.cycles().some((candidate) => candidate.accountId === cycle.accountId)).toBe(true);
  });

  it('keeps the first two tiles, and restores a hidden tile’s figure to the summary', () => {
    expect(visibleTiles(['lead', 'expiry', 'pace'])).toEqual(['lead', 'expiry', 'windows', 'attention', 'fit', 'spend']);
    expect(figuresInTiles([])).toEqual({ atRisk: true, lost: true, stale: true });
    expect(figuresInTiles(['windows', 'attention'])).toEqual({ atRisk: true, lost: false, stale: false });
    // The expiry tile cannot be hidden, so its figure stays out of the strip.
    expect(figuresInTiles(['expiry']).atRisk).toBe(true);
  });

  it('keeps the money expired in the summary while a filter leaves out every finished window', async () => {
    const instance = await app();
    expect(windowsStateLost(instance)).toBe(true);
    expect(figuresInTiles([], instance).lost).toBe(true);
    instance.setFilter('claude');
    expect(figuresInTiles([], instance).lost).toBe(true);
    instance.setFilter('no subscription is called this');
    expect(instance.cycles()).toHaveLength(0);
    expect(windowsStateLost(instance)).toBe(false);
    expect(figuresInTiles([], instance)).toEqual({ atRisk: true, lost: false, stale: true });
    // With nothing on record the tile says so itself, filter or not.
    const empty = new App(new MemoryBackend(emptyState()));
    empty.setFilter('anything');
    expect(windowsStateLost(empty)).toBe(true);
  });

  it('gives a new window no share in "Will expire", and never leaves the cell blank beside money', () => {
    const view = (tier: MeterView['tier'], projectedUnused: number, valueAtRisk: number | null, rollover: 'none' | 'carries' = 'none'): MeterView =>
      ({ tier, projectedUnused, valueAtRisk, meter: { rollover } }) as unknown as MeterView;
    expect(willExpireText(view('fresh', 0.14, 0))).toBe('too early');
    expect(willExpireText(view('fresh', 0.14, null))).toBe('too early');
    expect(willExpireText(view('spent', 0, 0))).toBe('used up');
    expect(willExpireText(view('behind', 0.14, null))).toBe('14%');
    expect(willExpireText(view('use-now', 0.4, 12))).toBe('40%');
    // Under the 5% that counts as expiring: shown where money stands beside it, blank otherwise.
    expect(willExpireText(view('on-pace', 0.03, 0.45))).toBe('3%');
    expect(willExpireText(view('on-pace', 0.03, null))).toBe('');
    expect(willExpireText(view('hot', 0, 0))).toBe('');
  });

  it('states the next seven days as money, or as a count of quotas without prices', () => {
    const day = (count: number): ExpiryOutlook['days'][number] => ({ date: '', startMs: 0, plan: {}, credits: {}, count, urgent: false, uncertain: false, unvalued: 0, entries: [] });
    const outlook: ExpiryOutlook = {
      days: [day(1), day(0), day(2), day(0), day(0), day(0), day(1), day(5)],
      firstWeek: { plan: { USD: 13.58 }, credits: { USD: 66.92 } },
      later: { plan: {}, credits: {}, count: 0, firstMs: null },
      snoozed: 0,
      stale: 0,
      unvalued: 0
    };
    expect(nextWeek(outlook, 'USD', false)).toEqual({ label: 'Next 7 days', figure: '$13.58, plus $66.92 in credits' });
    // The eighth day is outside the week.
    expect(nextWeek(outlook, 'USD', true)).toEqual({ label: 'Next 7 days, quotas losing 5% or more', figure: '4' });
    expect(nextWeek({ ...outlook, firstWeek: { plan: {}, credits: {} } }, 'USD', false).figure).toBe('$0.00');
  });

  it('writes a week’s estimated amounts as "about" whole units, credits included', () => {
    const week = (patch: Partial<LedgerWeek>): LedgerWeek => ({
      startMs: 0,
      endMs: 0,
      windows: 2,
      estimatedWindows: 0,
      lost: {},
      lostEstimated: {},
      creditsLost: {},
      creditsLostEstimated: {},
      trailingUtilisation: null,
      trailingWindows: 0,
      ...patch
    });
    expect(weekMoney(week({ windows: 0 }), 'USD')).toEqual(['no window closed', '', '', '']);
    expect(weekMoney(week({}), 'USD')).toEqual(['$0.00', '', '', '']);
    expect(weekMoney(week({ lost: { USD: 9.68 }, creditsLost: { USD: 52 }, creditsLostEstimated: { USD: 52 } }), 'USD')).toEqual(['$9.68', '', 'about $52', 'about $52']);
    expect(weekMoney(week({ lost: { USD: 12.19 }, lostEstimated: { USD: 4.4 } }), 'USD')).toEqual(['about $12', 'about $4', '', '']);
  });

  it('always lists closed limits in "Needs attention", and links the rest where they are listed', () => {
    expect(attentionRoom(0, 0)).toEqual({ blocked: 0, stale: 0, moreStale: 0, moreBlocked: 0 });
    expect(attentionRoom(3, 1)).toEqual({ blocked: 1, stale: 3, moreStale: 0, moreBlocked: 0 });
    // Six stale readings and a closed limit: the limit keeps its place and the Queue gets the readings that do not fit.
    expect(attentionRoom(6, 1)).toEqual({ blocked: 1, stale: 4, moreStale: 2, moreBlocked: 0 });
    expect(attentionRoom(2, 7)).toEqual({ blocked: 5, stale: 0, moreStale: 2, moreBlocked: 2 });
  });

  it('says what a Plan fit row left unused, and "nothing expired" only when nothing was', () => {
    const row = { utilisation: 0.6, lost: {}, lostIsEstimate: false, creditsLost: {}, creditsIsEstimate: false };
    expect(fitMoneyText(row, 'USD')).toBe('40% left unused, no price set');
    expect(fitMoneyText({ ...row, utilisation: 1 }, 'USD')).toBe('nothing expired');
    expect(fitMoneyText({ ...row, lost: { USD: 54.97 }, lostIsEstimate: true }, 'USD')).toBe('about $55 left unused');
    expect(fitMoneyText({ ...row, lost: { USD: 10 }, creditsLost: { USD: 52 }, creditsIsEstimate: true }, 'USD')).toBe('$10.00 left unused, plus about $52 in credits');
  });

  it('opens a Plan fit row from every meter, so "Hide used up" cannot make a subscription unselectable', async () => {
    const instance = await app();
    instance.setPrefs({ hideSpent: true });
    const every = instance.allViews();
    const spent = every.find((view) => view.tier === 'spent');
    expect(spent).toBeDefined();
    expect(instance.filtered().some((view) => view.id === spent!.id)).toBe(false);
    expect(fitTarget({ accountId: spent!.account.id, topMeterId: spent!.id }, every)).toBe(spent!.id);
    // A meter removed since its windows closed: another quota of the same subscription opens instead.
    const fallback = fitTarget({ accountId: spent!.account.id, topMeterId: 'gone' }, every);
    expect(every.find((view) => view.id === fallback)?.account.id).toBe(spent!.account.id);
    expect(fitTarget({ accountId: 'gone', topMeterId: 'gone' }, every)).toBeNull();
  });

  it('drops unknown and unhideable tiles from remembered settings', () => {
    const stored = new Map<string, string>([
      ['tokengator.prefs.v1', JSON.stringify({ view: 'overview', overviewHidden: ['pace', 'lead', 'nonsense', 4] })]
    ]);
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => void stored.set(key, value)
    });
    try {
      const instance = new App(new MemoryBackend(emptyState()));
      expect(instance.model.prefs.view).toBe('overview');
      expect(instance.model.prefs.overviewHidden).toEqual(['pace']);
      stored.set('tokengator.prefs.v1', JSON.stringify({ overviewHidden: 'pace' }));
      expect(new App(new MemoryBackend(emptyState())).model.prefs.overviewHidden).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
