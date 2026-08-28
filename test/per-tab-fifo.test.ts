import { describe, expect, it } from 'vitest';

import { PerTabFifo } from '../src/core/per-tab-fifo.js';

describe('PerTabFifo', () => {
  it('serializes one page in enqueue order while allowing another page in parallel', async () => {
    const fifo = new PerTabFifo();
    const events: string[] = [];
    let globalActive = 0;
    let maxGlobal = 0;

    const work = (pageId: string, name: string, ms: number) =>
      fifo.enqueue(pageId, async () => {
        events.push(`${name}:start`);
        globalActive += 1;
        maxGlobal = Math.max(maxGlobal, globalActive);
        await new Promise((resolve) => setTimeout(resolve, ms));
        globalActive -= 1;
        events.push(`${name}:end`);
      });

    await Promise.all([work('p1', 'a', 30), work('p1', 'b', 1), work('p2', 'c', 10)]);
    expect(events.indexOf('b:start')).toBeGreaterThan(events.indexOf('a:end'));
    expect(maxGlobal).toBe(2);
    expect(fifo.depth('p1')).toBe(0);
  });
});
