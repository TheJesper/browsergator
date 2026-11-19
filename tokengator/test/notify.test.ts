import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { addAccount, updateSettings, type MeterInput } from '../src/core/accounts.js';
import { HOUR, iso } from '../src/core/time.js';
import { emptyState, type State } from '../src/core/types.js';
import {
  NOTIFY_URL_VARIABLE,
  ReminderRunner,
  TEST_MESSAGE,
  desktopCommand,
  webhookRequest,
  webhookTarget,
  type DesktopCommand,
  type WebhookTarget
} from '../src/server/notify.js';
import { TokengatorService } from '../src/server/service.js';
import { MemoryStateStore } from '../src/server/store.js';

const NOW = Date.UTC(2026, 10, 19, 10, 0, 0);
const SECRET_URL = 'https://ntfy.example/secret-topic-9f3a7c';
const HOSTILE = { title: 'Use "Claude"; $(rm -rf ~) `id` now', body: "it's 38% left' & del *.* | $env:USERPROFILE" };

const weekly = (hours: number, usedPercent: number): MeterInput => ({
  label: 'Weekly limit',
  reset: { kind: 'interval', hours: 168 },
  used: usedPercent,
  resetsAt: iso(NOW + hours * HOUR)
});

function stateWith(accounts: [string, MeterInput][], desktop = false): State {
  let state = emptyState();
  for (const [label, meter] of accounts) state = addAccount(state, { label, meters: [meter] }, NOW).state;
  return desktop ? updateSettings(state, { desktopReminders: true }) : state;
}

interface Harness {
  runner: ReminderRunner;
  service: TokengatorService;
  commands: DesktopCommand[];
  posts: { url: string; headers: Record<string, string>; body: string }[];
  clock: { now: number };
}

function harness(
  state: State,
  options: { env?: NodeJS.ProcessEnv; home?: string | null; platform?: NodeJS.Platform; runFails?: boolean; fetchStatus?: number; fetchThrows?: boolean } = {}
): Harness {
  const clock = { now: NOW };
  const service = new TokengatorService(new MemoryStateStore(state), { now: () => clock.now, timeZone: 'UTC' });
  const commands: DesktopCommand[] = [];
  const posts: Harness['posts'] = [];
  const runner = new ReminderRunner(service, {
    home: options.home ?? null,
    env: options.env ?? {},
    platform: options.platform ?? 'linux',
    run: (command) => {
      commands.push(command);
      return options.runFails ? Promise.reject(new Error('notify-send is not installed.')) : Promise.resolve();
    },
    fetchImpl: ((input: URL | string, init?: RequestInit) => {
      if (options.fetchThrows) return Promise.reject(new TypeError(`fetch failed for ${String(input)}`));
      posts.push({ url: String(input), headers: init?.headers as Record<string, string>, body: String(init?.body) });
      return Promise.resolve(new Response('ok', { status: options.fetchStatus ?? 200 }));
    }) as typeof fetch
  });
  return { runner, service, commands, posts, clock };
}

describe('desktopCommand', () => {
  it('uses the platform command and passes the text as data, never as script', () => {
    const mac = desktopCommand('darwin', HOSTILE);
    expect(mac?.command).toBe('osascript');
    // The script lines are fixed; the text is the last two arguments.
    expect(mac?.args.slice(0, 6)).toEqual(['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run']);
    expect(mac?.args.slice(6)).toEqual([HOSTILE.title, HOSTILE.body]);

    const windows = desktopCommand('win32', HOSTILE);
    expect(windows?.command).toBe('powershell.exe');
    expect(windows?.args.slice(0, 4)).toEqual(['-NoProfile', '-NonInteractive', '-NoLogo', '-Command']);
    expect(windows?.args.join(' ')).not.toContain('Claude');
    expect(windows?.args.join(' ')).not.toContain('38%');
    expect(windows?.env).toEqual({ TOKENGATOR_NOTIFY_TITLE: HOSTILE.title, TOKENGATOR_NOTIFY_BODY: HOSTILE.body });

    const linux = desktopCommand('linux', { title: '--urgency=critical', body: '-x' });
    expect(linux).toEqual({ command: 'notify-send', args: ['--app-name=Tokengator', '--', '--urgency=critical', '-x'] });
  });

  it('is nothing on a platform without a standard command', () => {
    expect(desktopCommand('aix', TEST_MESSAGE)).toBeNull();
  });
});

describe('webhookTarget', () => {
  it('is absent when the variable is not set', () => {
    expect(webhookTarget({})).toBeNull();
    expect(webhookTarget({ [NOTIFY_URL_VARIABLE]: '  ' })).toBeNull();
  });

  it('accepts https anywhere and http on this computer only', () => {
    expect(webhookTarget({ [NOTIFY_URL_VARIABLE]: SECRET_URL })).toMatchObject({ host: 'ntfy.example', format: 'text' });
    expect(webhookTarget({ [NOTIFY_URL_VARIABLE]: 'http://127.0.0.1:8080/topic' })).toMatchObject({ host: '127.0.0.1', format: 'text' });
    expect(webhookTarget({ [NOTIFY_URL_VARIABLE]: 'http://localhost/topic' })).toMatchObject({ host: 'localhost' });
    for (const bad of ['http://ntfy.example/topic', 'ftp://ntfy.example/topic', 'not an address', 'https://user:pass@ntfy.example/topic', 'file:///etc/passwd']) {
      const result = webhookTarget({ [NOTIFY_URL_VARIABLE]: bad });
      expect(result).toHaveProperty('error');
      // The refusal names the variable, not the value.
      expect((result as { error: string }).error).not.toContain('ntfy.example');
    }
  });

  it('recognises Slack and Discord addresses', () => {
    expect(webhookTarget({ [NOTIFY_URL_VARIABLE]: 'https://hooks.slack.com/services/T0/B0/xyz' })).toMatchObject({ format: 'slack' });
    expect(webhookTarget({ [NOTIFY_URL_VARIABLE]: 'https://discord.com/api/webhooks/1/abc' })).toMatchObject({ format: 'discord' });
    expect(webhookTarget({ [NOTIFY_URL_VARIABLE]: 'https://discord.com/other' })).toMatchObject({ format: 'text' });
  });
});

describe('webhookRequest', () => {
  const target = (url: string): WebhookTarget => webhookTarget({ [NOTIFY_URL_VARIABLE]: url }) as WebhookTarget;
  const message = { title: 'Use Claude Max now', body: '38% left of the weekly limit, resets in 14h.' };

  it('sends plain text with the title as a header, which is what ntfy takes', () => {
    expect(webhookRequest(target(SECRET_URL), message)).toEqual({
      headers: { 'Content-Type': 'text/plain; charset=utf-8', Title: 'Use Claude Max now' },
      body: '38% left of the weekly limit, resets in 14h.'
    });
  });

  it('moves a title that cannot be a header into the body', () => {
    const request = webhookRequest(target(SECRET_URL), { title: 'Use Tëam now', body: 'Half left.' });
    expect(request.headers).toEqual({ 'Content-Type': 'text/plain; charset=utf-8' });
    expect(request.body).toBe('Use Tëam now\nHalf left.');
    const injected = webhookRequest(target(SECRET_URL), { title: 'Use A\r\nX-Evil: 1 now', body: 'b' });
    expect(injected.headers['Title']).toBeUndefined();
  });

  it('speaks JSON to Slack and Discord, and lets nothing ping anyone', () => {
    expect(JSON.parse(webhookRequest(target('https://hooks.slack.com/services/T0/B0/xyz'), message).body)).toEqual({
      text: '*Use Claude Max now*\n38% left of the weekly limit, resets in 14h.'
    });
    expect(JSON.parse(webhookRequest(target('https://discord.com/api/webhooks/1/abc'), { title: 'Use @everyone now', body: 'b' }).body)).toEqual({
      content: '**Use @everyone now**\nb',
      allowed_mentions: { parse: [] }
    });
  });
});

describe('ReminderRunner', () => {
  let home = '';
  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'tokengator-notify-'));
  });
  afterAll(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('does nothing while no channel is switched on, and keeps the reminder for later', async () => {
    const h = harness(stateWith([['Claude Max', weekly(14, 62)]]));
    const outcome = await h.runner.check();
    expect(outcome.due).toHaveLength(1);
    expect(outcome.deliveries).toEqual([]);
    expect(h.commands).toEqual([]);
    // Still due: nothing was raised, so nothing was recorded.
    expect((await h.runner.check()).due).toHaveLength(1);
  });

  it('raises a due quota on the desktop once per window', async () => {
    const h = harness(stateWith([['Claude Max', weekly(14, 62)]], true));
    const outcome = await h.runner.check();
    expect(outcome.deliveries).toEqual([{ channel: 'desktop', ok: true }]);
    expect(h.commands).toHaveLength(1);
    expect(h.commands[0]?.args.slice(-2)).toEqual(['Use Claude Max now', '38% left of the weekly limit, resets in 14h (tomorrow 00:00).']);

    h.clock.now += HOUR;
    const again = await h.runner.check();
    expect(again.due).toEqual([]);
    expect(h.commands).toHaveLength(1);
  });

  it('folds several due quotas into one notification', async () => {
    const h = harness(stateWith([['Alpha', weekly(3, 40)], ['Bravo', weekly(4, 40)]], true));
    await h.runner.check();
    expect(h.commands).toHaveLength(1);
    expect(h.commands[0]?.args.at(-2)).toBe('2 quotas to use now');
  });

  it('a dry run reports what is due and sends and records nothing', async () => {
    const h = harness(stateWith([['Claude Max', weekly(14, 62)]], true), { env: { [NOTIFY_URL_VARIABLE]: SECRET_URL } });
    const outcome = await h.runner.check({ dryRun: true });
    expect(outcome.message?.title).toBe('Use Claude Max now');
    expect(outcome.deliveries).toEqual([]);
    expect(h.commands).toEqual([]);
    expect(h.posts).toEqual([]);
    expect((await h.runner.check({ dryRun: true })).due).toHaveLength(1);
  });

  it('posts to the webhook when one is configured, with or without the desktop setting', async () => {
    const h = harness(stateWith([['Claude Max', weekly(14, 62)]]), { env: { [NOTIFY_URL_VARIABLE]: SECRET_URL } });
    const outcome = await h.runner.check();
    expect(outcome.deliveries).toEqual([{ channel: 'webhook', ok: true }]);
    expect(h.commands).toEqual([]);
    expect(h.posts).toEqual([
      {
        url: SECRET_URL,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', Title: 'Use Claude Max now' },
        body: '38% left of the weekly limit, resets in 14h (tomorrow 00:00).'
      }
    ]);
  });

  it('an explicit run can use the desktop without the setting, or leave it out with the setting on', async () => {
    const h = harness(stateWith([['Claude Max', weekly(14, 62)]]));
    expect((await h.runner.check({ desktop: true })).deliveries).toEqual([{ channel: 'desktop', ok: true }]);

    const headless = harness(stateWith([['Claude Max', weekly(14, 62)]], true), { env: { [NOTIFY_URL_VARIABLE]: SECRET_URL } });
    expect((await headless.runner.check({ desktop: false })).deliveries).toEqual([{ channel: 'webhook', ok: true }]);
    expect(headless.commands).toEqual([]);
    expect(await headless.runner.test(false)).toEqual([{ channel: 'webhook', ok: true }]);
  });

  it('counts a reminder as raised when any channel took it, and tries again when none did', async () => {
    const env = { [NOTIFY_URL_VARIABLE]: SECRET_URL };
    const half = harness(stateWith([['Claude Max', weekly(14, 62)]], true), { env, runFails: true });
    expect((await half.runner.check()).deliveries).toEqual([
      { channel: 'desktop', ok: false, error: 'notify-send is not installed.' },
      { channel: 'webhook', ok: true }
    ]);
    expect((await half.runner.check()).due).toEqual([]);

    const none = harness(stateWith([['Claude Max', weekly(14, 62)]], true), { env, runFails: true, fetchStatus: 500 });
    const outcome = await none.runner.check();
    expect(outcome.deliveries.map((delivery) => delivery.ok)).toEqual([false, false]);
    expect((await none.runner.check()).due).toHaveLength(1);
  });

  it('never repeats the webhook address in an error', async () => {
    const env = { [NOTIFY_URL_VARIABLE]: SECRET_URL };
    for (const options of [{ fetchStatus: 403 }, { fetchThrows: true }]) {
      const h = harness(stateWith([['Claude Max', weekly(14, 62)]]), { env, ...options });
      const [delivery] = (await h.runner.check()).deliveries;
      expect(delivery?.ok).toBe(false);
      expect(delivery?.error).toContain('ntfy.example');
      expect(delivery?.error).not.toContain('secret-topic');
    }
    const status = await harness(emptyState(), { env }).runner.status();
    expect(JSON.stringify(status)).not.toContain('secret-topic');
    expect(status.webhook).toEqual({ configured: true, host: 'ntfy.example', error: null });
  });

  it('reports a webhook address it cannot use instead of posting to it', async () => {
    const h = harness(stateWith([['Claude Max', weekly(14, 62)]]), { env: { [NOTIFY_URL_VARIABLE]: 'http://ntfy.example/topic' } });
    const outcome = await h.runner.check();
    expect(outcome.deliveries[0]).toMatchObject({ channel: 'webhook', ok: false });
    expect(h.posts).toEqual([]);
    expect((await h.runner.status()).webhook).toMatchObject({ configured: false, host: null });
  });

  it('says what is switched on and what this system can do', async () => {
    expect(await harness(emptyState()).runner.status()).toEqual({
      desktop: { enabled: false, supported: true },
      webhook: { configured: false, host: null, error: null }
    });
    expect((await harness(stateWith([], true), { platform: 'aix' }).runner.status()).desktop).toEqual({ enabled: true, supported: false });
  });

  it('sends a test message through the channels that are on', async () => {
    const h = harness(emptyState(), { env: { [NOTIFY_URL_VARIABLE]: SECRET_URL } });
    expect(await h.runner.test()).toEqual([
      { channel: 'desktop', ok: true },
      { channel: 'webhook', ok: true }
    ]);
    expect(h.commands[0]?.args.slice(-2)).toEqual([TEST_MESSAGE.title, TEST_MESSAGE.body]);
    expect(await harness(emptyState(), { platform: 'aix' }).runner.test()).toEqual([
      { channel: 'desktop', ok: false, error: 'This system has no standard notification command.' }
    ]);
  });

  it('remembers what it raised across restarts, in a file that holds nothing but keys', async () => {
    const state = stateWith([['Claude Max', weekly(14, 62)]], true);
    const first = harness(state, { home });
    await first.runner.check();
    const stored = JSON.parse(await readFile(join(home, 'reminders.json'), 'utf8')) as { sent: string[] };
    expect(stored).toEqual({ sent: [`claude-max:weekly-limit@${NOW + 14 * HOUR}`] });

    const second = harness(state, { home });
    expect((await second.runner.check()).due).toEqual([]);
    expect(second.commands).toEqual([]);

    // A damaged record costs one repeated reminder, not a crash.
    await writeFile(join(home, 'reminders.json'), '{not json');
    const third = harness(state, { home });
    expect((await third.runner.check()).deliveries).toEqual([{ channel: 'desktop', ok: true }]);
  });
});
