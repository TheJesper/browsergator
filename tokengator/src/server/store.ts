// Persistence. One JSON document, replaced atomically, with a lock directory so that the service, the CLI
// and a stdio MCP server can all write without losing each other's updates.

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { STATE_VERSION, emptyState, type State } from '../core/types.js';

export interface StateStore {
  /** Where the state lives, for diagnostics. */
  readonly location: string;
  read(): Promise<State>;
  /** Read-modify-write. `change` may return the same object to signal "nothing to save". */
  update<T>(change: (state: State) => { state: State; result: T }): Promise<T>;
  /** Called after every change, including ones made by other processes. Returns an unsubscribe function. */
  onChange(listener: () => void): () => void;
  close(): void;
  /** Problems found while loading (for example a corrupt file that was set aside). */
  readonly warnings: string[];
}

export class LockTimeoutError extends Error {
  constructor(location: string) {
    super(`Could not lock ${location}: another Tokengator process is holding it.`);
    this.name = 'LockTimeoutError';
  }
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === 'string';
const isAmount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isOptionalText = (value: unknown): boolean => value === null || value === undefined || isText(value);

/**
 * Checks the parts of a stored document that the rest of the code dereferences without asking. The service
 * writes this file itself, so this is a guard against a hand edit or a half-copied file, not a validator:
 * anything that fails is set aside as corrupt instead of making every read throw.
 */
function looksLikeState(value: unknown): value is State {
  if (!isObject(value)) return false;
  if (value['version'] !== STATE_VERSION) return false;
  const { accounts, spend, cycles, settings } = value;
  if (!Array.isArray(accounts) || !Array.isArray(spend) || !Array.isArray(cycles) || !isObject(settings)) return false;
  if (!isText(settings['currency']) || !Array.isArray(settings['enabledCollectors'])) return false;
  for (const account of accounts) {
    if (!isObject(account) || !isText(account['id']) || !isText(account['label']) || !isText(account['providerId'])) return false;
    if (!isOptionalText(account['snoozedUntil']) || !Array.isArray(account['meters'])) return false;
    const price = account['price'];
    if (price !== null && price !== undefined && (!isObject(price) || !isAmount(price['amount']) || !isText(price['currency']))) return false;
    for (const meter of account['meters']) {
      if (!isObject(meter) || !isText(meter['id']) || !isText(meter['key']) || !isText(meter['label'])) return false;
      if (!isAmount(meter['limit']) || !isAmount(meter['used']) || !isAmount(meter['valueShare'])) return false;
      if (!isObject(meter['reset']) || !isText(meter['reset']['kind']) || !isObject(meter['source'])) return false;
      if (!isOptionalText(meter['resetsAt']) || !isOptionalText(meter['windowStartedAt']) || !isOptionalText(meter['updatedAt'])) return false;
      if (!Array.isArray(meter['samples']) || meter['samples'].some((sample) => !isObject(sample) || !isText(sample['t']) || !isAmount(sample['used']))) return false;
    }
  }
  for (const source of spend) {
    if (!isObject(source) || !isText(source['id']) || !isText(source['label']) || !isText(source['currency'])) return false;
    if (!Array.isArray(source['entries']) || !isObject(source['source'])) return false;
    if (source['entries'].some((entry) => !isObject(entry) || !isText(entry['date']) || !isAmount(entry['amount']))) return false;
  }
  for (const cycle of cycles) {
    if (!isObject(cycle) || !isText(cycle['meterId']) || !isText(cycle['endedAt']) || !isAmount(cycle['wastedFraction'])) return false;
  }
  return true;
}

/** Raised for a state file written by a newer Tokengator. It is left untouched. */
export class NewerStateError extends Error {
  constructor(location: string, version: unknown) {
    super(`${location} was written by a newer Tokengator (state version ${String(version)}). Upgrade Tokengator, or point TOKENGATOR_HOME at another directory.`);
    this.name = 'NewerStateError';
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface FileStoreOptions {
  /** How long to wait for the lock before giving up. */
  lockTimeoutMs?: number;
  /** How often to look for changes made by other processes. 0 disables polling. */
  pollMs?: number;
}

export class FileStateStore implements StateStore {
  readonly location: string;
  readonly warnings: string[] = [];
  private readonly lockDir: string;
  private readonly listeners = new Set<() => void>();
  private readonly lockTimeoutMs: number;
  private timer: NodeJS.Timeout | undefined;
  private lastSeen = '';
  /** Serialises writers inside this process; the lock directory serialises across processes. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly home: string,
    options: FileStoreOptions = {}
  ) {
    this.location = join(home, 'state.json');
    this.lockDir = join(home, 'state.lock');
    this.lockTimeoutMs = options.lockTimeoutMs ?? 4000;
    const pollMs = options.pollMs ?? 1500;
    if (pollMs > 0) {
      this.timer = setInterval(() => void this.poll(), pollMs);
      this.timer.unref();
    }
  }

  async read(): Promise<State> {
    const state = await this.load();
    this.lastSeen = await this.fingerprint();
    return state;
  }

  update<T>(change: (state: State) => { state: State; result: T }): Promise<T> {
    const run = this.queue.then(() => this.locked(change));
    // Keep the chain alive after a failure so one bad update does not block the next.
    this.queue = run.catch(() => undefined);
    return run;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.listeners.clear();
  }

  private async locked<T>(change: (state: State) => { state: State; result: T }): Promise<T> {
    await mkdir(this.home, { recursive: true });
    await this.acquire();
    try {
      const current = await this.load();
      const { state, result } = change(current);
      if (state !== current) {
        await this.persist(state);
        this.lastSeen = await this.fingerprint();
        this.emit();
      }
      return result;
    } finally {
      await rm(this.lockDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async acquire(): Promise<void> {
    const deadline = Date.now() + this.lockTimeoutMs;
    for (;;) {
      try {
        await mkdir(this.lockDir);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      // A lock older than ten seconds was left behind by a process that died mid-write. Breaking it goes
      // through a rename: only one waiter can win it, and the mtime is re-checked right before, so a lock
      // another waiter has just taken is not the one that gets removed.
      const seen = await stat(this.lockDir).then(
        (info) => info.mtimeMs,
        () => null
      );
      if (seen !== null && Date.now() - seen > 10_000) {
        const tomb = `${this.lockDir}.stale-${process.pid}-${randomBytes(3).toString('hex')}`;
        const again = await stat(this.lockDir).then(
          (info) => info.mtimeMs,
          () => null
        );
        if (again === seen) {
          await rename(this.lockDir, tomb).then(
            () => rm(tomb, { recursive: true, force: true }),
            () => undefined
          );
        }
        continue;
      }
      if (Date.now() >= deadline) throw new LockTimeoutError(this.location);
      await sleep(15 + Math.random() * 35);
    }
  }

  private async load(): Promise<State> {
    let raw: string;
    try {
      raw = await readFile(this.location, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState();
      throw error;
    }
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // fall through to the corrupt-file path
    }
    if (looksLikeState(parsed)) return parsed;
    // A newer version is somebody's good data, not a corrupt file: refuse to touch it.
    if (isObject(parsed) && typeof parsed['version'] === 'number' && parsed['version'] > STATE_VERSION) {
      throw new NewerStateError(this.location, parsed['version']);
    }
    // Never overwrite something we could not read: set it aside and say where it went.
    const aside = join(this.home, `state.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    await rename(this.location, aside).catch(() => undefined);
    const warning = `The state file could not be read and was kept as ${aside}. Starting empty.`;
    if (!this.warnings.includes(warning)) this.warnings.push(warning);
    return emptyState();
  }

  private async persist(state: State): Promise<void> {
    const temp = `${this.location}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    // On Windows a rename can fail briefly while another process has the target open.
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(temp, this.location);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (attempt >= 8 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) {
          await rm(temp, { force: true }).catch(() => undefined);
          throw error;
        }
        await sleep(20 * (attempt + 1));
      }
    }
  }

  private async fingerprint(): Promise<string> {
    return stat(this.location).then(
      (info) => `${info.mtimeMs}:${info.size}`,
      () => ''
    );
  }

  private async poll(): Promise<void> {
    if (this.listeners.size === 0) return;
    const seen = await this.fingerprint();
    if (seen === this.lastSeen) return;
    this.lastSeen = seen;
    this.emit();
  }

  private emit(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // a broken listener must not stop the others or the write that triggered it
      }
    }
  }
}

/** Keeps everything in memory. Used for sample-data mode and tests. */
export class MemoryStateStore implements StateStore {
  readonly location = 'memory';
  readonly warnings: string[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(private state: State = emptyState()) {}

  read(): Promise<State> {
    return Promise.resolve(this.state);
  }

  update<T>(change: (state: State) => { state: State; result: T }): Promise<T> {
    try {
      const { state, result } = change(this.state);
      if (state !== this.state) {
        this.state = state;
        for (const listener of [...this.listeners]) listener();
      }
      return Promise.resolve(result);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.listeners.clear();
  }
}
