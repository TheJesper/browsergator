import { GatewayError } from '../errors.js';

interface Entry<T> {
  fingerprint: string;
  expiresAt: number;
  promise: Promise<T>;
}

export class IdempotencyStore {
  private readonly entries = new Map<string, Entry<unknown>>();

  constructor(
    private readonly ttlMs = 5 * 60_000,
    private readonly maxEntries = 1_000,
    private readonly now: () => number = Date.now
  ) {}

  async run<T>(scope: string, key: string, fingerprint: string, operation: () => Promise<T>): Promise<T> {
    this.cleanup();
    const storageKey = `${scope}:${key}`;
    const existing = this.entries.get(storageKey) as Entry<T> | undefined;
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new GatewayError(
          'IDEMPOTENCY_CONFLICT',
          'The idempotency key was already used for a different request'
        );
      }
      return existing.promise;
    }

    const promise = operation();
    this.entries.set(storageKey, {
      fingerprint,
      expiresAt: this.now() + this.ttlMs,
      promise
    });
    this.evictOverflow();
    try {
      return await promise;
    } catch (error) {
      this.entries.delete(storageKey);
      throw error;
    }
  }

  private cleanup(): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= this.now()) this.entries.delete(key);
    }
  }

  private evictOverflow(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (!oldest) break;
      this.entries.delete(oldest);
    }
  }
}
