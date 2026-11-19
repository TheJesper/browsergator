// Where the dashboard's data comes from. Two backends share one interface: the local service over HTTP,
// and an in-memory one that runs the same core functions for sample-data mode and the single-file preview.

import {
  addAccount,
  addMeter,
  parseState,
  removeAccount,
  removeMeter,
  updateAccount,
  updateMeter,
  updateSettings,
  type AccountInput,
  type AccountPatch,
  type MeterInput,
  type MeterPatch
} from '../core/accounts.js';
import { CATALOG } from '../core/catalog.js';
import { findPlan, findProvider, presetAccountInput } from '../core/catalog-types.js';
import { demoState } from '../core/demo.js';
import { parseQuick } from '../core/quick.js';
import { applyReadingToState, rollState } from '../core/reset.js';
import { addSpendSource, recordSpend, removeSpendSource, updateSpendSource, type SpendSourceInput } from '../core/spend.js';
import type { Price, Reading, Settings, State } from '../core/types.js';

/** Mirrors the server's CollectorStatus without importing server code into the bundle. */
export interface CollectorInfo {
  id: string;
  providerId: string;
  title: string;
  description: string;
  sourceKind: 'local-file' | 'documented-api' | 'undocumented-api' | 'push';
  env: string[];
  enabled: boolean;
  available: boolean;
  reason: string | null;
  lastRunAt: string | null;
  lastOutcome: 'ok' | 'auth' | 'unavailable' | 'failed' | null;
  lastMessage: string | null;
  lastUpdated: string[];
  nextRunAt: string | null;
}

export interface Loaded {
  state: State;
  collectors: CollectorInfo[];
  warnings: string[];
  demo: boolean;
  version: string;
  /** How the CLI is invoked on this machine, for the Connect panel. */
  cli: string;
  origin: string;
  tokenRequired: boolean;
}

export interface PresetRequest {
  provider: string;
  plan?: string;
  label?: string;
  price?: Price | null;
  /** Day of the month the subscription renews, for plans with billing-cycle meters. */
  billingDay?: number | null;
}

export class BackendError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly field?: string,
    readonly candidates?: { accountId: string; meterId: string | null; label: string }[]
  ) {
    super(message);
    this.name = 'BackendError';
  }
}

export interface Backend {
  readonly kind: 'http' | 'memory';
  load(): Promise<Loaded>;
  /** Calls `onChange` whenever the state changed elsewhere and `onStatus` when the connection goes up or down. */
  subscribe(onChange: () => void, onStatus: (online: boolean) => void): () => void;
  addAccount(input: AccountInput): Promise<void>;
  addPreset(preset: PresetRequest): Promise<void>;
  updateAccount(id: string, patch: AccountPatch): Promise<void>;
  removeAccount(id: string): Promise<void>;
  addMeter(accountId: string, input: MeterInput): Promise<void>;
  updateMeter(id: string, patch: MeterPatch): Promise<void>;
  removeMeter(id: string): Promise<void>;
  report(meterId: string, reading: Reading): Promise<void>;
  quick(text: string): Promise<string>;
  addSpend(input: SpendSourceInput): Promise<void>;
  updateSpend(id: string, patch: Partial<Pick<SpendSourceInput, 'label' | 'currency' | 'monthlyBudget'>>): Promise<void>;
  removeSpend(id: string): Promise<void>;
  recordSpend(id: string, entry: { date?: string; amount: number; mode?: 'set' | 'add' }): Promise<void>;
  updateSettings(patch: Partial<Settings>): Promise<void>;
  importState(document: unknown): Promise<void>;
  setCollector(id: string, enabled: boolean): Promise<void>;
  refresh(): Promise<void>;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

export class HttpBackend implements Backend {
  readonly kind = 'http' as const;

  constructor(private readonly base = '') {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const init: RequestInit = { method, credentials: 'same-origin', headers: {} };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers = { 'Content-Type': 'application/json' };
    }
    const response = await fetch(`${this.base}${path}`, init);
    if (response.status === 204) return undefined as T;
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      // a non-JSON answer is handled below through the status
    }
    if (!response.ok) {
      const error = (payload as { error?: { code?: string; message?: string; field?: string; candidates?: BackendError['candidates'] } } | null)?.error;
      throw new BackendError(
        error?.message ?? `The service answered ${response.status}.`,
        error?.code ?? (response.status === 401 ? 'unauthorized' : 'error'),
        error?.field,
        error?.candidates
      );
    }
    return payload as T;
  }

  /** Exchanges a token from the address fragment for a session cookie. The fragment never reaches the server. */
  async signIn(token: string): Promise<void> {
    await this.call('POST', '/api/session', { token });
  }

  async load(): Promise<Loaded> {
    const data = await this.call<{
      state: State;
      collectors?: CollectorInfo[];
      warnings?: string[];
      demo?: boolean;
      version?: string;
      cli?: string;
      tokenRequired?: boolean;
    }>('GET', '/api/state');
    return {
      state: data.state,
      collectors: data.collectors ?? [],
      warnings: data.warnings ?? [],
      demo: data.demo === true,
      version: data.version ?? '',
      cli: data.cli ?? 'tokengator',
      origin: location.origin,
      tokenRequired: data.tokenRequired === true
    };
  }

  subscribe(onChange: () => void, onStatus: (online: boolean) => void): () => void {
    let source: EventSource | null = null;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const open = (): void => {
      if (closed) return;
      source = new EventSource(`${this.base}/api/events`);
      source.addEventListener('open', () => onStatus(true));
      source.addEventListener('change', () => onChange());
      source.addEventListener('error', () => {
        onStatus(false);
        // EventSource retries by itself while the server is reachable; rebuild it when it has given up.
        if (source && source.readyState === EventSource.CLOSED) {
          source.close();
          retry = setTimeout(open, 3000);
        }
      });
    };
    open();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      source?.close();
    };
  }

  async addAccount(input: AccountInput): Promise<void> {
    await this.call('POST', '/api/accounts', input);
  }
  async addPreset(preset: PresetRequest): Promise<void> {
    await this.call('POST', '/api/accounts', { preset });
  }
  async updateAccount(id: string, patch: AccountPatch): Promise<void> {
    await this.call('PATCH', `/api/accounts/${encodeURIComponent(id)}`, patch);
  }
  async removeAccount(id: string): Promise<void> {
    await this.call('DELETE', `/api/accounts/${encodeURIComponent(id)}`);
  }
  async addMeter(accountId: string, input: MeterInput): Promise<void> {
    await this.call('POST', `/api/accounts/${encodeURIComponent(accountId)}/meters`, input);
  }
  async updateMeter(id: string, patch: MeterPatch): Promise<void> {
    await this.call('PATCH', `/api/meters/${encodeURIComponent(id)}`, patch);
  }
  async removeMeter(id: string): Promise<void> {
    await this.call('DELETE', `/api/meters/${encodeURIComponent(id)}`);
  }
  async report(meterId: string, reading: Reading): Promise<void> {
    await this.call('POST', `/api/meters/${encodeURIComponent(meterId)}/readings`, reading);
  }
  async quick(text: string): Promise<string> {
    const result = await this.call<{ preview: string }>('POST', '/api/quick', { text });
    return result.preview;
  }
  async addSpend(input: SpendSourceInput): Promise<void> {
    await this.call('POST', '/api/spend', input);
  }
  async updateSpend(id: string, patch: Partial<Pick<SpendSourceInput, 'label' | 'currency' | 'monthlyBudget'>>): Promise<void> {
    await this.call('PATCH', `/api/spend/${encodeURIComponent(id)}`, patch);
  }
  async removeSpend(id: string): Promise<void> {
    await this.call('DELETE', `/api/spend/${encodeURIComponent(id)}`);
  }
  async recordSpend(id: string, entry: { date?: string; amount: number; mode?: 'set' | 'add' }): Promise<void> {
    await this.call('POST', `/api/spend/${encodeURIComponent(id)}/entries`, entry);
  }
  async updateSettings(patch: Partial<Settings>): Promise<void> {
    await this.call('PATCH', '/api/settings', patch);
  }
  async importState(document: unknown): Promise<void> {
    await this.call('POST', '/api/import', document);
  }
  async setCollector(id: string, enabled: boolean): Promise<void> {
    await this.call('PATCH', `/api/collectors/${encodeURIComponent(id)}`, { enabled });
  }
  async refresh(): Promise<void> {
    await this.call('POST', '/api/refresh', {});
  }
}

// ---------------------------------------------------------------------------
// In memory
// ---------------------------------------------------------------------------

export class MemoryBackend implements Backend {
  readonly kind = 'memory' as const;
  private state: State;
  private readonly listeners = new Set<() => void>();

  constructor(initial?: State) {
    this.state = initial ?? demoState(Date.now());
  }

  private change(next: (state: State, nowMs: number) => State): Promise<void> {
    try {
      const nowMs = Date.now();
      this.state = next(rollState(this.state, nowMs), nowMs);
    } catch (error) {
      // An error that already carries candidates (an ambiguous name) must reach the dialog intact.
      if (error instanceof BackendError) return Promise.reject(error);
      const field = (error as { field?: string }).field;
      return Promise.reject(new BackendError((error as Error).message, 'validation', field));
    }
    for (const listener of [...this.listeners]) listener();
    return Promise.resolve();
  }

  load(): Promise<Loaded> {
    this.state = rollState(this.state, Date.now());
    return Promise.resolve({
      state: this.state,
      collectors: [],
      warnings: [],
      demo: true,
      version: '',
      cli: 'tokengator',
      origin: 'http://127.0.0.1:4777',
      tokenRequired: false
    });
  }

  subscribe(onChange: () => void, onStatus: (online: boolean) => void): () => void {
    this.listeners.add(onChange);
    onStatus(true);
    return () => this.listeners.delete(onChange);
  }

  addAccount(input: AccountInput): Promise<void> {
    return this.change((state, nowMs) => addAccount(state, input, nowMs).state);
  }
  addPreset(preset: PresetRequest): Promise<void> {
    return this.change((state, nowMs) => {
      const provider = findProvider(CATALOG, preset.provider);
      const plan = provider ? findPlan(provider, preset.plan) : null;
      if (!provider || !plan) throw new Error('That provider or plan is not in the catalog.');
      const input = presetAccountInput(provider, plan, preset.label, preset.billingDay);
      if (preset.price !== undefined) input.price = preset.price;
      return addAccount(state, input, nowMs).state;
    });
  }
  updateAccount(id: string, patch: AccountPatch): Promise<void> {
    return this.change((state, nowMs) => updateAccount(state, id, patch, nowMs));
  }
  removeAccount(id: string): Promise<void> {
    return this.change((state) => removeAccount(state, id));
  }
  addMeter(accountId: string, input: MeterInput): Promise<void> {
    return this.change((state, nowMs) => addMeter(state, accountId, input, nowMs).state);
  }
  updateMeter(id: string, patch: MeterPatch): Promise<void> {
    return this.change((state, nowMs) => updateMeter(state, id, patch, nowMs));
  }
  removeMeter(id: string): Promise<void> {
    return this.change((state, nowMs) => removeMeter(state, id, nowMs));
  }
  report(meterId: string, reading: Reading): Promise<void> {
    return this.change((state, nowMs) => {
      const account = state.accounts.find((candidate) => candidate.meters.some((meter) => meter.id === meterId));
      if (!account) throw new Error('No such meter.');
      return applyReadingToState(state, account.id, meterId, { ...reading, source: { kind: 'manual' } }, nowMs);
    });
  }
  quick(text: string): Promise<string> {
    let preview = '';
    return this.change((state, nowMs) => {
      const parsed = parseQuick(text, state, nowMs);
      if (!parsed.ok) throw new BackendError(parsed.error, 'ambiguous', undefined, parsed.candidates);
      preview = parsed.preview;
      return applyReadingToState(state, parsed.account.id, parsed.meter.id, { ...parsed.reading, source: { kind: 'manual' } }, nowMs);
    }).then(() => preview);
  }
  addSpend(input: SpendSourceInput): Promise<void> {
    return this.change((state, nowMs) => addSpendSource(state, input, nowMs).state);
  }
  updateSpend(id: string, patch: Partial<Pick<SpendSourceInput, 'label' | 'currency' | 'monthlyBudget'>>): Promise<void> {
    return this.change((state) => updateSpendSource(state, id, patch));
  }
  removeSpend(id: string): Promise<void> {
    return this.change((state) => removeSpendSource(state, id));
  }
  recordSpend(id: string, entry: { date?: string; amount: number; mode?: 'set' | 'add' }): Promise<void> {
    return this.change((state, nowMs) => recordSpend(state, id, entry, nowMs));
  }
  updateSettings(patch: Partial<Settings>): Promise<void> {
    return this.change((state) => updateSettings(state, patch));
  }
  importState(document: unknown): Promise<void> {
    return this.change((_state, nowMs) => parseState(document, nowMs));
  }
  setCollector(_id: string, _enabled: boolean): Promise<void> {
    return Promise.reject(new BackendError('Automatic sources need the local service. They are not available on sample data.', 'unavailable'));
  }
  refresh(): Promise<void> {
    return Promise.resolve();
  }
}
