import { open, readFile, unlink, mkdir, type FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';

export class SingletonLock {
  private handle?: FileHandle;

  constructor(private readonly lockPath: string) {}

  async acquire(): Promise<void> {
    await mkdir(dirname(this.lockPath), { recursive: true });
    try {
      this.handle = await open(this.lockPath, 'wx');
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      const owner = await this.readOwner();
      if (owner && processExists(owner.pid)) {
        throw new Error(`Browser Gateway is already running with PID ${owner.pid}`, { cause: error });
      }
      await unlink(this.lockPath).catch(() => undefined);
      this.handle = await open(this.lockPath, 'wx');
    }
    await this.handle.writeFile(
      JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }),
      'utf8'
    );
    await this.handle.sync();
  }

  async release(): Promise<void> {
    await this.handle?.close().catch(() => undefined);
    this.handle = undefined;
    const owner = await this.readOwner();
    if (owner?.pid === process.pid) await unlink(this.lockPath).catch(() => undefined);
  }

  private async readOwner(): Promise<{ pid: number } | undefined> {
    try {
      const value = JSON.parse(await readFile(this.lockPath, 'utf8')) as { pid?: unknown };
      return typeof value.pid === 'number' ? { pid: value.pid } : undefined;
    } catch {
      return undefined;
    }
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'EEXIST';
}
