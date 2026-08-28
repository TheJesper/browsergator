import { resolve } from 'node:path';

import { z } from 'zod';

import { GatewayError } from './errors.js';

const schema = z.object({
  host: z.enum(['127.0.0.1', 'localhost', '::1']).default('127.0.0.1'),
  port: z.coerce.number().int().min(1).max(65535).default(8788),
  browserUrl: z.string().url().default('http://127.0.0.1:9222'),
  token: z.string().min(24, 'BROWSER_GATEWAY_TOKEN must contain at least 24 characters'),
  leaseTtlMs: z.coerce.number().int().min(100).default(15_000),
  maxLeaseTtlMs: z.coerce.number().int().min(100).default(60_000),
  eventBufferSize: z.coerce.number().int().min(10).max(10_000).default(500),
  maxResponseBodyBytes: z.coerce.number().int().min(1024).max(10_485_760).default(1_048_576),
  protectedPatterns: z.array(z.string()).default(['*/login*', '*/signin*', '*/auth*', '*/checkout*']),
  protectedAgents: z.array(z.string()).default([]),
  dataDir: z.string().default(resolve(process.cwd(), '.data'))
});

export type GatewayConfig = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  try {
    const config = schema.parse({
      host: env['BROWSER_GATEWAY_HOST'],
      port: env['BROWSER_GATEWAY_PORT'],
      browserUrl: env['BROWSER_GATEWAY_BROWSER_URL'],
      token: env['BROWSER_GATEWAY_TOKEN'],
      leaseTtlMs: env['BROWSER_GATEWAY_LEASE_TTL_MS'],
      maxLeaseTtlMs: env['BROWSER_GATEWAY_MAX_LEASE_TTL_MS'],
      eventBufferSize: env['BROWSER_GATEWAY_EVENT_BUFFER_SIZE'],
      maxResponseBodyBytes: env['BROWSER_GATEWAY_MAX_RESPONSE_BODY_BYTES'],
      protectedPatterns: csv(env['BROWSER_GATEWAY_PROTECTED_PATTERNS']),
      protectedAgents: csv(env['BROWSER_GATEWAY_PROTECTED_AGENTS']),
      dataDir: env['BROWSER_GATEWAY_DATA_DIR']
    });
    if (config.leaseTtlMs > config.maxLeaseTtlMs) {
      throw new Error('BROWSER_GATEWAY_LEASE_TTL_MS cannot exceed BROWSER_GATEWAY_MAX_LEASE_TTL_MS');
    }
    assertLoopbackUrl(config.browserUrl);
    return config;
  } catch (error) {
    throw new GatewayError(
      'INVALID_CONFIG',
      error instanceof Error ? error.message : 'Invalid gateway configuration'
    );
  }
}

function csv(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function assertLoopbackUrl(value: string): void {
  const hostname = new URL(value).hostname.toLowerCase();
  if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(hostname)) {
    throw new Error('BROWSER_GATEWAY_BROWSER_URL must use a loopback host');
  }
}
