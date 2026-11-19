import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  COMMANDS,
  add,
  calendar,
  collectors,
  connect,
  doctor,
  exportState,
  importState,
  notify,
  run,
  serve,
  set,
  skill,
  status,
  statusline,
  type Io
} from '../src/cli/commands.js';
import { readAll } from '../src/cli/io.js';
import type { Snapshot } from '../src/core/brief.js';
import { CATALOG } from '../src/core/catalog.js';
import { DAY, HOUR, iso } from '../src/core/time.js';
import type { State } from '../src/core/types.js';
import { cliCommand, createApp, packageRoot, resolvePublicDir, type App } from '../src/server/app.js';
import { COLLECTORS } from '../src/server/collectors/index.js';
import { ConfigError, VERSION } from '../src/server/config.js';
import { TokengatorService } from '../src/server/service.js';
import { BLOCK_BEGIN } from '../src/server/skill-install.js';
import { FileStateStore } from '../src/server/store.js';

const TOKEN = 'tg-secret-token-0123456789-do-not-print';
const ESC = String.fromCharCode(27);

let root: string;
let home: string;
const apps: App[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tokengator-cli-'));
  home = join(root, 'home');
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await rm(root, { recursive: true, force: true });
});

interface TestIo extends Io {
  out(): string;
  err(): string;
}

/** An Io that collects what a command writes. Nothing of the real environment leaks into it. */
function makeIo(env: NodeJS.ProcessEnv = {}, stdin: string | Io['stdin'] = ''): TestIo {
  let out = '';
  let err = '';
  return {
    stdout: { write: (chunk: string) => ((out += chunk), true) },
    stderr: { write: (chunk: string) => ((err += chunk), true) },
    stdin: typeof stdin === 'string' ? Readable.from(stdin === '' ? [] : [stdin]) : stdin,
    // CODEX_HOME keeps the local-file collector away from the real home directory.
    env: { TOKENGATOR_HOME: home, CODEX_HOME: join(root, 'no-codex'), ...env },
    cwd: root,
    out: () => out,
    err: () => err
  };
}

async function withService<T>(work: (service: TokengatorService) => Promise<T>, dir: string = home): Promise<T> {
  const store = new FileStateStore(dir, { pollMs: 0 });
  try {
    return await work(new TokengatorService(store));
  } finally {
    store.close();
  }
}

const readState = (dir: string = home): Promise<State> => withService((service) => service.state(), dir);

/**
 * Two subscriptions, relative to the real clock because the commands use it: a weekly limit that resets
 * in 14 hours with 38% left (use now), and a monthly allowance that is far behind pace.
 */
async function seed(dir: string = home): Promise<void> {
  const now = Date.now();
  await withService(async (service) => {
    await service.addAccount({
      label: 'Claude Max',
      providerId: 'claude',
      price: { amount: 100, currency: 'USD', period: 'month' },
      meters: [
        { key: 'session', label: '5-hour session', role: 'throttle', reset: { kind: 'rolling', hours: 5 } },
        { key: 'weekly', label: 'Weekly limit', reset: { kind: 'interval', hours: 168 }, resetsAt: iso(now + 14 * HOUR) }
      ]
    });
    await service.report({ account: 'claude', meter: 'weekly' }, { usedPercent: 62 });
    await service.addAccount({
      label: 'Copilot Pro',
      providerId: 'copilot',
      price: { amount: 10, currency: 'USD', period: 'month' },
      meters: [{ key: 'credits', label: 'Monthly credits', unit: 'credits', limit: 1500, reset: { kind: 'interval', hours: 720 }, resetsAt: iso(now + 12 * DAY) }]
    });
    await service.report({ account: 'copilot' }, { used: 180 });
  }, dir);
}

describe('status (spec: Command line)', () => {
  it('lists allowance meters in "use first" order with share left, time to reset and value at risk, and exits 0', async () => {
    await seed();
    const io = makeIo();
    expect(await status([], io)).toBe(0);
    const out = io.out();
    const claude = out.split('\n').find((line) => line.includes('Claude Max · Weekly limit')) ?? '';
    const copilot = out.split('\n').find((line) => line.includes('Copilot Pro · Monthly credits')) ?? '';
    expect(out.indexOf('Claude Max · Weekly limit')).toBeGreaterThan(-1);
    expect(out.indexOf('Claude Max · Weekly limit')).toBeLessThan(out.indexOf('Copilot Pro · Monthly credits'));
    expect(claude).toMatch(/^\s+Use now\s/);
    expect(claude).toMatch(/\s38%\s+1[34]h( \d+m)?\s+\$\d+\.\d\d$/);
    expect(copilot).toMatch(/^\s+Behind pace\s/);
    expect(copilot).toMatch(/\s88%\s+1[12]d( \d+h)?\s+\$\d+\.\d\d$/);
    expect(out.trimEnd().split('\n').pop()).toMatch(/^1 quota needs using now, \$\d+\.\d\d at risk\.$/);
    // Rate limits are context, not quota that can be wasted: they stay out unless asked for.
    expect(out).not.toContain('5-hour session');
    expect(out).not.toContain(ESC);
    expect(io.err()).toBe('');
  });

  it('prints the same information as one JSON document with --json', async () => {
    await seed();
    const io = makeIo();
    expect(await status(['--json'], io)).toBe(0);
    const document = JSON.parse(io.out()) as Snapshot;
    const expected = await withService((service) => service.snapshot());
    expect(Object.keys(document)).toEqual(Object.keys(expected));
    expect(document.queue.map((meter) => meter.id)).toEqual(['claude-max:weekly', 'copilot-pro:credits']);
    expect(document.queue.map((meter) => meter.id)).toEqual(expected.queue.map((meter) => meter.id));
    expect(document.throttles.map((meter) => meter.id)).toEqual(['claude-max:session']);
    expect(document.summary).toMatchObject({ useNow: 1, behind: 1 });
    expect(document.queue[0]).toMatchObject({ account: 'Claude Max', meter: 'Weekly limit', state: 'Use now', tier: 'use-now', remainingPercent: 38, currency: 'USD' });
    expect(Object.keys(document.queue[0] ?? {})).toEqual(Object.keys(expected.queue[0] ?? {}));
    expect(document.queue[0]?.valueAtRisk).toBeGreaterThan(0);
    expect(typeof document.queue[0]?.resetsInMinutes).toBe('number');
    expect(document.timeZone).toBe(expected.timeZone);

    // The table says the same thing about the same meters, in the same order.
    const text = makeIo();
    await status([], text);
    const positions = document.queue.map((meter) => text.out().indexOf(`${meter.account} · ${meter.meter}`));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(text.out()).toContain(document.summary.line);
  });

  it('exits 2 with --check when something needs using now, and 0 when nothing does', async () => {
    await seed();
    expect(await status(['--check'], makeIo())).toBe(2);
    const json = makeIo();
    expect(await status(['--check', '--json'], json)).toBe(2);
    expect((JSON.parse(json.out()) as Snapshot).summary.useNow).toBe(1);

    await withService((service) => service.report({ account: 'claude', meter: 'weekly' }, { usedPercent: 99 }));
    expect(await status(['--check'], makeIo())).toBe(0);
  });

  it('shows rate limits and quiet states with --all', async () => {
    await seed();
    await withService((service) => service.report({ account: 'claude', meter: 'weekly' }, { usedPercent: 99 }));
    const quiet = makeIo();
    await status([], quiet);
    expect(quiet.out()).not.toContain('Claude Max');
    expect(quiet.out()).toContain('2 more are not shown (used up, rate limits)');

    const io = makeIo();
    expect(await status(['--all'], io)).toBe(0);
    expect(io.out()).toContain('Used up (1)');
    expect(io.out()).toContain('Rate limits (1)');
    expect(io.out()).toMatch(/Idle\s+Claude Max · 5-hour session/);
  });

  it('says how to add an account when nothing is tracked, without creating anything', async () => {
    const io = makeIo();
    expect(await status([], io)).toBe(0);
    expect(io.out()).toContain('No subscriptions are tracked yet.');
    expect(io.out()).toContain('tokengator add <provider>');
    expect(existsSync(home)).toBe(false);

    const json = makeIo();
    expect(await status(['--json'], json)).toBe(0);
    expect(JSON.parse(json.out())).toMatchObject({ queue: [], throttles: [] });
  });

  it('colours only a terminal, and not when NO_COLOR is set or --no-color is given', async () => {
    await seed();
    const terminal = (env: NodeJS.ProcessEnv = {}): TestIo => {
      const io = makeIo(env);
      Object.assign(io.stdout, { isTTY: true, columns: 140, getColorDepth: () => 24 });
      return io;
    };
    const coloured = terminal();
    await status([], coloured);
    expect(coloured.out()).toContain(`${ESC}[38;2;222;138;90mUse now`);

    const noColorEnv = terminal({ NO_COLOR: '1' });
    await status([], noColorEnv);
    expect(noColorEnv.out()).not.toContain(ESC);

    const noColorFlag = terminal();
    await status(['--no-color'], noColorFlag);
    expect(noColorFlag.out()).not.toContain(ESC);
    expect(noColorFlag.out()).toBe(noColorEnv.out());
  });

  it('rejects options and arguments it does not know', async () => {
    const io = makeIo();
    expect(await run(['status', '--verbose'], io)).toBe(1);
    expect(io.err()).toContain('Unknown option --verbose.');
    expect(io.err()).toContain('tokengator help status');
    expect(await run(['status', 'extra'], makeIo())).toBe(1);
  });

  it('reports a state file it could not read and where it was kept', async () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'state.json'), '{ not json');
    const io = makeIo();
    expect(await status([], io)).toBe(0);
    expect(io.err()).toContain('could not be read and was kept as');
    expect(readdirSync(home).some((name) => name.startsWith('state.corrupt-'))).toBe(true);
  });
});

describe('dispatch and help', () => {
  it('prints usage and exits non-zero for an unknown command (spec: Unknown command)', async () => {
    const io = makeIo();
    expect(await run(['frobnicate'], io)).toBe(1);
    expect(io.err()).toContain('Unknown command "frobnicate".');
    expect(io.err()).toContain('Usage: tokengator <command> [options]');
    expect(io.out()).toBe('');
    // A name that only exists on Object.prototype is not a command either.
    expect(await run(['constructor'], makeIo())).toBe(1);
  });

  it('lists every command with a one-line description', async () => {
    for (const argv of [['help'], ['--help'], ['-h']]) {
      const io = makeIo();
      expect(await run(argv, io)).toBe(0);
      for (const name of Object.keys(COMMANDS)) expect(io.out()).toMatch(new RegExp(`^  ${name}\\b.* {3}\\S`, 'm'));
      expect(io.out()).toContain('help [command]');
      expect(io.err()).toBe('');
    }
  });

  it('explains one command, by name or with --help after it', async () => {
    for (const name of Object.keys(COMMANDS)) {
      const byName = makeIo();
      expect(await run(['help', name], byName)).toBe(0);
      expect(byName.out()).toContain(`tokengator ${name}`);
      const byFlag = makeIo();
      expect(await run([name, '--help'], byFlag)).toBe(0);
      expect(byFlag.out()).toBe(byName.out());
    }
    for (const name of ['frobnicate', 'constructor']) {
      const unknown = makeIo();
      expect(await run(['help', name], unknown)).toBe(1);
      expect(unknown.err()).toContain(`Unknown command "${name}".`);
    }
  });

  it('prints the version', async () => {
    for (const argv of [['--version'], ['-v'], ['version']]) {
      const io = makeIo();
      expect(await run(argv, io)).toBe(0);
      expect(io.out()).toBe(`${VERSION}\n`);
    }
  });

  it('runs a command through the dispatcher', async () => {
    await seed();
    const io = makeIo();
    expect(await run(['status', '--check'], io)).toBe(2);
    expect(io.out()).toContain('Claude Max · Weekly limit');
  });
});

describe('set', () => {
  it('records a quick-entry line and prints how it was understood and the new headline', async () => {
    await seed();
    const io = makeIo();
    expect(await set(['claude', 'weekly', '70%', 'resets', 'in', '10h'], io)).toBe(0);
    const lines = io.out().trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('Claude Max');
    expect(lines[0]).toContain('70% used, 30% left');
    expect(lines[0]).toContain('in 10h');
    expect(lines[1]).toMatch(/^Use now: 30% left, resets in (10h|9h 59m)$/);
    expect(io.err()).toBe('');

    const weekly = (await readState()).accounts[0]?.meters.find((meter) => meter.key === 'weekly');
    expect(weekly?.used).toBe(70);
    expect(weekly?.source.kind).toBe('manual');
    expect(Date.parse(weekly?.resetsAt ?? '') - Date.now()).toBeGreaterThan(9.9 * HOUR);
    expect(Date.parse(weekly?.resetsAt ?? '') - Date.now()).toBeLessThanOrEqual(10 * HOUR);
  });

  it('accepts the line as one quoted argument too, and counted units', async () => {
    await seed();
    const io = makeIo();
    expect(await run(['set', 'copilot 1200 left'], io)).toBe(0);
    expect(io.out()).toContain('300 credits used, 1,200 credits left');
    expect((await readState()).accounts[1]?.meters[0]?.used).toBe(300);
  });

  it('prints the candidates and exits 1 when the name is ambiguous, changing nothing', async () => {
    await seed();
    const before = await readState();
    const io = makeIo();
    expect(await run(['set', 'c', '5%'], io)).toBe(1);
    expect(io.err()).toContain('matches more than one meter');
    expect(io.err()).toContain('Claude Max, Weekly limit  (claude-max:weekly)');
    expect(io.err()).toContain('Copilot Pro, Monthly credits  (copilot-pro:credits)');
    expect(io.out()).toBe('');
    expect(await readState()).toEqual(before);
  });

  it('prints the known accounts and exits 1 when the name matches nothing', async () => {
    await seed();
    const io = makeIo();
    expect(await run(['set', 'zzz', '5%'], io)).toBe(1);
    expect(io.err()).toContain('No account matches "zzz".');
    expect(io.err()).toContain('Claude Max  (claude-max)');
    expect(io.err()).toContain('Copilot Pro  (copilot-pro)');
  });

  it('exits 1 for a line without an amount, an impossible amount, or no line at all', async () => {
    await seed();
    const noAmount = makeIo();
    expect(await run(['set', 'claude'], noAmount)).toBe(1);
    expect(noAmount.err()).toContain('Add an amount');

    const tooMuch = makeIo();
    expect(await run(['set', 'claude', 'weekly', '140%'], tooMuch)).toBe(1);
    // A validation error is printed as "field: message".
    expect(tooMuch.err()).toMatch(/^\w+: .*\b100\b.*\n$/);

    const empty = makeIo();
    expect(await run(['set'], empty)).toBe(1);
    expect(empty.err()).toContain('Give an account and an amount');
    expect((await readState()).accounts[0]?.meters.find((meter) => meter.key === 'weekly')?.used).toBe(62);
  });
});

describe('add', () => {
  it('lists the catalog with --list and when no provider is given', async () => {
    for (const args of [['--list'], []]) {
      const io = makeIo();
      expect(await add(args, io)).toBe(0);
      if (CATALOG.length === 0) expect(io.out()).toContain('The catalog has no providers.');
      for (const provider of CATALOG) {
        expect(io.out()).toMatch(new RegExp(`^  ${provider.id}\\s`, 'm'));
        for (const plan of provider.plans) expect(io.out()).toContain(plan.id);
      }
      expect(existsSync(home)).toBe(false);
    }
  });

  it('says so when the catalog is empty, and still refuses an unknown provider', async () => {
    vi.resetModules();
    vi.doMock('../src/core/catalog.js', () => ({ CATALOG: [], CATALOG_CHECKED: '2026-01-01' }));
    try {
      const fresh = await import('../src/cli/commands.js');
      const listing = makeIo();
      expect(await fresh.run(['add', '--list'], listing)).toBe(0);
      expect(listing.out()).toContain('The catalog has no providers.');
      expect(listing.err()).toBe('');

      const unknown = makeIo();
      expect(await fresh.run(['add', 'claude'], unknown)).toBe(1);
      expect(unknown.err()).toContain('Unknown provider "claude"');
    } finally {
      vi.doUnmock('../src/core/catalog.js');
      vi.resetModules();
    }
  });

  it('names the known providers and exits 1 for one it does not know', async () => {
    const io = makeIo();
    expect(await run(['add', 'no-such-provider'], io)).toBe(1);
    expect(io.err()).toMatch(/^provider: Unknown provider "no-such-provider"\. Known: /);
    for (const provider of CATALOG) expect(io.err()).toContain(provider.id);
    expect(existsSync(join(home, 'state.json'))).toBe(false);
  });

  it.skipIf(CATALOG.length === 0)('adds an account from a preset, with a plan and a label', async () => {
    const provider = CATALOG[0];
    const plan = provider?.plans[provider.plans.length - 1];
    if (!provider || !plan) throw new Error('the catalog entry has no plan');
    const io = makeIo();
    expect(await add([provider.id, '--plan', plan.id, '--label=Work account'], io)).toBe(0);
    expect(io.out()).toContain('Added Work account (id work-account)');
    expect(io.out()).toContain('tokengator set work-account');

    const state = await readState();
    expect(state.accounts).toHaveLength(1);
    expect(state.accounts[0]).toMatchObject({ id: 'work-account', providerId: provider.id, label: 'Work account', plan: plan.name });
    expect(state.accounts[0]?.meters.map((meter) => meter.key)).toEqual(plan.meters.map((meter) => meter.key));

    const badPlan = makeIo();
    expect(await run(['add', provider.id, '--plan', 'no-such-plan'], badPlan)).toBe(1);
    expect(badPlan.err()).toMatch(/^plan: Unknown plan/);
    const badDay = makeIo();
    expect(await run(['add', provider.id, '--billing-day', '40'], badDay)).toBe(1);
    expect(badDay.err()).toContain('--billing-day must be a whole number from 1 to 31');
    expect((await readState()).accounts).toHaveLength(1);
  });
});

describe('statusline', () => {
  it('exits 0 and prints a line for input that is not JSON, without a word on standard error', async () => {
    const io = makeIo({}, 'garbage {{{ not json');
    expect(await statusline([], io)).toBe(0);
    expect(io.out()).toBe('tokengator\n');
    expect(io.err()).toBe('');
  });

  it('records the rate-limit windows Claude Code hands over and prints them', async () => {
    await seed();
    const resetsAt = Math.floor(Date.now() / 1000) + 13 * 3600;
    const input = JSON.stringify({ rate_limits: { five_hour: { used_percentage: 64, resets_at: Math.floor(Date.now() / 1000) + 7000 }, seven_day: { used_percentage: 70, resets_at: resetsAt } } });
    const io = makeIo({}, input);
    expect(await run(['statusline'], io)).toBe(0);
    expect(io.out()).toMatch(/^5h 36% left 1h 5\dm · week 30% left 1[23]h( \d+m)? \(use now, \$\d+\.\d\d at risk\)\n$/);
    expect(io.err()).toBe('');

    const meters = (await readState()).accounts[0]?.meters ?? [];
    expect(meters.find((meter) => meter.key === 'weekly')).toMatchObject({ used: 70, source: { kind: 'statusline', id: 'claude-statusline' } });
    expect(meters.find((meter) => meter.key === 'session')?.used).toBe(64);
  });

  it('keeps a status line the person already had: same input, their line first, ours after it', async () => {
    await seed();
    const theirs = join(root, 'their-statusline.cjs');
    writeFileSync(
      theirs,
      "let text = ''; process.stdin.on('data', (chunk) => (text += chunk)); process.stdin.on('end', () => { const input = JSON.parse(text); console.log('[' + input.model.id + ']'); console.log('second line'); });"
    );
    const input = JSON.stringify({ model: { id: 'some-model' }, rate_limits: { seven_day: { used_percentage: 70, resets_at: Math.floor(Date.now() / 1000) + 13 * 3600 } } });
    const io = makeIo({}, input);
    expect(await run(['statusline', '--', process.execPath, theirs], io)).toBe(0);
    const lines = io.out().split('\n');
    expect(lines[0]).toMatch(/^\[some-model\] · week 30% left .*use now/);
    expect(lines[1]).toBe('second line');
    expect(io.err()).toBe('');
    // The reading was recorded all the same.
    expect((await readState()).accounts[0]?.meters.find((meter) => meter.key === 'weekly')?.used).toBe(70);
  });

  it('prints its own line when the wrapped command fails, is missing or says nothing', async () => {
    await seed();
    const failing = join(root, 'failing.cjs');
    writeFileSync(failing, "console.log('half a line'); process.exit(3);");
    const silent = join(root, 'silent.cjs');
    writeFileSync(silent, '');
    for (const command of [[process.execPath, failing], [join(root, 'no-such-program')], [process.execPath, silent], []]) {
      const io = makeIo({}, JSON.stringify({ model: { id: 'm' } }));
      expect(await statusline(['--', ...command], io)).toBe(0);
      expect(io.out()).toMatch(/^week 38% left .*use now.*\n$/);
      expect(io.out().split('\n')).toHaveLength(2);
      expect(io.err()).toBe('');
    }
  });

  it('prints what is stored when the input carries no rate limits', async () => {
    await seed();
    const io = makeIo({}, JSON.stringify({ model: { id: 'some-model' } }));
    expect(await statusline([], io)).toBe(0);
    expect(io.out()).toMatch(/^week 38% left .*use now/);
  });

  it('still exits 0 with a line when the home directory cannot be used', async () => {
    writeFileSync(join(root, 'a-file'), 'not a directory');
    const io = makeIo({ TOKENGATOR_HOME: join(root, 'a-file') }, JSON.stringify({ rate_limits: { seven_day: { used_percentage: 10 } } }));
    expect(await run(['statusline'], io)).toBe(0);
    expect(io.out()).toBe('tokengator\n');
    expect(io.err()).toBe('');
  });

  it('does not hang on a state file that another process holds locked', async () => {
    await seed();
    mkdirSync(join(home, 'state.lock'));
    const input = JSON.stringify({ rate_limits: { seven_day: { used_percentage: 90, resets_at: Math.floor(Date.now() / 1000) + 13 * 3600 } } });
    const started = Date.now();
    const io = makeIo({}, input);
    expect(await statusline([], io)).toBe(0);
    expect(Date.now() - started).toBeLessThan(3000);
    // The reading could not be saved, so the line shows what is stored. It is still a line.
    expect(io.out()).toMatch(/^week 38% left /);
    expect(io.err()).toBe('');
  });

  it('does not wait forever for input that never ends, and does not read a terminal at all', async () => {
    const open = new PassThrough();
    open.write('{"rate_limits":');
    const started = Date.now();
    const io = makeIo({}, open);
    expect(await statusline([], io)).toBe(0);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(io.out()).toBe('tokengator\n');
    open.destroy();

    const terminal = Object.assign(new PassThrough(), { isTTY: true });
    expect(await readAll(terminal, { maxBytes: 10 })).toEqual({ text: '', complete: true });
    terminal.destroy();
  });

  it('gives up on input that is too large rather than parse part of it', async () => {
    expect(await readAll(Readable.from(['abc', 'def']), { maxBytes: 100 })).toEqual({ text: 'abcdef', complete: true });
    expect((await readAll(Readable.from(['abc', 'def']), { maxBytes: 4 })).complete).toBe(false);
  });
});

describe('notify and calendar (spec: reminders)', () => {
  /** A stand-in for an ntfy server on this computer, which is the one place plain HTTP is accepted. */
  async function receiver(status = 200): Promise<{ url: string; posts: { title: string | undefined; body: string }[]; close: () => Promise<void> }> {
    const posts: { title: string | undefined; body: string }[] = [];
    const server: Server = createServer((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => (body += chunk));
      req.on('end', () => {
        posts.push({ title: req.headers['title'] as string | undefined, body });
        res.writeHead(status).end('ok');
      });
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const { port } = server.address() as AddressInfo;
    return { url: `http://127.0.0.1:${port}/secret-topic-9f3a7c`, posts, close: () => new Promise((done) => server.close(() => done())) };
  }

  it('prints what is due on a dry run and sends and records nothing', async () => {
    await seed();
    const target = await receiver();
    try {
      const io = makeIo({ TOKENGATOR_NOTIFY_URL: target.url });
      expect(await notify(['--dry-run'], io)).toBe(0);
      const lines = io.out().trimEnd().split('\n');
      expect(lines[0]).toBe('Use Claude Max now');
      expect(lines[1]).toMatch(/^38% left of the weekly limit, resets in (14h|13h 59m) \(.+\)\. About \$\d+\.\d\d expires at this pace\.$/);
      expect(lines[2]).toBe('(dry run: nothing was sent or recorded)');
      expect(target.posts).toEqual([]);
      expect(existsSync(join(home, 'reminders.json'))).toBe(false);
      // Still due afterwards.
      const again = makeIo({ TOKENGATOR_NOTIFY_URL: target.url });
      expect(await notify(['--dry-run'], again)).toBe(0);
      expect(again.out()).toContain('Use Claude Max now');
    } finally {
      await target.close();
    }
  });

  it('delivers a due reminder once: a second run has nothing to say', async () => {
    await seed();
    const target = await receiver();
    try {
      const io = makeIo({ TOKENGATOR_NOTIFY_URL: target.url });
      expect(await notify(['--no-desktop'], io)).toBe(0);
      expect(io.out()).toContain('Your address: sent');
      expect(target.posts).toHaveLength(1);
      expect(target.posts[0]?.title).toBe('Use Claude Max now');
      expect(target.posts[0]?.body).toContain('38% left of the weekly limit');
      // The address is a secret: nothing printed repeats it.
      expect(io.out() + io.err()).not.toContain('secret-topic');
      expect(JSON.parse(readFileSync(join(home, 'reminders.json'), 'utf8'))).toMatchObject({ sent: [expect.stringMatching(/^claude-max:weekly@\d+$/)] });

      const second = makeIo({ TOKENGATOR_NOTIFY_URL: target.url });
      expect(await notify(['--no-desktop'], second)).toBe(0);
      expect(second.out()).toBe('Nothing is due.\n');
      expect(target.posts).toHaveLength(1);
    } finally {
      await target.close();
    }
  });

  it('exits 1 and keeps the reminder when nothing could take it', async () => {
    await seed();
    const target = await receiver(500);
    try {
      const io = makeIo({ TOKENGATOR_NOTIFY_URL: target.url });
      expect(await notify(['--no-desktop'], io)).toBe(1);
      expect(io.err()).toContain('Your address: not sent. 127.0.0.1 answered 500.');
      expect(io.err()).not.toContain('secret-topic');
      expect(existsSync(join(home, 'reminders.json'))).toBe(false);
    } finally {
      await target.close();
    }
    const nowhere = makeIo();
    expect(await notify(['--no-desktop'], nowhere)).toBe(1);
    expect(nowhere.err()).toContain('No route is set up');
  });

  it('sends a test message on request and says so per route', async () => {
    const target = await receiver();
    try {
      const io = makeIo({ TOKENGATOR_NOTIFY_URL: target.url });
      expect(await notify(['--test', '--no-desktop'], io)).toBe(0);
      expect(io.out()).toBe('Your address: sent\n');
      expect(target.posts).toEqual([{ title: 'Tokengator reminders work', body: 'This is where you will hear that quota is about to expire unused.' }]);
    } finally {
      await target.close();
    }
  });

  it('says so when nothing is due, and refuses stray arguments', async () => {
    const io = makeIo();
    expect(await notify(['--dry-run'], io)).toBe(0);
    expect(io.out()).toBe('Nothing is due.\n');
    const stray = makeIo();
    expect(await run(['notify', 'now'], stray)).not.toBe(0);
  });

  it('prints the coming resets as an iCalendar document', async () => {
    await seed();
    const io = makeIo();
    expect(await calendar(['--days', '10'], io)).toBe(0);
    const text = io.out();
    expect(text.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(text.endsWith('END:VCALENDAR\r\n')).toBe(true);
    const unfolded = text.replace(/\r\n /g, '');
    // The weekly limit now and next week; the monthly credits are twelve days away and out of range.
    expect(unfolded.match(/BEGIN:VEVENT/g)).toHaveLength(2);
    expect(unfolded).toContain('SUMMARY:Use up Claude Max: weekly limit resets');
    expect(unfolded).toContain('What is left right now: http://127.0.0.1:4777/');
    expect(unfolded).not.toContain('Copilot');
    expect(io.err()).toBe('');

    const wide = makeIo({ TOKENGATOR_PORT: '5000' });
    expect(await calendar([], wide)).toBe(0);
    expect(wide.out().replace(/\r\n /g, '')).toContain('SUMMARY:Use up Copilot Pro: monthly credits resets');
    expect(wide.out().replace(/\r\n /g, '')).toContain('http://127.0.0.1:5000/');

    const bad = makeIo();
    expect(await run(['calendar', '--days', '0'], bad)).not.toBe(0);
  });
});

describe('connect', () => {
  it('prints the HTTP address and the stdio command for this machine', async () => {
    const io = makeIo();
    expect(await connect([], io)).toBe(0);
    expect(io.out()).toContain('http://127.0.0.1:4777/mcp');
    expect(io.out()).toContain('MCP over HTTP');
    expect(io.out()).toContain('MCP over stdio');
    expect(io.out()).toContain(`${cliCommand()} skill install`);
    expect(io.out()).not.toContain('TOKENGATOR_TOKEN');
    expect(existsSync(home)).toBe(false);
  });

  it('follows the configured host and port, from the environment or from the environment file', async () => {
    const fromEnv = makeIo({ TOKENGATOR_HOST: 'localhost', TOKENGATOR_PORT: '5123' });
    await connect([], fromEnv);
    expect(fromEnv.out()).toContain('http://localhost:5123/mcp');

    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, '.env'), 'TOKENGATOR_PORT=6001\n');
    const fromFile = makeIo();
    await connect([], fromFile);
    expect(fromFile.out()).toContain('http://127.0.0.1:6001/mcp');
    const realWins = makeIo({ TOKENGATOR_PORT: '6002' });
    await connect([], realWins);
    expect(realWins.out()).toContain('http://127.0.0.1:6002/mcp');
  });

  it('names the token variable and never prints its value', async () => {
    const io = makeIo({ TOKENGATOR_TOKEN: TOKEN });
    expect(await connect([], io)).toBe(0);
    expect(io.out()).toContain('${TOKENGATOR_TOKEN}');
    expect(io.out() + io.err()).not.toContain(TOKEN);
  });

  it('prints one snippet as bare code with --client, and only stdio variants with --stdio', async () => {
    const one = makeIo();
    expect(await connect(['--client', 'codex'], one)).toBe(0);
    expect(one.out()).toBe('codex mcp add tokengator --url http://127.0.0.1:4777/mcp\n');

    const stdio = makeIo();
    expect(await connect(['--stdio'], stdio)).toBe(0);
    expect(stdio.out()).toContain('MCP over stdio');
    expect(stdio.out()).not.toContain('MCP over HTTP');
    expect(stdio.out()).not.toContain('http://');

    const both = makeIo();
    expect(await connect(['--stdio', '--client=claude'], both)).toBe(0);
    expect(both.out()).toMatch(/^claude mcp add --scope user tokengator -- .* mcp\n$/);

    // A prefix that matches several ids lists them the usual way instead of guessing one.
    const several = makeIo();
    expect(await connect(['--client', 'cli'], several)).toBe(0);
    expect(several.out().split('\n')[0]).toBe('Command line');
    expect(several.out()).toContain('(cli-status)');
    expect(several.out()).toContain('(cli-set)');

    const unknown = makeIo();
    expect(await connect(['--client', 'nope'], unknown)).toBe(1);
    expect(unknown.err()).toContain('No snippet matches "nope". Known: claude-code');
  });

  it('exits 1 with the reason when the configuration is not usable', async () => {
    const io = makeIo({ TOKENGATOR_HOST: '0.0.0.0' });
    expect(await run(['connect'], io)).toBe(1);
    expect(io.err()).toContain('without an access token');
  });
});

describe('export and import', () => {
  it('round-trips the whole state through a file', async () => {
    await seed();
    const exported = makeIo();
    expect(await exportState([], exported)).toBe(0);
    const document = JSON.parse(exported.out()) as State;
    expect(document).toEqual(await readState());
    expect(document.accounts.map((account) => account.id)).toEqual(['claude-max', 'copilot-pro']);

    writeFileSync(join(root, 'backup.json'), exported.out());
    const second = join(root, 'second-home');
    const imported = makeIo({ TOKENGATOR_HOME: second });
    // The path is relative on purpose: it is resolved against the working directory of the command.
    expect(await importState(['backup.json'], imported)).toBe(0);
    expect(imported.out()).toBe('Imported 2 accounts, 0 spend sources and 0 finished windows.\n');

    const again = makeIo({ TOKENGATOR_HOME: second });
    expect(await run(['export'], again)).toBe(0);
    const copy = JSON.parse(again.out()) as State;
    expect(copy.accounts).toEqual(document.accounts);
    expect(copy.spend).toEqual(document.spend);
    expect(copy.cycles).toEqual(document.cycles);
    expect(copy.version).toBe(document.version);
    // Importing may fill in settings that the document left out, but never changes one it has.
    expect(copy.settings).toMatchObject(document.settings);

    // What came out of an import goes back in unchanged.
    writeFileSync(join(root, 'copy.json'), again.out());
    const third = join(root, 'third-home');
    expect(await importState([join(root, 'copy.json')], makeIo({ TOKENGATOR_HOME: third }))).toBe(0);
    expect(await readState(third)).toEqual(copy);
  });

  it('reads the document from standard input with -', async () => {
    await seed();
    const exported = makeIo();
    await exportState([], exported);
    const other = join(root, 'piped-home');
    const io = makeIo({ TOKENGATOR_HOME: other }, exported.out());
    expect(await run(['import', '-'], io)).toBe(0);
    expect((await readState(other)).accounts).toHaveLength(2);
  });

  it('prints the field and exits 1 for a document that is not valid, changing nothing', async () => {
    await seed();
    const before = await readState();
    writeFileSync(join(root, 'bad.json'), JSON.stringify({ version: 1, accounts: [{ label: 'x', meters: [] }] }));
    const io = makeIo();
    expect(await run(['import', 'bad.json'], io)).toBe(1);
    expect(io.err()).toBe('accounts[0].meters: An account needs at least one meter.\n');
    expect(await readState()).toEqual(before);

    writeFileSync(join(root, 'old.json'), JSON.stringify({ version: 99, accounts: [] }));
    const version = makeIo();
    expect(await run(['import', 'old.json'], version)).toBe(1);
    expect(version.err()).toMatch(/^version: Unsupported state version 99/);
    expect(await readState()).toEqual(before);
  });

  it('exits 1 for a file that is missing or is not JSON, and for no file at all', async () => {
    const missing = makeIo();
    expect(await run(['import', 'nowhere.json'], missing)).toBe(1);
    expect(missing.err()).toContain('Cannot read');
    expect(missing.err()).toContain('ENOENT');

    writeFileSync(join(root, 'text.json'), 'this is not json');
    const text = makeIo();
    expect(await run(['import', 'text.json'], text)).toBe(1);
    expect(text.err()).toContain('text.json is not valid JSON');

    const none = makeIo();
    expect(await run(['import'], none)).toBe(1);
    expect(none.err()).toContain('Name one file');
    expect(existsSync(join(home, 'state.json'))).toBe(false);
  });
});

describe('doctor', () => {
  it('reports version, paths and configuration, and never prints the token', async () => {
    await seed();
    writeFileSync(join(home, '.env'), 'ELEVENLABS_API_KEY=el-secret-value-9876543210\n');
    const io = makeIo({ TOKENGATOR_TOKEN: TOKEN, TOKENGATOR_PORT: '5999' });
    expect(await doctor([], io)).toBe(0);
    const out = io.out();
    expect(out).toContain(`Tokengator ${VERSION}`);
    expect(out).toMatch(new RegExp(`Home\\s+${home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n`));
    expect(out).toContain(`${join(home, 'state.json')} (exists, 2 accounts)`);
    expect(out).toContain(`${join(home, '.env')} (present, 1 variable)`);
    expect(out).toContain('127.0.0.1 port 5999 (http://127.0.0.1:5999)');
    expect(out).toMatch(/Access token\s+yes\n/);
    expect(out).toContain(resolvePublicDir());
    expect(out).toMatch(/Dashboard\s+.*\((built|not built: run "npm run build")\)/);
    expect(out).toContain(cliCommand());
    for (const collector of COLLECTORS) expect(out).toMatch(new RegExp(`^  ${collector.id}\\s+${collector.sourceKind}\\s+off\\s+\\S`, 'm'));

    const everything = out + io.err();
    expect(everything).not.toContain(TOKEN);
    expect(everything).not.toContain('el-secret-value-9876543210');
  });

  it('says no when there is no token, and that the state file does not exist yet', async () => {
    const io = makeIo();
    expect(await run(['doctor'], io)).toBe(0);
    expect(io.out()).toMatch(/Access token\s+no\n/);
    expect(io.out()).toContain('state.json (not created yet)');
    expect(io.out()).toContain('.env (not present)');
    expect(io.out()).toContain('127.0.0.1 port 4777');
    expect(existsSync(home)).toBe(false);
  });

  it('reports a configuration that cannot be used, exits 1, and still keeps the token to itself', async () => {
    const short = 'short-token';
    const io = makeIo({ TOKENGATOR_TOKEN: short });
    expect(await doctor([], io)).toBe(1);
    expect(io.out()).toContain('Configuration problem: TOKENGATOR_TOKEN must be at least 16 characters.');
    expect(io.out() + io.err()).not.toContain(short);
  });

  it('describes a damaged state file without moving or changing it', async () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'state.json'), '{ not json');
    const io = makeIo();
    expect(await doctor([], io)).toBe(0);
    expect(io.out()).toContain('exists, but is not valid JSON');
    expect(readdirSync(home)).toEqual(['state.json']);
    expect(readFileSync(join(home, 'state.json'), 'utf8')).toBe('{ not json');
  });
});

describe('collectors', () => {
  it('lists every collector with its source kind, switch and availability', async () => {
    for (const args of [[], ['list']]) {
      const io = makeIo();
      expect(await collectors(args, io)).toBe(0);
      expect(io.out()).toMatch(/^Id\s+Source\s+Enabled\s+Available\s+Last run$/m);
      for (const collector of COLLECTORS) expect(io.out()).toMatch(new RegExp(`^${collector.id}\\s+${collector.sourceKind}\\s+off\\s+.*\\s-$`, 'm'));
    }
  });

  it('has nothing to run when none is switched on', async () => {
    const io = makeIo();
    expect(await collectors(['run'], io)).toBe(0);
    expect(io.out()).toContain('No collectors are switched on.');
  });

  it('exits 1 for a collector or an action it does not know', async () => {
    const unknown = makeIo();
    expect(await run(['collectors', 'enable', 'no-such-collector'], unknown)).toBe(1);
    expect(unknown.err()).toContain('Unknown collector "no-such-collector".');
    expect(await run(['collectors', 'run', 'no-such-collector'], makeIo())).toBe(1);
    const action = makeIo();
    expect(await run(['collectors', 'explode'], action)).toBe(1);
    expect(action.err()).toContain('Unknown collectors action "explode".');
    expect(await run(['collectors', 'enable'], makeIo())).toBe(1);
  });

  // A collector that reads local files only: switching it on never opens a network connection.
  const local = COLLECTORS.find((collector) => collector.sourceKind === 'local-file' && collector.allowedHosts.length === 0);

  it.skipIf(!local)('switches a collector on, runs it, and switches it off again', async () => {
    const id = local?.id ?? '';
    const on = makeIo();
    expect(await collectors(['enable', id], on)).toBe(0);
    expect(on.out()).toMatch(new RegExp(`^${id}\\s+local-file\\s+on\\s`, 'm'));
    expect((await readState()).settings.enabledCollectors).toEqual([id]);

    const ran = makeIo();
    expect(await collectors(['run'], ran)).toBe(0);
    expect(ran.out()).toMatch(new RegExp(`^${id}\\s+local-file\\s+on\\s.*unavailable`, 'm'));

    const off = makeIo();
    expect(await collectors(['disable', id], off)).toBe(0);
    expect((await readState()).settings.enabledCollectors).toEqual([]);

    const notRun = makeIo();
    expect(await collectors(['run', id], notRun)).toBe(1);
    expect(notRun.err()).toContain('switched off, so not run');
  });
});

describe('skill (spec: Installation)', () => {
  const agentHome = (): string => join(root, 'agent-home');
  const io = (): TestIo => makeIo({ TOKENGATOR_AGENT_HOME: agentHome() });
  const userText = '# My rules\n\nBe kind.\n';

  beforeEach(() => {
    mkdirSync(join(agentHome(), '.claude'), { recursive: true });
    mkdirSync(join(agentHome(), '.codex'), { recursive: true });
    writeFileSync(join(agentHome(), '.codex', 'AGENTS.md'), userText);
  });

  it('installs, reports that everything is up to date the second time, and uninstalls cleanly', async () => {
    const first = io();
    expect(await skill(['install'], first)).toBe(0);
    expect(first.out()).toMatch(/^claude\s+installed\s/m);
    expect(first.out()).toMatch(/^codex\s+updated\s/m);
    expect(first.out()).toContain('Not set up on this machine, so left alone: agents, antigravity, kiro, gemini, copilot, cursor, windsurf, opencode.');
    const skillFile = join(agentHome(), '.claude', 'skills', 'tokengator', 'SKILL.md');
    expect(readFileSync(skillFile, 'utf8')).toBe(readFileSync(join(packageRoot(), 'skill', 'SKILL.md'), 'utf8'));
    const instructions = readFileSync(join(agentHome(), '.codex', 'AGENTS.md'), 'utf8');
    expect(instructions.startsWith(`${userText}\n${BLOCK_BEGIN}\n`)).toBe(true);

    const second = io();
    expect(await run(['skill', 'install'], second)).toBe(0);
    expect(second.out()).toContain('Everything is up to date.');
    expect(second.out()).not.toMatch(/\b(installed|updated)\b/);
    expect(readFileSync(join(agentHome(), '.codex', 'AGENTS.md'), 'utf8')).toBe(instructions);

    const removed = io();
    expect(await skill(['uninstall'], removed)).toBe(0);
    expect(removed.out()).toMatch(/^claude\s+removed\s/m);
    expect(removed.out()).toContain('Only what Tokengator installed was touched.');
    expect(readFileSync(join(agentHome(), '.codex', 'AGENTS.md'), 'utf8')).toBe(userText);
    expect(existsSync(join(agentHome(), '.claude', 'skills', 'tokengator'))).toBe(false);

    const nothing = io();
    expect(await skill(['uninstall'], nothing)).toBe(0);
    expect(nothing.out()).toBe('Nothing to remove.\n');
  });

  it('writes nothing with --dry-run', async () => {
    const dry = io();
    expect(await skill(['install', '--dry-run'], dry)).toBe(0);
    expect(dry.out()).toMatch(/^claude\s+would install\s/m);
    expect(dry.out()).toContain('Dry run: nothing was written.');
    expect(existsSync(join(agentHome(), '.claude', 'skills'))).toBe(false);
    expect(readFileSync(join(agentHome(), '.codex', 'AGENTS.md'), 'utf8')).toBe(userText);

    await skill(['install'], io());
    const dryRemove = io();
    expect(await skill(['uninstall', '--dry-run'], dryRemove)).toBe(0);
    expect(dryRemove.out()).toContain('Dry run: nothing was removed.');
    expect(existsSync(join(agentHome(), '.claude', 'skills', 'tokengator', 'SKILL.md'))).toBe(true);
  });

  it('limits the run with --only and installs for missing clients with --all', async () => {
    const only = io();
    expect(await skill(['install', '--only=codex'], only)).toBe(0);
    expect(only.out()).not.toContain('claude');
    expect(existsSync(join(agentHome(), '.claude', 'skills'))).toBe(false);

    const all = io();
    expect(await skill(['install', '--all'], all)).toBe(0);
    expect(existsSync(join(agentHome(), '.kiro', 'skills', 'tokengator', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(agentHome(), '.config', 'opencode', 'AGENTS.md'))).toBe(true);
    expect(all.out()).not.toContain('left alone');
  });

  it('exits 1 when no agent client is set up, for an unknown client, and without an action', async () => {
    const empty = makeIo({ TOKENGATOR_AGENT_HOME: join(root, 'empty-agent-home') });
    expect(await skill(['install'], empty)).toBe(1);
    expect(empty.err()).toContain('No agent clients were found');
    expect(existsSync(join(root, 'empty-agent-home'))).toBe(false);

    const unknown = io();
    expect(await run(['skill', 'install', '--only=bogus'], unknown)).toBe(1);
    expect(unknown.err()).toContain('Unknown client "bogus". Known: claude, agents, antigravity, kiro, codex');
    const bare = io();
    expect(await run(['skill'], bare)).toBe(1);
    expect(bare.err()).toContain('skill install');
  });
});

describe('serve', () => {
  /** Starts the service on a free port and hands back its address and a way to stop it. */
  async function start(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ io: TestIo; url: string; stop: () => Promise<number> }> {
    const io = makeIo(env);
    const controller = new AbortController();
    let exit: Promise<number> = Promise.resolve(-1);
    const url = await new Promise<string>((resolve, reject) => {
      exit = serve(['--port', '0', ...args], io, { signal: controller.signal, onListening: (address) => resolve(address.url) });
      exit.then((code) => reject(new Error(`serve ended early with ${code}: ${io.err()}`)), reject);
    });
    return {
      io,
      url,
      stop: () => {
        controller.abort();
        return exit;
      }
    };
  }

  it('listens on loopback, prints the address to open on standard error and stops cleanly', async () => {
    const listenersBefore = process.listenerCount('SIGINT');
    const running = await start(['--no-collectors']);
    expect(running.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(running.io.err().split('\n')[0]).toBe(`Tokengator ${VERSION} is running at ${running.url} (Ctrl+C to stop).`);
    expect(running.io.out()).toBe('');
    expect(process.listenerCount('SIGINT')).toBe(listenersBefore + 1);

    const health = await fetch(`${running.url}/healthz`);
    expect(await health.json()).toEqual({ status: 'ok', service: 'tokengator', version: VERSION });
    const state = (await (await fetch(`${running.url}/api/state`)).json()) as { demo: boolean; cli: string; state: State };
    expect(state.demo).toBe(false);
    expect(state.cli).toBe(cliCommand());
    expect(state.state.accounts).toEqual([]);

    expect(await running.stop()).toBe(0);
    expect(process.listenerCount('SIGINT')).toBe(listenersBefore);
    await expect(fetch(`${running.url}/healthz`)).rejects.toThrow();
  });

  it('serves the same state the other commands write, and the MCP endpoint', async () => {
    await seed();
    const running = await start(['--no-collectors']);
    try {
      const snapshot = (await (await fetch(`${running.url}/api/snapshot`)).json()) as Snapshot;
      expect(snapshot.queue.map((meter) => meter.id)).toEqual(['claude-max:weekly', 'copilot-pro:credits']);
      const mcp = await fetch(`${running.url}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cli-test', version: '0' } } })
      });
      expect(mcp.status).toBe(200);
      expect(JSON.stringify(await mcp.json())).toContain('"serverInfo"');
    } finally {
      expect(await running.stop()).toBe(0);
    }
  });

  it('says how to open the dashboard with a token without printing the token', async () => {
    const running = await start(['--no-collectors'], { TOKENGATOR_TOKEN: TOKEN });
    try {
      expect(running.io.err()).toContain(`open ${running.url}/#token=<value of TOKENGATOR_TOKEN>`);
      expect(running.io.err() + running.io.out()).not.toContain(TOKEN);
      expect((await fetch(`${running.url}/api/state`)).status).toBe(401);
      expect((await fetch(`${running.url}/api/state`, { headers: { Authorization: `Bearer ${TOKEN}` } })).status).toBe(200);
    } finally {
      await running.stop();
    }
  });

  it('serves sample data from memory with --demo and leaves the home directory alone', async () => {
    const running = await start(['--demo']);
    try {
      expect(running.io.err()).toContain('sample data');
      const state = (await (await fetch(`${running.url}/api/state`)).json()) as { demo: boolean };
      expect(state.demo).toBe(true);
      expect(existsSync(home)).toBe(false);
    } finally {
      await running.stop();
    }
  });

  it('refuses to listen beyond loopback without a token (spec: Exposed without a token)', async () => {
    const io = makeIo();
    expect(await run(['serve', '--host', '0.0.0.0', '--port', '0'], io)).toBe(1);
    expect(io.err()).toContain('Refusing to listen on 0.0.0.0 without an access token');
    expect(io.err()).toContain('TOKENGATOR_TOKEN');
    // The same through the default command, and for a token that is too short.
    expect(await run(['--host=0.0.0.0'], makeIo())).toBe(1);
    expect(await run(['serve', '--port', '0'], makeIo({ TOKENGATOR_TOKEN: 'short' }))).toBe(1);
  });

  it('exits 1 with advice when the port is taken, and for a port that is not a number', async () => {
    const running = await start(['--no-collectors']);
    try {
      const port = new URL(running.url).port;
      const io = makeIo();
      expect(await run(['serve', '--port', port, '--no-collectors'], io)).toBe(1);
      expect(io.err()).toContain(`127.0.0.1 port ${port} is already in use.`);
    } finally {
      await running.stop();
    }
    const bad = makeIo();
    expect(await run(['serve', '--port', 'http'], bad)).toBe(1);
    expect(bad.err()).toContain('--port must be a whole number from 0 to 65535');
  });
});

describe('composition root', () => {
  const open = async (options: Parameters<typeof createApp>[0]): Promise<App> => {
    const app = await createApp(options);
    apps.push(app);
    return app;
  };

  it('builds the service on the state file in the Tokengator home', async () => {
    await seed();
    const app = await open({ env: { TOKENGATOR_HOME: home }, port: 0 });
    expect(app.config).toMatchObject({ host: '127.0.0.1', port: 0, token: null, home, demo: false });
    expect(app.service.store.location).toBe(join(home, 'state.json'));
    expect((await app.service.state()).accounts).toHaveLength(2);
    expect((await app.collectors.list()).map((collector) => collector.id)).toEqual(COLLECTORS.map((collector) => collector.id));
    await app.close();
    await app.close();
  });

  it('defaults to 127.0.0.1 port 4777 with no configuration (spec: Default start)', async () => {
    const app = await open({ env: { TOKENGATOR_HOME: home } });
    expect(app.config).toMatchObject({ host: '127.0.0.1', port: 4777, token: null, demo: false });
  });

  it('serves sample data from memory in demo mode', async () => {
    const app = await open({ env: { TOKENGATOR_HOME: home }, port: 0, demo: true });
    expect(app.config.demo).toBe(true);
    expect(app.service.store.location).toBe('memory');
    expect(existsSync(home)).toBe(false);
  });

  it('starts empty on a state file it cannot parse, keeps the file aside and reports where (spec: Corrupt document)', async () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'state.json'), '{"version":1,"accounts":[');
    const app = await open({ env: { TOKENGATOR_HOME: home }, port: 0 });
    const aside = readdirSync(home).find((name) => name.startsWith('state.corrupt-'));
    expect(aside).toBeDefined();
    expect(readFileSync(join(home, aside ?? ''), 'utf8')).toBe('{"version":1,"accounts":[');
    expect(app.service.store.warnings).toHaveLength(1);
    expect(app.service.store.warnings[0]).toContain(aside);
    expect((await app.service.state()).accounts).toEqual([]);
  });

  it('reads configuration from the environment file, and lets the real environment and options win', async () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, '.env'), `TOKENGATOR_PORT=6001\nTOKENGATOR_TOKEN=${TOKEN}\n`);
    expect((await open({ env: { TOKENGATOR_HOME: home } })).config).toMatchObject({ port: 6001, token: TOKEN });
    expect((await open({ env: { TOKENGATOR_HOME: home, TOKENGATOR_PORT: '6002' } })).config.port).toBe(6002);
    expect((await open({ env: { TOKENGATOR_HOME: home, TOKENGATOR_PORT: '6002' }, port: 0, host: 'localhost' })).config).toMatchObject({ port: 0, host: 'localhost' });
  });

  it('refuses a non-loopback address without a token', async () => {
    await expect(createApp({ env: { TOKENGATOR_HOME: home }, host: '0.0.0.0' })).rejects.toThrow(ConfigError);
    const app = await open({ env: { TOKENGATOR_HOME: home, TOKENGATOR_TOKEN: TOKEN }, host: '0.0.0.0', port: 0 });
    expect(app.config.host).toBe('0.0.0.0');
  });

  it('finds the package root and the built dashboard directory from wherever it runs', () => {
    const pkg = JSON.parse(readFileSync(join(packageRoot(), 'package.json'), 'utf8')) as { name: string };
    expect(pkg.name).toBe('tokengator');
    expect(resolvePublicDir()).toBe(join(packageRoot(), 'dist', 'public'));
  });

  it('names the CLI by its shim when started through one, and by the built entry point otherwise', () => {
    const entry = `node "${join(packageRoot(), 'dist', 'cli', 'main.js')}"`;
    expect(cliCommand('/usr/local/bin/tokengator')).toBe('tokengator');
    expect(cliCommand('/home/me/project/node_modules/.bin/tokengator')).toBe('tokengator');
    expect(cliCommand('C:\\Users\\me\\AppData\\Roaming\\npm\\tokengator.cmd')).toBe('tokengator');
    expect(cliCommand(join(packageRoot(), 'dist', 'cli', 'main.js'))).toBe(entry);
    expect(cliCommand('/somewhere/else/vitest.mjs')).toBe(entry);
    expect(cliCommand('/opt/not-tokengator')).toBe(entry);
    expect(cliCommand(undefined)).toMatch(/^(tokengator|node ".*main\.js")$/);
  });
});

describe('the real process', () => {
  const main = join(packageRoot(), 'src', 'cli', 'main.ts');

  /** The real environment, which a child needs to start at all, without anyone's Tokengator settings. */
  function childEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const [name, value] of Object.entries(process.env)) {
      if (!name.startsWith('TOKENGATOR_')) env[name] = value;
    }
    return { ...env, TOKENGATOR_HOME: home, TOKENGATOR_LOG: 'error', CODEX_HOME: join(root, 'no-codex'), ...extra };
  }

  /** Runs the entry point the way the bin shim does, from TypeScript source. */
  function spawnCli(args: string[], input: string | null, env: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', main, ...args], {
        cwd: packageRoot(),
        env: childEnv(env),
        stdio: ['pipe', 'pipe', 'pipe']
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr }));
      if (input !== null) child.stdin.end(input);
    });
  }

  it('sets the exit code and writes the queue to standard output', async () => {
    await seed();
    const result = await spawnCli(['status', '--check'], '');
    expect(result.code).toBe(2);
    expect(result.stdout).toContain('Claude Max · Weekly limit');
    expect(result.stdout).not.toContain(ESC);
    expect(result.stderr).toBe('');

    const unknown = await spawnCli(['frobnicate'], '');
    expect(unknown.code).toBe(1);
    expect(unknown.stdout).toBe('');
    expect(unknown.stderr).toContain('Usage: tokengator <command> [options]');
  });

  it('keeps standard output of the stdio MCP server to protocol messages, and ends when the client goes away', async () => {
    await seed();
    const messages = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cli-test', version: '0' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'what_to_use', arguments: {} } }
    ];
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', main, 'mcp'], {
        cwd: packageRoot(),
        env: childEnv(),
        stdio: ['pipe', 'pipe', 'pipe']
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
        // Hang up once the second answer has arrived, the way a client that is done would.
        if (stdout.includes('"id":2')) child.stdin.end();
      });
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr }));
      child.stdin.write(`${messages.map((message) => JSON.stringify(message)).join('\n')}\n`);
    });

    expect(result.code).toBe(0);
    const lines = result.stdout.split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    const answers = lines.map((line) => JSON.parse(line) as { jsonrpc: string; id: number; result?: unknown });
    expect(answers.map((answer) => [answer.jsonrpc, answer.id])).toEqual([
      ['2.0', 1],
      ['2.0', 2]
    ]);
    expect(JSON.stringify(answers[0]?.result)).toContain('"serverInfo"');
    expect(JSON.stringify(answers[1]?.result)).toContain('Claude Max');
    expect(result.stderr).toBe('');
  });

  it('always exits 0 as a status line command', async () => {
    const result = await spawnCli(['statusline'], 'not json at all');
    expect(result).toEqual({ code: 0, stdout: 'tokengator\n', stderr: '' });
  });
});
