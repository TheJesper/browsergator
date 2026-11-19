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

function looksLikeState(value: unknown): value is State {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v['version'] === STATE_VERSION &&
    Array.isArray(v['accounts']) &&
    Array.isArray(v['spend']) &&
    Array.isArray(v['cycles']) &&
    typeof v['settings'] === 'object' &&
    v['settings'] !== null
  );
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
      // A lock older than ten seconds was left behind by a process that died mid-write.
      const age = await stat(this.lockDir).then(
        (info) => Date.now() - info.mtimeMs,
        () => 0
      );
      if (age > 10_000) {
        await rm(this.lockDir, { recursive: true, force: true }).catch(() => undefined);
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
    try {
      const parsed: unknown = JSON.parse(raw);
      if (looksLikeState(parsed)) return parsed;
    } catch {
      // fall through to the corrupt-file path
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
