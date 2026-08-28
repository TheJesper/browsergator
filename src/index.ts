import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from './config.js';
import { JsonlAuditLog } from './core/audit-log.js';
import { log } from './core/logger.js';
import { SingletonLock } from './core/singleton-lock.js';
import { WebSocketCdpDriver } from './cdp/websocket-cdp-driver.js';
import { BrowserGateway } from './gateway.js';
import { GatewayHttpServer } from './http/server.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const lock = new SingletonLock(fileURLToPath(new URL('../.data/gateway.lock', import.meta.url)));
  await lock.acquire();

  const audit = new JsonlAuditLog(join(config.dataDir, 'audit.jsonl'));
  await audit.initialize();
  const driver = new WebSocketCdpDriver(config.browserUrl);
  const gateway = new BrowserGateway(config, driver, audit);
  const http = new GatewayHttpServer(gateway, config);
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('info', 'Browser Gateway shutting down', { signal });
    await http.close().catch((error) => log('error', 'HTTP shutdown failed', { error }));
    await gateway.stop().catch((error) => log('error', 'Gateway shutdown failed', { error }));
    await lock.release().catch((error) => log('error', 'Singleton lock release failed', { error }));
  };

  process.once('SIGINT', () => void shutdown('SIGINT').finally(() => process.exit(0)));
  process.once('SIGTERM', () => void shutdown('SIGTERM').finally(() => process.exit(0)));
  process.once('uncaughtException', (error) => {
    log('error', 'Uncaught exception', { error });
    void shutdown('uncaughtException').finally(() => process.exit(1));
  });
  process.once('unhandledRejection', (error) => {
    log('error', 'Unhandled rejection', { error });
    void shutdown('unhandledRejection').finally(() => process.exit(1));
  });

  await gateway.start();
  const address = await http.listen();
  log('info', 'Browser Gateway listening', {
    endpoint: `http://${address.host}:${address.port}/mcp`,
    browserConnected: driver.status().connected
  });
}

main().catch((error) => {
  log('error', 'Browser Gateway failed to start', { error });
  process.exitCode = 1;
});
