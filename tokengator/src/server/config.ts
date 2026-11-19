// Runtime configuration, from the environment and command-line overrides.

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const VERSION = '0.1.0';
export const DEFAULT_PORT = 4777;
export const DEFAULT_HOST = '127.0.0.1';
/** Largest request body the service accepts. */
export const MAX_BODY_BYTES = 256 * 1024;

export interface ServiceConfig {
  host: string;
  port: number;
  /** Optional access token. Required when `host` is not a loopback address. */
  token: string | null;
  /** Directory that holds the state file and the optional environment file. */
  home: string;
  /** Serve built-in sample data from memory instead of the state file. */
  demo: boolean;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === 'localhost' || h === '::1' || h === '[::1]' || /^127(\.\d{1,3}){3}$/.test(h);
}

export function tokengatorHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env['TOKENGATOR_HOME'];
  return configured && configured.trim() ? resolve(configured.trim()) : join(homedir(), '.tokengator');
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<Pick<ServiceConfig, 'host' | 'port' | 'demo'>> = {}
): ServiceConfig {
  const host = overrides.host ?? (env['TOKENGATOR_HOST']?.trim() || DEFAULT_HOST);
  const rawPort = overrides.port ?? (env['TOKENGATOR_PORT'] ? Number(env['TOKENGATOR_PORT']) : DEFAULT_PORT);
  if (!Number.isInteger(rawPort) || rawPort < 0 || rawPort > 65_535) {
    throw new ConfigError(`TOKENGATOR_PORT must be a port number, got "${String(env['TOKENGATOR_PORT'] ?? overrides.port)}".`);
  }
  const token = env['TOKENGATOR_TOKEN']?.trim() || null;
  if (token !== null && token.length < 16) {
    throw new ConfigError('TOKENGATOR_TOKEN must be at least 16 characters.');
  }
  if (!isLoopbackHost(host) && token === null) {
    throw new ConfigError(
      `Refusing to listen on ${host} without an access token. Set TOKENGATOR_TOKEN (16+ characters), or use 127.0.0.1.`
    );
  }
  return { host, port: rawPort, token, home: tokengatorHome(env), demo: overrides.demo ?? false };
}
