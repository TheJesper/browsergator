import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';

import { SingletonLock } from '../src/core/singleton-lock.js';

describe('SingletonLock', () => {
  it('rejects a second live owner and can be reacquired after release', async () => {
    const path = resolve(process.cwd(), '.tmp', 'test-data', `singleton-${process.pid}.lock`);
    const first = new SingletonLock(path);
    const second = new SingletonLock(path);
    await first.acquire();
    try {
      await expect(second.acquire()).rejects.toThrow(/already running/);
    } finally {
      await first.release();
    }
    await second.acquire();
    await second.release();
  });
});
