import type { GatewayConfig } from '../../src/config.js';
import { resolve } from 'node:path';

export function testConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    host: '127.0.0.1',
    port: 8788,
    browserUrl: 'http://127.0.0.1:9222',
    token: 'test-token-that-is-at-least-24-characters',
    leaseTtlMs: 1_000,
    maxLeaseTtlMs: 10_000,
    eventBufferSize: 50,
    maxResponseBodyBytes: 1_048_576,
    protectedPatterns: ['*/login*', '*/signin*', '*/auth*', '*/checkout*'],
    protectedAgents: [],
    dataDir: resolve(process.cwd(), '.tmp', 'test-data'),
    ...overrides
  };
}
