import { beforeEach, describe, expect, it } from 'vitest';

import { BrowserGateway } from '../src/gateway.js';
import { MemoryAuditLog } from '../src/core/audit-log.js';
import { MockBrowserDriver, mockTab } from './helpers/mock-browser-driver.js';
import { testConfig } from './helpers/config.js';

describe('screenshot options', () => {
  let gateway: BrowserGateway;

  beforeEach(async () => {
    gateway = new BrowserGateway(testConfig(), new MockBrowserDriver([mockTab('p1')]), new MemoryAuditLog());
    await gateway.start();
  });

  it('should capture a full-page screenshot when no clip or locator is given', async () => {
    const shot = await gateway.screenshot('p1', { format: 'png' });
    expect(shot.mimeType).toBe('image/png');
    expect(shot.data.length).toBeGreaterThan(0);
    expect(shot.clip).toBeUndefined();
  });

  it('should return the clip when an explicit region is requested', async () => {
    const clip = { x: 5, y: 5, width: 200, height: 120 };
    const shot = await gateway.screenshot('p1', { format: 'png', clip });
    expect(shot.clip).toEqual(clip);
  });

  it('should resolve a clip from an element locator', async () => {
    const shot = await gateway.screenshot('p1', { format: 'png', locator: { selector: '#hero' } });
    expect(shot.clip).toEqual({ x: 10, y: 20, width: 100, height: 50 });
  });

  it('should honour jpeg format', async () => {
    const shot = await gateway.screenshot('p1', { format: 'jpeg', quality: 80 });
    expect(shot.mimeType).toBe('image/jpeg');
  });
});
