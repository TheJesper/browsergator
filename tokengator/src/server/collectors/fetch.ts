// The only way a collector talks to the network. It enforces what the spec promises: HTTPS, the
// collector's own hosts only, no following redirects, a time limit, and errors that never echo a secret.

import { redact } from '../logger.js';
import { CollectorError, type CollectorContext } from './types.js';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export const COLLECT_TIMEOUT_MS = 12_000;
/** Largest response a collector will read. Usage endpoints answer in a few kilobytes. */
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export function restrictedFetchJson(
  allowedHosts: readonly string[],
  signal: AbortSignal,
  fetchImpl: FetchLike = fetch
): CollectorContext['fetchJson'] {
  const allowed = new Set(allowedHosts.map((host) => host.toLowerCase()));
  return async (url, init = {}) => {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      throw new CollectorError('The collector built an invalid address.');
    }
    if (target.protocol !== 'https:') throw new CollectorError('Collectors may only use HTTPS.');
    if (!allowed.has(target.hostname.toLowerCase())) {
      throw new CollectorError(`Collectors may only contact their own provider; ${target.hostname} is not allowed.`);
    }
    let response: Response;
    try {
      const request: RequestInit = {
        method: init.method ?? 'GET',
        headers: { Accept: 'application/json', ...(init.headers ?? {}) },
        // A redirect could carry the credential to another host. Refuse instead of following.
        redirect: 'manual',
        signal: AbortSignal.any([signal, AbortSignal.timeout(COLLECT_TIMEOUT_MS)])
      };
      if (init.body !== undefined) request.body = init.body;
      response = await fetchImpl(target.toString(), request);
    } catch (error) {
      const name = (error as Error).name;
      if (name === 'TimeoutError' || name === 'AbortError') throw new CollectorError(`${target.hostname} did not answer in time.`);
      throw new CollectorError(`Could not reach ${target.hostname}: ${redact((error as Error).message)}`);
    }
    if (response.status >= 300 && response.status < 400) {
      throw new CollectorError(`${target.hostname} answered with a redirect, which collectors do not follow.`);
    }
    if (response.status === 401 || response.status === 403) {
      throw new CollectorError(`${target.hostname} rejected the credential (HTTP ${response.status}).`, 'auth');
    }
    if (!response.ok) throw new CollectorError(`${target.hostname} answered HTTP ${response.status}.`);
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) throw new CollectorError(`${target.hostname} sent an unexpectedly large answer.`);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new CollectorError(`${target.hostname} did not answer with JSON.`);
    }
  };
}

// -- small readers for untyped JSON --------------------------------------------

export function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** A finite number from a number or a numeric string, else null. */
export function numeric(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** An ISO instant from Unix seconds, Unix milliseconds or an ISO string, else null. */
export function instant(value: unknown): string | null {
  const n = numeric(value);
  if (n !== null && n > 0) {
    const ms = n > 1e11 ? n : n * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  return null;
}
