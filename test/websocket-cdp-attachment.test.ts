import { describe, expect, it } from 'vitest';

import { WebSocketCdpDriver } from '../src/cdp/websocket-cdp-driver.js';

describe('CDP attachment readiness (no browser connection)', () => {
  it.each([false, true])('waits for outstanding domain enablement even after session assignment (reject=%s)', async (reject) => {
    const driver = new WebSocketCdpDriver('http://127.0.0.1:1') as unknown as {
      sessionByPage: Map<string, string>;
      attaching: Map<string, Promise<void>>;
      ensureAttached(target: { targetId: string }): Promise<void>;
    };
    let finish!: () => void;
    let fail!: (error: Error) => void;
    const pending = new Promise<void>((resolve, rejectPromise) => { finish = resolve; fail = rejectPromise; });
    driver.sessionByPage.set('owned', 'session');
    driver.attaching.set('owned', pending);
    const observed = driver.ensureAttached({ targetId: 'owned' });
    expect(observed).toBe(pending);
    if (reject) {
      const check = expect(observed).rejects.toThrow('Network.enable failed');
      fail(new Error('Network.enable failed'));
      await check;
    } else {
      finish();
      await observed;
    }
  });
});
