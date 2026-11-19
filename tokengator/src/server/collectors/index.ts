// Collector registry and runner: opt-in, scheduled, isolated from each other, with backoff.

import { redact, log } from '../logger.js';
import type { TokengatorService } from '../service.js';
import { COLLECT_TIMEOUT_MS, restrictedFetchJson, type FetchLike } from './fetch.js';
import { BUILT_IN_COLLECTORS } from './sources.js';
import { CollectorError, type Collector, type CollectorHost, type CollectorStatus } from './types.js';

export interface CollectorRunnerOptions {
  env: Readonly<Record<string, string | undefined>>;
  homeDir: string;
  /** Overrides the built-in registry; used by tests. */
  collectors?: readonly Collector[];
  /** Overrides the network; used by tests. */
  fetchImpl?: FetchLike;
  /** Overrides the timer; used by tests. */
  now?: () => number;
}

export interface CollectorRunner extends CollectorHost {
  /** Runs enabled collectors now and keeps running them on their intervals. */
  start(): void;
  stop(): void;
}

export const COLLECTORS: readonly Collector[] = BUILT_IN_COLLECTORS;

/** The longest a failing collector waits before its next attempt. */
const MAX_BACKOFF_MS = 60 * 60_000;

interface Run {
  lastRunAt: string | null;
  lastOutcome: CollectorStatus['lastOutcome'];
  lastMessage: string | null;
  lastUpdated: string[];
  failures: number;
  nextRunAt: number | null;
  timer: NodeJS.Timeout | undefined;
  running: Promise<void> | null;
}

export function createCollectorRunner(service: TokengatorService, options: CollectorRunnerOptions): CollectorRunner {
  const registry = options.collectors ?? COLLECTORS;
  const now = options.now ?? Date.now;
  const runs = new Map<string, Run>(
    registry.map((collector) => [collector.id, { lastRunAt: null, lastOutcome: null, lastMessage: null, lastUpdated: [], failures: 0, nextRunAt: null, timer: undefined, running: null }])
  );
  let started = false;

  const find = (id: string): Collector => {
    const collector = registry.find((candidate) => candidate.id === id);
    if (!collector) throw new CollectorError(`Unknown collector "${id}". Known: ${registry.map((candidate) => candidate.id).join(', ') || 'none'}.`, 'unavailable');
    return collector;
  };

  const enabledIds = async (): Promise<Set<string>> => new Set((await service.state()).settings.enabledCollectors);

  async function status(collector: Collector, enabled: boolean): Promise<CollectorStatus> {
    const run = runs.get(collector.id) as Run;
    let available = false;
    let reason: string | null;
    try {
      const answer = await collector.available({ env: options.env, homeDir: options.homeDir });
      available = answer.ok;
      reason = answer.ok ? null : (answer.reason ?? 'Not available.');
    } catch {
      reason = 'Could not check this source.';
    }
    return {
      id: collector.id,
      providerId: collector.providerId,
      title: collector.title,
      description: collector.description,
      sourceKind: collector.sourceKind,
      env: collector.env,
      enabled,
      available,
      reason,
      lastRunAt: run.lastRunAt,
      lastOutcome: run.lastOutcome,
      lastMessage: run.lastMessage,
      lastUpdated: run.lastUpdated,
      nextRunAt: enabled && run.nextRunAt !== null ? new Date(run.nextRunAt).toISOString() : null
    };
  }

  function schedule(collector: Collector): void {
    const run = runs.get(collector.id) as Run;
    if (run.timer) clearTimeout(run.timer);
    run.timer = undefined;
    if (!started) return;
    const base = collector.intervalMinutes * 60_000;
    // Each failure doubles the wait, up to an hour; a success resets it.
    const delay = run.failures === 0 ? base : Math.min(MAX_BACKOFF_MS, base * 2 ** Math.min(run.failures, 6));
    run.nextRunAt = now() + delay;
    run.timer = setTimeout(() => {
      void enabledIds().then(
        (enabled) => (enabled.has(collector.id) ? runOne(collector) : undefined),
        () => undefined
      );
    }, delay);
    run.timer.unref();
  }

  function runOne(collector: Collector): Promise<void> {
    const run = runs.get(collector.id) as Run;
    if (run.running) return run.running;
    const controller = new AbortController();
    // One bound for the whole run, on top of the per-request limit inside fetchJson.
    const limit = setTimeout(() => controller.abort(), COLLECT_TIMEOUT_MS * 2);
    const work = (async () => {
      try {
        const result = await collector.collect({
          env: options.env,
          homeDir: options.homeDir,
          nowMs: now(),
          signal: controller.signal,
          fetchJson: restrictedFetchJson(collector.allowedHosts, controller.signal, options.fetchImpl)
        });
        const updated = await service.applyCollected(collector.id, result.accounts, result.spend);
        run.lastOutcome = updated.length > 0 || result.spend.length > 0 ? 'ok' : 'unavailable';
        run.lastMessage = result.note ?? (run.lastOutcome === 'ok' ? null : 'Nothing to read right now.');
        run.lastUpdated = updated;
        run.failures = 0;
      } catch (error) {
        const kind = error instanceof CollectorError ? error.kind : 'failed';
        run.lastOutcome = kind;
        // Messages pass through redaction: an upstream error body could echo a key back.
        run.lastMessage = redact(error instanceof Error ? error.message : 'The source failed.').slice(0, 240);
        run.lastUpdated = [];
        run.failures += 1;
        log('warn', 'collector failed', { collector: collector.id, outcome: kind, detail: run.lastMessage });
      } finally {
        clearTimeout(limit);
        run.lastRunAt = new Date(now()).toISOString();
        run.running = null;
        schedule(collector);
      }
    })();
    run.running = work;
    return work;
  }

  return {
    start(): void {
      if (started) return;
      started = true;
      void enabledIds().then(
        (enabled) => {
          for (const collector of registry) {
            if (enabled.has(collector.id)) void runOne(collector);
          }
        },
        () => undefined
      );
    },
    stop(): void {
      started = false;
      for (const run of runs.values()) {
        if (run.timer) clearTimeout(run.timer);
        run.timer = undefined;
        run.nextRunAt = null;
      }
    },
    async list(): Promise<CollectorStatus[]> {
      const enabled = await enabledIds();
      return Promise.all(registry.map((collector) => status(collector, enabled.has(collector.id))));
    },
    async setEnabled(id: string, enabled: boolean): Promise<CollectorStatus> {
      const collector = find(id);
      const current = await enabledIds();
      if (enabled) current.add(id);
      else current.delete(id);
      await service.updateSettings({ enabledCollectors: [...current] });
      const run = runs.get(id) as Run;
      if (enabled) await runOne(collector);
      else {
        if (run.timer) clearTimeout(run.timer);
        run.timer = undefined;
        run.nextRunAt = null;
      }
      return status(collector, enabled);
    },
    async refresh(ids?: string[]): Promise<CollectorStatus[]> {
      const enabled = await enabledIds();
      const wanted = ids && ids.length > 0 ? ids.map(find) : registry.filter((collector) => enabled.has(collector.id));
      // Collectors run side by side; one that fails or hangs cannot hold up the rest.
      await Promise.all(wanted.filter((collector) => enabled.has(collector.id)).map((collector) => runOne(collector)));
      return Promise.all(wanted.map((collector) => status(collector, enabled.has(collector.id))));
    }
  };
}
