import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { emptyState } from '../src/core/types.js';
import { restrictedFetchJson, type FetchLike } from '../src/server/collectors/fetch.js';
import { createCollectorRunner } from '../src/server/collectors/index.js';
import {
  anthropicCosts,
  codexMeters,
  codexSessions,
  copilot,
  elevenlabs,
  openaiCosts,
  openrouter,
  parseCodexLog,
  parseCopilot
} from '../src/server/collectors/sources.js';
import { parseStatusline, runStatusline, statuslineText } from '../src/server/collectors/statusline.js';
import { CollectorError, type Collector, type CollectorContext } from '../src/server/collectors/types.js';
import { TokengatorService } from '../src/server/service.js';
import { MemoryStateStore } from '../src/server/store.js';

const NOW = Date.parse('2026-11-19T10:00:00Z');
const SECRET = 'sk-test-SECRET-9f8e7d6c5b4a3210';

function service(now = NOW): TokengatorService {
  return new TokengatorService(new MemoryStateStore(emptyState()), { now: () => now, timeZone: 'UTC' });
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function context(env: Record<string, string>, fetchImpl: FetchLike, allowedHosts: string[], homeDir = '/nonexistent'): CollectorContext {
  const controller = new AbortController();
  return { env, homeDir, nowMs: NOW, signal: controller.signal, fetchJson: restrictedFetchJson(allowedHosts, controller.signal, fetchImpl) };
}

describe('restricted fetch', () => {
  const never: FetchLike = () => Promise.reject(new Error('should not be called'));

  it('refuses plain HTTP', async () => {
    const fetchJson = restrictedFetchJson(['api.example.com'], new AbortController().signal, never);
    await expect(fetchJson('http://api.example.com/x')).rejects.toThrow(/HTTPS/);
  });

  it('refuses a host that is not the collector’s own', async () => {
    const fetchJson = restrictedFetchJson(['api.example.com'], new AbortController().signal, never);
    await expect(fetchJson('https://evil.example/x')).rejects.toThrow(/not allowed/);
  });

  it('does not follow a redirect and reports it', async () => {
    const calls: string[] = [];
    const fetchImpl: FetchLike = (url, init) => {
      calls.push(url);
      expect(init.redirect).toBe('manual');
      return Promise.resolve(new Response(null, { status: 302, headers: { location: 'https://evil.example/steal' } }));
    };
    const fetchJson = restrictedFetchJson(['api.example.com'], new AbortController().signal, fetchImpl);
    await expect(fetchJson('https://api.example.com/x', { headers: { Authorization: `Bearer ${SECRET}` } })).rejects.toThrow(/redirect/);
    expect(calls).toEqual(['https://api.example.com/x']);
  });

  it('maps 401 and 403 to an auth error without echoing anything', async () => {
    const fetchImpl: FetchLike = () => Promise.resolve(jsonResponse({ error: `bad key ${SECRET}` }, 401));
    const fetchJson = restrictedFetchJson(['api.example.com'], new AbortController().signal, fetchImpl);
    const error = await fetchJson('https://api.example.com/x').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CollectorError);
    expect((error as CollectorError).kind).toBe('auth');
    expect((error as Error).message).not.toContain(SECRET);
  });

  it('redacts secrets from network error messages', async () => {
    const fetchImpl: FetchLike = () => Promise.reject(new Error(`connect failed for Bearer ${SECRET}`));
    const fetchJson = restrictedFetchJson(['api.example.com'], new AbortController().signal, fetchImpl);
    const error = (await fetchJson('https://api.example.com/x').catch((caught: unknown) => caught)) as Error;
    expect(error.message).not.toContain(SECRET);
  });
});

describe('Claude Code status line', () => {
  const input = JSON.stringify({
    session_id: 'abc',
    model: { id: 'claude-opus-5-5' },
    rate_limits: {
      five_hour: { used_percentage: 23.5, resets_at: Math.floor((NOW + 2 * 3_600_000) / 1000) },
      seven_day: { used_percentage: 41.2, resets_at: Math.floor((NOW + 3 * 86_400_000) / 1000) }
    }
  });

  it('reads both windows with reset times in Unix seconds', () => {
    const meters = parseStatusline(input, NOW);
    expect(meters.map((meter) => meter.key)).toEqual(['session', 'weekly']);
    expect(meters[0]?.reading.usedPercent).toBe(23.5);
    expect(meters[1]?.reading.resetsAt).toBe(new Date(NOW + 3 * 86_400_000).toISOString());
  });

  it('returns nothing for input without rate limits, and for garbage', () => {
    expect(parseStatusline(JSON.stringify({ session_id: 'abc' }), NOW)).toEqual([]);
    expect(parseStatusline('not json', NOW)).toEqual([]);
    expect(parseStatusline('', NOW)).toEqual([]);
  });

  it('drops a reset time that has already passed but keeps the percentage', () => {
    const stale = JSON.stringify({ rate_limits: { seven_day: { used_percentage: 80, resets_at: Math.floor((NOW - 1000) / 1000) } } });
    const meters = parseStatusline(stale, NOW);
    expect(meters).toHaveLength(1);
    expect(meters[0]?.reading.resetsAt).toBeUndefined();
  });

  it('records both meters on the Claude account and prints one line', async () => {
    const svc = service();
    const line = await runStatusline(input, svc);
    const state = await svc.state();
    const claude = state.accounts.find((account) => account.providerId === 'claude');
    expect(claude).toBeDefined();
    const weekly = claude?.meters.find((meter) => meter.key === 'weekly');
    const session = claude?.meters.find((meter) => meter.key === 'session');
    expect(weekly?.used).toBeCloseTo(41.2);
    expect(weekly?.source).toEqual({ kind: 'statusline', id: 'claude-statusline' });
    expect(session?.used).toBeCloseTo(23.5);
    expect(line).toContain('week 59% left');
    expect(line).toContain('5h');
    expect(line.includes('\n')).toBe(false);
  });

  it('prints a line and changes nothing when there are no rate limits', async () => {
    const svc = service();
    const line = await runStatusline(JSON.stringify({ session_id: 'x' }), svc);
    expect(line).toBe('tokengator');
    expect((await svc.state()).accounts).toHaveLength(0);
  });

  it('never throws, even when the state cannot be written', async () => {
    const svc = service();
    vi.spyOn(svc, 'applyCollected').mockRejectedValue(new Error('locked'));
    await expect(runStatusline(input, svc)).resolves.toEqual(expect.any(String));
    vi.spyOn(svc, 'state').mockRejectedValue(new Error('unreadable'));
    await expect(runStatusline(input, svc)).resolves.toBe('tokengator');
  });

  it('mentions another subscription that needs using now', async () => {
    const svc = service();
    await svc.addAccount({
      providerId: 'suno',
      label: 'Suno Pro',
      price: { amount: 10, currency: 'USD', period: 'month' },
      meters: [{ label: 'Credits', unit: 'credits', limit: 2500, used: 900, reset: { kind: 'interval', hours: 720 }, resetsAt: new Date(NOW + 30 * 3_600_000).toISOString() }]
    });
    expect(statuslineText(await svc.state(), NOW)).toContain('use now: Suno Pro 64% left');
  });
});

describe('Codex session logs', () => {
  const line = (at: string, primary: object | null, secondary: object | null, plan: string | null = 'plus'): string =>
    JSON.stringify({ timestamp: at, type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: { limit_id: 'codex', primary, secondary, plan_type: plan } } });
  const window = (used: number, minutes: number, resetsInMs: number): object => ({ used_percent: used, window_minutes: minutes, resets_at: Math.floor((NOW + resetsInMs) / 1000) });

  it('takes the last snapshot in a log and tolerates a cut first line', () => {
    const text = ['{"cut": tru', line('2026-11-19T08:00:00Z', window(10, 300, 3_600_000), window(20, 10080, 86_400_000)), '{"type":"other"}', line('2026-11-19T09:30:00Z', window(57, 300, 3_600_000), window(31, 10080, 86_400_000))].join('\n');
    const snapshot = parseCodexLog(text);
    expect(snapshot?.windows.map((entry) => entry.usedPercent)).toEqual([57, 31]);
    expect(snapshot?.planType).toBe('plus');
  });

  it('maps windows by length and ignores ones that have ended', () => {
    const snapshot = parseCodexLog(line('2026-11-19T09:30:00Z', window(57, 300, -60_000), window(31, 10080, 86_400_000)));
    expect(snapshot).not.toBeNull();
    const meters = codexMeters(snapshot as NonNullable<typeof snapshot>, NOW);
    expect(meters).toHaveLength(1);
    expect(meters[0]?.key).toBe('weekly');
    expect(meters[0]?.reading.usedPercent).toBe(31);
  });

  describe('on disk', () => {
    let home: string;
    beforeEach(async () => {
      home = await mkdtemp(join(tmpdir(), 'tg-codex-'));
    });
    afterEach(async () => {
      await rm(home, { recursive: true, force: true });
    });

    it('is unavailable without logs', async () => {
      const answer = await codexSessions.available({ env: {}, homeDir: home });
      expect(answer.ok).toBe(false);
    });

    it('reads the newest snapshot across recent files', async () => {
      const dir = join(home, '.codex', 'sessions', '2026', '11', '19');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'rollout-2026-11-19T08-00-00-aaa.jsonl'), `${line('2026-11-19T08:00:00Z', window(10, 300, 3_600_000), window(20, 10080, 86_400_000))}\n`);
      await writeFile(join(dir, 'rollout-2026-11-19T09-00-00-bbb.jsonl'), `${line('2026-11-19T09:30:00Z', window(57, 300, 3_600_000), window(31, 10080, 86_400_000))}\n`);
      expect((await codexSessions.available({ env: {}, homeDir: home })).ok).toBe(true);
      const result = await codexSessions.collect(context({}, () => Promise.reject(new Error('no network')), [], home));
      expect(result.accounts[0]?.planId).toBe('plus');
      expect(result.accounts[0]?.meters.map((meter) => [meter.key, meter.reading.usedPercent])).toEqual([
        ['session', 57],
        ['weekly', 31]
      ]);
    });

    it('applies nothing when every snapshot is from a finished window', async () => {
      const dir = join(home, '.codex', 'sessions', '2026', '11', '10');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'rollout-2026-11-10T08-00-00-aaa.jsonl'), `${line('2026-11-10T08:00:00Z', window(90, 300, -86_400_000), window(70, 10080, -3_600_000))}\n`);
      const result = await codexSessions.collect(context({}, () => Promise.reject(new Error('no network')), [], home));
      expect(result.accounts).toEqual([]);
      expect(result.note).toMatch(/already ended/);
    });

    it('honours CODEX_HOME', async () => {
      const custom = join(home, 'elsewhere');
      const dir = join(custom, 'sessions', '2026', '11', '19');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'rollout-2026-11-19T09-00-00-ccc.jsonl'), `${line('2026-11-19T09:30:00Z', null, window(31, 10080, 86_400_000), null)}\n`);
      expect((await codexSessions.available({ env: { CODEX_HOME: custom }, homeDir: home })).ok).toBe(true);
    });
  });
});

describe('documented API collectors', () => {
  it('ElevenLabs: reads credits, limit, reset and tier, sending the key only as xi-api-key', async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const fetchImpl: FetchLike = (url, init) => {
      seen.push({ url, headers: init.headers as Record<string, string> });
      return Promise.resolve(jsonResponse({ tier: 'creator', character_count: 38_000, character_limit: 121_000, next_character_count_reset_unix: Math.floor((NOW + 6 * 86_400_000) / 1000) }));
    };
    const result = await elevenlabs.collect(context({ ELEVENLABS_API_KEY: SECRET }, fetchImpl, elevenlabs.allowedHosts));
    expect(seen[0]?.url).toBe('https://api.elevenlabs.io/v1/user/subscription');
    expect(seen[0]?.headers['xi-api-key']).toBe(SECRET);
    expect(result.accounts[0]).toMatchObject({ providerId: 'elevenlabs', planId: 'creator' });
    expect(result.accounts[0]?.meters[0]?.reading).toMatchObject({ used: 38_000, limit: 121_000 });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('ElevenLabs: an authorisation failure names no secret', async () => {
    const fetchImpl: FetchLike = () => Promise.resolve(jsonResponse({ detail: { message: `invalid ${SECRET}` } }, 401));
    const error = (await elevenlabs.collect(context({ ELEVENLABS_API_KEY: SECRET }, fetchImpl, elevenlabs.allowedHosts)).catch((caught: unknown) => caught)) as CollectorError;
    expect(error.kind).toBe('auth');
    expect(error.message).not.toContain(SECRET);
  });

  it('is unavailable, naming the variable but no value, when the key is missing', async () => {
    for (const collector of [elevenlabs, openrouter, openaiCosts, anthropicCosts, copilot]) {
      const answer = await collector.available({ env: {}, homeDir: '/nonexistent' });
      expect(answer.ok).toBe(false);
      expect(answer.reason).toContain(collector.env[0]);
    }
  });

  it('OpenRouter: reads total credits and usage', async () => {
    const fetchImpl: FetchLike = () => Promise.resolve(jsonResponse({ data: { total_credits: 25, total_usage: 9.4 } }));
    const result = await openrouter.collect(context({ OPENROUTER_API_KEY: SECRET }, fetchImpl, openrouter.allowedHosts));
    expect(result.accounts[0]?.meters[0]?.reading).toEqual({ used: 9.4, limit: 25 });
  });

  it('OpenAI costs: sums results per UTC day and follows pagination', async () => {
    const day = (iso: string): number => Math.floor(Date.parse(iso) / 1000);
    const pages = [
      { data: [{ start_time: day('2026-11-17T00:00:00Z'), results: [{ amount: { value: 1.25, currency: 'usd' } }, { amount: { value: 0.5, currency: 'usd' } }] }], has_more: true, next_page: 'p2' },
      { data: [{ start_time: day('2026-11-18T00:00:00Z'), results: [{ amount: { value: 2, currency: 'usd' } }] }], has_more: false, next_page: null }
    ];
    const urls: string[] = [];
    const fetchImpl: FetchLike = (url) => {
      urls.push(url);
      return Promise.resolve(jsonResponse(pages[urls.length - 1]));
    };
    const result = await openaiCosts.collect(context({ OPENAI_ADMIN_KEY: SECRET }, fetchImpl, openaiCosts.allowedHosts));
    expect(urls).toHaveLength(2);
    expect(urls[1]).toContain('page=p2');
    expect(result.spend[0]?.days).toEqual([
      { date: '2026-11-17', amount: 1.75 },
      { date: '2026-11-18', amount: 2 }
    ]);
  });

  it('Anthropic costs: converts cent strings to dollars', async () => {
    const fetchImpl: FetchLike = (_url, init) => {
      expect((init.headers as Record<string, string>)['x-api-key']).toBe(SECRET);
      return Promise.resolve(jsonResponse({ data: [{ starting_at: '2026-11-18T00:00:00Z', ending_at: '2026-11-19T00:00:00Z', results: [{ amount: '123.45', currency: 'USD' }, { amount: '76.55', currency: 'USD' }] }], has_more: false }));
    };
    const result = await anthropicCosts.collect(context({ ANTHROPIC_ADMIN_KEY: SECRET }, fetchImpl, anthropicCosts.allowedHosts));
    expect(result.spend[0]?.days).toEqual([{ date: '2026-11-18', amount: 2 }]);
  });
});

describe('GitHub Copilot (undocumented)', () => {
  it('is labelled as undocumented', () => {
    expect(copilot.sourceKind).toBe('undocumented-api');
    expect(copilot.description).toMatch(/undocumented/);
  });

  it('reads the token-billing shape with a string entitlement', () => {
    const account = parseCopilot(
      {
        copilot_plan: 'individual_pro',
        token_based_billing: true,
        quota_reset_date_utc: '2026-12-01T00:00:00.000Z',
        quota_snapshots: { premium_interactions: { entitlement: '7000', quota_remaining: 5250, percent_remaining: 75, unlimited: false, quota_reset_at: Math.floor(Date.parse('2026-12-01T00:00:00Z') / 1000) } }
      },
      NOW
    );
    expect(account).toMatchObject({ providerId: 'copilot', planId: 'pro-plus' });
    expect(account?.meters[0]).toEqual({ key: 'ai-credits', reading: { limit: 7000, remaining: 5250, resetsAt: '2026-12-01T00:00:00.000Z' } });
  });

  it('reads the older request-based shape', () => {
    const account = parseCopilot({ copilot_plan: 'individual', quota_reset_date: '2026-12-01', quota_snapshots: { premium_interactions: { entitlement: 300, remaining: 120, percent_remaining: 40, unlimited: false } } }, NOW);
    expect(account?.planId).toBe('legacy-pro');
    expect(account?.meters[0]?.key).toBe('premium-requests');
    expect(account?.meters[0]?.reading).toMatchObject({ limit: 300, remaining: 120 });
  });

  it('falls back to a percentage when there is no denominator, and skips unlimited seats', () => {
    const percentOnly = parseCopilot({ quota_snapshots: { premium_interactions: { percent_remaining: 62.5, unlimited: false } } }, NOW);
    expect(percentOnly?.meters[0]?.reading).toEqual({ remainingPercent: 62.5 });
    expect(parseCopilot({ quota_snapshots: { premium_interactions: { unlimited: true } } }, NOW)).toBeNull();
    expect(parseCopilot({}, NOW)).toBeNull();
  });
});

describe('collector runner', () => {
  const fake = (id: string, behaviour: () => Promise<{ used: number }>, extra: Partial<Collector> = {}): Collector => ({
    id,
    providerId: id,
    title: id,
    description: `${id} test source`,
    sourceKind: 'documented-api',
    allowedHosts: [],
    env: [],
    intervalMinutes: 5,
    available: () => Promise.resolve({ ok: true }),
    collect: async () => {
      const { used } = await behaviour();
      return { accounts: [{ providerId: id, meters: [{ key: 'credits', label: 'Credits', reading: { usedPercent: used } }] }], spend: [] };
    },
    ...extra
  });

  it('runs nothing until a collector is enabled', async () => {
    const svc = service();
    const collect = vi.fn(() => Promise.resolve({ used: 10 }));
    const runner = createCollectorRunner(svc, { env: {}, homeDir: '/nonexistent', collectors: [fake('alpha', collect)], now: () => NOW });
    await runner.refresh();
    expect(collect).not.toHaveBeenCalled();
    const [status] = await runner.list();
    expect(status).toMatchObject({ id: 'alpha', enabled: false, available: true, lastOutcome: null });

    const enabled = await runner.setEnabled('alpha', true);
    expect(collect).toHaveBeenCalledTimes(1);
    expect(enabled).toMatchObject({ enabled: true, lastOutcome: 'ok' });
    expect((await svc.state()).settings.enabledCollectors).toEqual(['alpha']);
    const account = (await svc.state()).accounts.find((candidate) => candidate.providerId === 'alpha');
    expect(account?.meters[0]?.source).toEqual({ kind: 'collector', id: 'alpha' });
    runner.stop();
  });

  it('isolates a failing collector from the others', async () => {
    const svc = service();
    const runner = createCollectorRunner(svc, {
      env: {},
      homeDir: '/nonexistent',
      collectors: [fake('good', () => Promise.resolve({ used: 30 })), fake('bad', () => Promise.reject(new CollectorError(`boom Bearer ${SECRET}`)))],
      now: () => NOW
    });
    await svc.updateSettings({ enabledCollectors: ['good', 'bad'] });
    const statuses = await runner.refresh();
    const good = statuses.find((status) => status.id === 'good');
    const bad = statuses.find((status) => status.id === 'bad');
    expect(good?.lastOutcome).toBe('ok');
    expect(good?.lastUpdated).toHaveLength(1);
    expect(bad?.lastOutcome).toBe('failed');
    expect(bad?.lastMessage).not.toContain(SECRET);
    expect((await svc.state()).accounts.map((account) => account.providerId)).toEqual(['good']);
    runner.stop();
  });

  it('reports a rejected credential as such', async () => {
    const svc = service();
    const runner = createCollectorRunner(svc, { env: {}, homeDir: '/nonexistent', collectors: [fake('authy', () => Promise.reject(new CollectorError('rejected', 'auth')))], now: () => NOW });
    const status = await runner.setEnabled('authy', true);
    expect(status.lastOutcome).toBe('auth');
    runner.stop();
  });

  it('backs off after repeated failures, up to an hour', async () => {
    vi.useFakeTimers();
    try {
      let clock = NOW;
      const svc = new TokengatorService(new MemoryStateStore(emptyState()), { now: () => clock, timeZone: 'UTC' });
      const runner = createCollectorRunner(svc, { env: {}, homeDir: '/nonexistent', collectors: [fake('flaky', () => Promise.reject(new CollectorError('down')))], now: () => clock });
      await svc.updateSettings({ enabledCollectors: ['flaky'] });
      runner.start();
      await vi.advanceTimersByTimeAsync(0);
      const waits: number[] = [];
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const [status] = await runner.list();
        const next = Date.parse(status?.nextRunAt ?? '');
        waits.push(next - clock);
        clock = next;
        await vi.advanceTimersByTimeAsync(waits[waits.length - 1] ?? 0);
      }
      expect(waits[0]).toBe(10 * 60_000);
      expect(waits[1]).toBeGreaterThan(waits[0] as number);
      expect(Math.max(...waits)).toBe(60 * 60_000);
      runner.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects an unknown collector id', async () => {
    const runner = createCollectorRunner(service(), { env: {}, homeDir: '/nonexistent', collectors: [], now: () => NOW });
    await expect(runner.setEnabled('nope', true)).rejects.toThrow(/Unknown collector/);
  });

  it('keeps credentials out of state, status and exports', async () => {
    const svc = service();
    const fetchImpl: FetchLike = () => Promise.resolve(jsonResponse({ tier: 'creator', character_count: 100, character_limit: 1000 }));
    const runner = createCollectorRunner(svc, { env: { ELEVENLABS_API_KEY: SECRET }, homeDir: '/nonexistent', collectors: [elevenlabs], fetchImpl, now: () => NOW });
    const status = await runner.setEnabled('elevenlabs', true);
    expect(status.lastOutcome).toBe('ok');
    const everything = JSON.stringify([await svc.exportState(), await runner.list(), await svc.snapshot(), await svc.brief()]);
    expect(everything).not.toContain(SECRET);
    runner.stop();
  });

  it('leaves a manual meter of the same account untouched', async () => {
    const svc = service();
    await svc.addAccount({
      providerId: 'alpha',
      label: 'Alpha',
      meters: [
        { key: 'credits', label: 'Credits', unit: 'percent', reset: { kind: 'none' } },
        { key: 'manual', label: 'By hand', unit: 'percent', used: 12, reset: { kind: 'none' } }
      ]
    });
    const runner = createCollectorRunner(svc, { env: {}, homeDir: '/nonexistent', collectors: [fake('alpha', () => Promise.resolve({ used: 44 }))], now: () => NOW });
    await runner.setEnabled('alpha', true);
    const account = (await svc.state()).accounts[0];
    expect(account?.meters.find((meter) => meter.key === 'credits')?.used).toBe(44);
    expect(account?.meters.find((meter) => meter.key === 'manual')).toMatchObject({ used: 12, source: { kind: 'manual' } });
    runner.stop();
  });
});
