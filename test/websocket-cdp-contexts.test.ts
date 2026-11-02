import { describe, expect, it, vi } from 'vitest';

import { WebSocketCdpDriver } from '../src/cdp/websocket-cdp-driver.js';
import type { DriverTab, OpenTabOptions } from '../src/types.js';

describe('CDP browser context and window targeting', () => {
  it('creates and disposes a non-default browser context', async () => {
    const driver = new WebSocketCdpDriver('http://127.0.0.1:1') as unknown as {
      assertConnected: () => void;
      send: ReturnType<typeof vi.fn>;
      createBrowserContext: () => Promise<{ browserContextId: string }>;
      disposeBrowserContext: (browserContextId: string) => Promise<void>;
    };
    driver.assertConnected = vi.fn();
    driver.send = vi.fn()
      .mockResolvedValueOnce({ browserContextId: 'ctx-1' })
      .mockResolvedValueOnce({});

    await expect(driver.createBrowserContext()).resolves.toEqual({ browserContextId: 'ctx-1' });
    await expect(driver.disposeBrowserContext('ctx-1')).resolves.toBeUndefined();
    expect(driver.send).toHaveBeenNthCalledWith(1, 'Target.createBrowserContext');
    expect(driver.send).toHaveBeenNthCalledWith(2, 'Target.disposeBrowserContext', { browserContextId: 'ctx-1' });
  });

  it('does not send the default sentinel to CDP', async () => {
    const driver = new WebSocketCdpDriver('http://127.0.0.1:1') as unknown as {
      assertConnected: () => void;
      send: ReturnType<typeof vi.fn>;
      ensureAttached: ReturnType<typeof vi.fn>;
      inspectPage: ReturnType<typeof vi.fn>;
      openTab: (url: string, options?: OpenTabOptions) => Promise<DriverTab>;
    };
    driver.assertConnected = vi.fn();
    driver.ensureAttached = vi.fn().mockResolvedValue(undefined);
    driver.inspectPage = vi.fn().mockResolvedValue({ url: 'about:blank', title: '' });
    driver.send = vi.fn()
      .mockResolvedValueOnce({ targetId: 'page-1' })
      .mockResolvedValueOnce({ targetInfo: { targetId: 'page-1', type: 'page', title: '', url: 'about:blank' } });

    await driver.openTab('about:blank', { browserContextId: 'default' });
    expect(driver.send).toHaveBeenNthCalledWith(1, 'Target.createTarget', { url: 'about:blank' });
  });

  it('passes context/newWindow and returns authoritative context plus window id', async () => {
    const driver = new WebSocketCdpDriver('http://127.0.0.1:1') as unknown as {
      assertConnected: () => void;
      send: ReturnType<typeof vi.fn>;
      ensureAttached: ReturnType<typeof vi.fn>;
      inspectPage: ReturnType<typeof vi.fn>;
      openTab: (url: string, options?: OpenTabOptions) => Promise<DriverTab>;
    };
    driver.assertConnected = vi.fn();
    driver.ensureAttached = vi.fn().mockResolvedValue(undefined);
    driver.inspectPage = vi.fn().mockResolvedValue({ url: 'https://example.com/', title: 'Example' });
    driver.send = vi.fn()
      .mockResolvedValueOnce({ targetId: 'page-2' })
      .mockResolvedValueOnce({
        targetInfo: {
          targetId: 'page-2', browserContextId: 'ctx-2', type: 'page', title: 'Example', url: 'https://example.com/'
        }
      })
      .mockResolvedValueOnce({ windowId: 42 });

    await expect(driver.openTab('https://example.com/', { browserContextId: 'ctx-2', newWindow: true }))
      .resolves.toMatchObject({ pageId: 'page-2', browserContextId: 'ctx-2', windowId: 42 });
    expect(driver.send).toHaveBeenNthCalledWith(1, 'Target.createTarget', {
      url: 'https://example.com/', browserContextId: 'ctx-2', newWindow: true
    });
    expect(driver.send).toHaveBeenNthCalledWith(3, 'Browser.getWindowForTarget', { targetId: 'page-2' });
  });

  it('rejects disposal of the default context', async () => {
    const driver = new WebSocketCdpDriver('http://127.0.0.1:1') as unknown as {
      assertConnected: () => void;
      send: ReturnType<typeof vi.fn>;
      disposeBrowserContext: (browserContextId: string) => Promise<void>;
    };
    driver.assertConnected = vi.fn();
    driver.send = vi.fn();
    await expect(driver.disposeBrowserContext('default')).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(driver.send).not.toHaveBeenCalled();
  });
});
