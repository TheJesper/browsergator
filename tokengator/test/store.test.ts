import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { addAccount } from '../src/core/accounts.js';
import { applyReadingToState } from '../src/core/reset.js';
import { emptyState, type State } from '../src/core/types.js';
import { FileStateStore, LockTimeoutError, MemoryStateStore, UnstorableStateError, type StateStore } from '../src/server/store.js';

const NOW = Date.UTC(2026, 10, 19, 10, 0, 0);

let home: string;
const opened: StateStore[] = [];

function open(dir = home, options: { lockTimeoutMs?: number; pollMs?: number } = {}): FileStateStore {
  // Polling is off unless a test asks for it, so no timer outlives its test.
  const store = new FileStateStore(dir, { pollMs: 0, ...options });
  opened.push(store);
  return store;
}

/** A change that adds one account with the given name. */
const adding = (label: string) => (state: State): { state: State; result: string } => {
  const added = addAccount(state, { label, meters: [{ label: 'Weekly', reset: { kind: 'interval', hours: 168 } }] }, NOW);
  return { state: added.state, result: added.account.id };
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the condition.');
    await sleep(10);
  }
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'tokengator-store-'));
});

afterEach(async () => {
  for (const store of opened.splice(0)) store.close();
  await rm(home, { recursive: true, force: true });
});

describe('FileStateStore', () => {
  it('reads a missing file as an empty state without creating anything', async () => {
    const store = open();
    expect(store.location).toBe(join(home, 'state.json'));
    expect(await store.read()).toEqual(emptyState());
    expect(store.warnings).toEqual([]);
    expect(await readdir(home)).toEqual([]);
  });

  it('persists an update so that another instance reads it', async () => {
    const store = open();
    const id = await store.update(adding('Claude Max'));
    expect(id).toBe('claude-max');

    const fresh = open();
    const state = await fresh.read();
    expect(state.accounts.map((account) => account.label)).toEqual(['Claude Max']);
    expect(state).toEqual(await store.read());

    // One readable JSON document, and nothing left lying around: no lock, no temporary file.
    const raw = await readFile(join(home, 'state.json'), 'utf8');
    expect(JSON.parse(raw)).toEqual(state);
    expect(raw.endsWith('\n')).toBe(true);
    expect(await readdir(home)).toEqual(['state.json']);
  });

  it('creates its directory on the first write', async () => {
    const nested = join(home, 'does', 'not', 'exist');
    const store = open(nested);
    expect(await store.read()).toEqual(emptyState());
    await store.update(adding('Claude Max'));
    expect((await open(nested).read()).accounts).toHaveLength(1);
  });

  it.skipIf(process.platform === 'win32')('keeps the state file private to the user', async () => {
    await open().update(adding('Claude Max'));
    const info = await stat(join(home, 'state.json'));
    expect(info.mode & 0o777).toBe(0o600);
  });

  it('writes nothing when a change returns the state it was given', async () => {
    const store = open();
    let events = 0;
    store.onChange(() => (events += 1));
    const result = await store.update((state) => ({ state, result: 'unchanged' }));
    expect(result).toBe('unchanged');
    expect(events).toBe(0);
    expect(await readdir(home)).toEqual([]);

    await store.update(adding('Claude Max'));
    const before = await readFile(join(home, 'state.json'), 'utf8');
    await store.update((state) => ({ state, result: null }));
    expect(await readFile(join(home, 'state.json'), 'utf8')).toBe(before);
    expect(events).toBe(1);
  });

  it('hands each change the latest state, including what other instances wrote', async () => {
    const a = open();
    const b = open();
    await a.update(adding('From A'));
    const seenByB = await b.update((state) => ({ state, result: state.accounts.map((account) => account.label) }));
    expect(seenByB).toEqual(['From A']);
    await b.update(adding('From B'));
    const seenByA = await a.update((state) => ({ state, result: state.accounts.map((account) => account.label) }));
    expect(seenByA).toEqual(['From A', 'From B']);
  });

  it('loses nothing when two instances on one directory interleave 25 updates each', async () => {
    const a = open(home, { lockTimeoutMs: 20_000 });
    const b = open(home, { lockTimeoutMs: 20_000 });
    const pending: Promise<string>[] = [];
    for (let n = 0; n < 25; n += 1) {
      pending.push(a.update(adding(`A ${n}`)));
      pending.push(b.update(adding(`B ${n}`)));
    }
    const ids = await Promise.all(pending);
    expect(new Set(ids).size).toBe(50);

    const expected = Array.from({ length: 25 }, (_, n) => [`A ${n}`, `B ${n}`]).flat().sort();
    for (const store of [a, b, open()]) {
      const state = await store.read();
      expect(state.accounts.map((account) => account.label).sort()).toEqual(expected);
    }
    // Each instance's own updates were applied in the order they were made.
    const labels = (await a.read()).accounts.map((account) => account.label);
    for (const prefix of ['A', 'B']) {
      const order = labels.filter((label) => label.startsWith(prefix)).map((label) => Number(label.slice(2)));
      expect(order).toEqual(Array.from({ length: 25 }, (_, n) => n));
    }
    expect(await readdir(home)).toEqual(['state.json']);
  }, 30_000);

  it('keeps both updates when two processes change different meters at the same moment', async () => {
    // Scenario: Two writers. One instance stands in for the service, the other for a CLI command.
    const seed = addAccount(
      emptyState(),
      {
        label: 'Claude Max',
        meters: [
          { label: 'Weekly', reset: { kind: 'interval', hours: 168 } },
          { label: 'Session', role: 'throttle', reset: { kind: 'rolling', hours: 5 } }
        ]
      },
      NOW
    ).state;
    const service = open();
    const cli = open();
    await service.update(() => ({ state: seed, result: null }));

    const reading = (meterId: string, usedPercent: number) => (state: State): { state: State; result: null } => ({
      state: applyReadingToState(state, 'claude-max', meterId, { usedPercent }, NOW),
      result: null
    });
    for (let round = 1; round <= 5; round += 1) {
      await Promise.all([service.update(reading('claude-max:weekly', 10 * round)), cli.update(reading('claude-max:session', 7 * round))]);
      const meters = (await open().read()).accounts[0]?.meters ?? [];
      expect(meters.map((meter) => meter.used)).toEqual([10 * round, 7 * round]);
    }
  });

  it('serialises concurrent updates made through one instance', async () => {
    const store = open();
    const counting = (state: State): { state: State; result: number } => {
      const next = { ...state, settings: { ...state.settings, enabledCollectors: [...state.settings.enabledCollectors, `c${state.settings.enabledCollectors.length}`] } };
      return { state: next, result: next.settings.enabledCollectors.length };
    };
    const results = await Promise.all(Array.from({ length: 20 }, () => store.update(counting)));
    expect(results).toEqual(Array.from({ length: 20 }, (_, n) => n + 1));
    expect((await store.read()).settings.enabledCollectors).toHaveLength(20);
  });

  it('rejects when a change throws, saves nothing and lets the next update through', async () => {
    const store = open();
    await store.update(adding('Claude Max'));
    const before = await readFile(join(home, 'state.json'), 'utf8');

    await expect(
      store.update(() => {
        throw new Error('validation failed');
      })
    ).rejects.toThrow('validation failed');
    expect(await readFile(join(home, 'state.json'), 'utf8')).toBe(before);
    expect(await readdir(home)).toEqual(['state.json']); // the lock was released

    await store.update(adding('Second'));
    expect((await store.read()).accounts.map((account) => account.label)).toEqual(['Claude Max', 'Second']);
  });

  describe('a file that cannot be read', () => {
    it.each([
      ['text that is not JSON', '{ "version": 1, "accounts": [ oops'],
      ['an empty file', ''],
      ['JSON that is not a state', '{"hello":"world"}'],
      ['a JSON list', '[]'],
      ['a state without its lists', '{"version":1,"accounts":[]}'],
      ['a state of an older, unknown version', JSON.stringify({ ...emptyState(), version: 0 })],
      [
        'a state with a hand-edited meter that has no reset rule',
        JSON.stringify({
          ...emptyState(),
          accounts: [{ id: 'a', providerId: 'custom', label: 'A', meters: [{ id: 'a:m', key: 'm', label: 'M', limit: 100, used: 1, valueShare: 1, source: { kind: 'manual' }, samples: [] }] }]
        })
      ]
    ])('sets %s aside, reports it and starts empty', async (_name, content) => {
      await writeFile(join(home, 'state.json'), content, 'utf8');
      const store = open();
      expect(await store.read()).toEqual(emptyState());

      const files = (await readdir(home)).sort();
      expect(files).toHaveLength(1);
      const aside = files[0] as string;
      expect(aside).toMatch(/^state\.corrupt-.*\.json$/);
      // Nothing was thrown away: the unreadable bytes are still there.
      expect(await readFile(join(home, aside), 'utf8')).toBe(content);

      expect(store.warnings).toHaveLength(1);
      expect(store.warnings[0]).toContain(join(home, aside));
      expect(store.warnings[0]).toMatch(/could not be read/);
    });

    it('refuses to touch a file written by a newer version', async () => {
      const content = JSON.stringify({ ...emptyState(), version: 99 });
      await writeFile(join(home, 'state.json'), content, 'utf8');
      const store = open();
      await expect(store.read()).rejects.toThrow(/newer Tokengator/);
      await expect(store.update((state) => ({ state: { ...state }, result: null }))).rejects.toThrow(/newer Tokengator/);
      // The file is somebody's good data: still there, byte for byte, and nothing was set aside.
      expect(await readdir(home)).toEqual(['state.json']);
      expect(await readFile(join(home, 'state.json'), 'utf8')).toBe(content);
    });

    it('keeps working afterwards and warns once', async () => {
      await writeFile(join(home, 'state.json'), 'not json at all', 'utf8');
      const store = open();
      await store.update(adding('Claude Max'));
      await store.read();
      await store.read();
      expect(store.warnings).toHaveLength(1);
      expect((await open().read()).accounts.map((account) => account.label)).toEqual(['Claude Max']);

      const files = (await readdir(home)).sort();
      expect(files).toHaveLength(2);
      expect(files[0]).toMatch(/^state\.corrupt-/);
      expect(files[1]).toBe('state.json');
      expect(await readFile(join(home, files[0] as string), 'utf8')).toBe('not json at all');
    });

    it('does not report a healthy file', async () => {
      await open().update(adding('Claude Max'));
      const store = open();
      await store.read();
      expect(store.warnings).toEqual([]);
    });
  });

  describe('change notifications', () => {
    it('fires for its own writes, once each', async () => {
      const store = open(home, { pollMs: 50 });
      await store.read();
      let events = 0;
      store.onChange(() => (events += 1));
      await store.update(adding('Claude Max'));
      expect(events).toBe(1);
      // The poller must not announce the same write a second time.
      await sleep(200);
      expect(events).toBe(1);
      await store.update(adding('Second'));
      expect(events).toBe(2);
    });

    it("fires for another instance's write", async () => {
      const watcher = open(home, { pollMs: 50 });
      const writer = open();
      await watcher.read();
      let events = 0;
      watcher.onChange(() => (events += 1));
      await sleep(120);
      expect(events).toBe(0);

      await writer.update(adding('Claude Max'));
      await waitFor(() => events >= 1);
      expect((await watcher.read()).accounts.map((account) => account.label)).toEqual(['Claude Max']);

      // A file that already existed when the watcher started changes too.
      const seen = events;
      await writer.update(adding('Second'));
      await waitFor(() => events > seen);
    });

    it('tells an instance with the default settings within five seconds', async () => {
      // Scenario: Change made by another process.
      const watcher = new FileStateStore(home);
      opened.push(watcher);
      await watcher.read();
      let events = 0;
      watcher.onChange(() => (events += 1));
      const started = Date.now();
      await open().update(adding('From the CLI'));
      await waitFor(() => events >= 1, 5000);
      expect(Date.now() - started).toBeLessThan(5000);
    }, 10_000);

    it('stops telling a listener that unsubscribed, and everyone after close', async () => {
      const store = open();
      let first = 0;
      let second = 0;
      const unsubscribe = store.onChange(() => (first += 1));
      store.onChange(() => (second += 1));
      await store.update(adding('One'));
      unsubscribe();
      await store.update(adding('Two'));
      expect([first, second]).toEqual([1, 2]);
      store.close();
      store.close(); // closing twice is harmless
      await store.update(adding('Three'));
      expect([first, second]).toEqual([1, 2]);
    });

    it('keeps saving and telling the others when one listener throws', async () => {
      const store = open();
      let reached = 0;
      store.onChange(() => {
        throw new Error('broken listener');
      });
      store.onChange(() => (reached += 1));
      await expect(store.update(adding('Claude Max'))).resolves.toBe('claude-max');
      expect(reached).toBe(1);
      expect((await open().read()).accounts).toHaveLength(1);
    });
  });

  describe('the lock', () => {
    it('breaks a lock left behind by a process that died', async () => {
      await open().update(adding('Before'));
      const lock = join(home, 'state.lock');
      await mkdir(lock);
      const longAgo = new Date(Date.now() - 60_000);
      await utimes(lock, longAgo, longAgo);

      const store = open(home, { lockTimeoutMs: 2000 });
      const started = Date.now();
      await store.update(adding('After'));
      expect(Date.now() - started).toBeLessThan(1500);
      expect((await store.read()).accounts.map((account) => account.label)).toEqual(['Before', 'After']);
      expect(await readdir(home)).toEqual(['state.json']);
    });

    it('gives up with a clear error while another process holds a fresh lock, and changes nothing', async () => {
      await open().update(adding('Before'));
      const before = await readFile(join(home, 'state.json'), 'utf8');
      const lock = join(home, 'state.lock');
      await mkdir(lock);

      const store = open(home, { lockTimeoutMs: 150 });
      const started = Date.now();
      const failure = await store.update(adding('Blocked')).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(LockTimeoutError);
      expect((failure as Error).message).toContain(store.location);
      expect(Date.now() - started).toBeGreaterThanOrEqual(140);
      expect(await readFile(join(home, 'state.json'), 'utf8')).toBe(before);
      // The lock belongs to the other process: a writer that timed out must not remove it.
      expect((await readdir(home)).sort()).toEqual(['state.json', 'state.lock']);

      // Reading never needs the lock.
      expect((await store.read()).accounts.map((account) => account.label)).toEqual(['Before']);

      await rm(lock, { recursive: true });
      await store.update(adding('After'));
      expect((await store.read()).accounts.map((account) => account.label)).toEqual(['Before', 'After']);
    });

    it('waits for a lock that is released in time', async () => {
      const lock = join(home, 'state.lock');
      await mkdir(lock);
      const store = open(home, { lockTimeoutMs: 3000 });
      const pending = store.update(adding('Patient'));
      await sleep(120);
      await rm(lock, { recursive: true });
      await expect(pending).resolves.toBe('patient');
    });
  });
});

describe('MemoryStateStore', () => {
  it('starts empty or from the state it is given', async () => {
    expect(await new MemoryStateStore().read()).toEqual(emptyState());
    const seeded = addAccount(emptyState(), { label: 'Claude Max', meters: [{ label: 'Weekly', reset: { kind: 'none' } }] }, NOW).state;
    expect(await new MemoryStateStore(seeded).read()).toBe(seeded);
  });

  it('applies updates, announces real changes only and survives a throwing change', async () => {
    const store = new MemoryStateStore();
    let events = 0;
    const unsubscribe = store.onChange(() => (events += 1));
    expect(await store.update(adding('Claude Max'))).toBe('claude-max');
    expect(events).toBe(1);
    await store.update((state) => ({ state, result: null }));
    expect(events).toBe(1);

    await expect(
      store.update(() => {
        throw new Error('nope');
      })
    ).rejects.toThrow('nope');
    expect((await store.read()).accounts).toHaveLength(1);
    expect(events).toBe(1);

    unsubscribe();
    await store.update(adding('Second'));
    expect(events).toBe(1);
    expect(store.location).toBe('memory');
    expect(store.warnings).toEqual([]);
    store.close();
  });
});

describe('guards added after review', () => {
  it('refuses to write a document that would not load again, and leaves the file as it was', async () => {
    const store = open();
    await store.update(adding('Claude'));
    const before = await readFile(join(home, 'state.json'), 'utf8');
    const poisoned = store.update((state) => {
      const accounts = state.accounts.map((account) => ({ ...account, meters: account.meters.map((meter) => ({ ...meter, used: Number.POSITIVE_INFINITY })) }));
      return { state: { ...state, accounts }, result: null };
    });
    await expect(poisoned).rejects.toBeInstanceOf(UnstorableStateError);
    expect(await readFile(join(home, 'state.json'), 'utf8')).toBe(before);
    // Nothing was set aside, and the next change goes through as usual.
    expect((await readdir(home)).filter((name) => name.startsWith('state.corrupt'))).toEqual([]);
    await store.update(adding('Suno'));
    expect((await store.read()).accounts.map((account) => account.label)).toEqual(['Claude', 'Suno']);
  });

  it('still announces a change made by another process when something reads the state in between', async () => {
    const watching = open(home, { pollMs: 40 });
    await watching.read();
    let announced = 0;
    watching.onChange(() => (announced += 1));
    await sleep(80);

    const other = open();
    await other.update(adding('Written elsewhere'));
    // A request that reads before the next poll used to swallow the announcement.
    expect((await watching.read()).accounts).toHaveLength(1);
    await waitFor(() => announced > 0);
    expect(announced).toBe(1);
  });

  it('does not announce its own first look at a file that was already there', async () => {
    await open().update(adding('Already here'));
    const watching = open(home, { pollMs: 30 });
    let announced = 0;
    watching.onChange(() => (announced += 1));
    await sleep(150);
    expect(announced).toBe(0);
  });

  it.skipIf(process.platform === 'win32')('creates the home directory for its owner only', async () => {
    const fresh = join(home, 'made-by-the-store');
    await open(fresh).update(adding('Claude'));
    expect((await stat(fresh)).mode & 0o077).toBe(0);
    expect((await stat(join(fresh, 'state.json'))).mode & 0o077).toBe(0);
  });
});
