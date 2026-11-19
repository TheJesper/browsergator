// The application service: every way of changing or reading Tokengator's state goes through here, so the
// HTTP API, the MCP server and the CLI cannot drift apart.

import {
  NotFoundError,
  ValidationError,
  addAccount,
  addMeter,
  findMeter,
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
import { briefMarkdown, snapshot, type Snapshot } from '../core/brief.js';
import { CATALOG } from '../core/catalog.js';
import { findPlan, findProvider, presetAccountInput, presetMeterInput } from '../core/catalog-types.js';
import { parseQuick, resolveTarget } from '../core/quick.js';
import { ReadingError, applyReadingToState, rollState } from '../core/reset.js';
import {
  addSpendSource,
  recordSpend,
  removeSpendSource,
  updateSpendSource,
  type SpendSourceInput
} from '../core/spend.js';
import { localZone } from '../core/time.js';
import type { Account, Meter, MeterSource, Reading, Settings, SpendSource, State } from '../core/types.js';
import type { CollectedAccount, CollectedSpend } from './collectors/types.js';
import type { StateStore } from './store.js';

export { NotFoundError, ReadingError, ValidationError };

/** Raised when a loose account or meter name matches nothing or more than one thing. */
export class AmbiguousTargetError extends Error {
  constructor(
    message: string,
    readonly candidates: { accountId: string; meterId: string | null; label: string }[]
  ) {
    super(message);
    this.name = 'AmbiguousTargetError';
  }
}

export interface ReportTarget {
  /** Exact meter id. Wins over everything else. */
  meterId?: string;
  /** Account id, label, provider or any unambiguous words from them. */
  account?: string;
  /** Meter key, label or unambiguous words. Omitted means the account's main allowance. */
  meter?: string;
}

export interface ReportOutcome {
  account: Account;
  meter: Meter;
}

export interface ServiceOptions {
  now?: () => number;
  timeZone?: string;
}

export class TokengatorService {
  private readonly now: () => number;
  readonly timeZone: string;

  constructor(
    readonly store: StateStore,
    options: ServiceOptions = {}
  ) {
    this.now = options.now ?? Date.now;
    this.timeZone = options.timeZone ?? localZone();
  }

  nowMs(): number {
    return this.now();
  }

  onChange(listener: () => void): () => void {
    return this.store.onChange(listener);
  }

  /** Current state with every window rolled to now. Persists the roll when it closed a cycle. */
  async state(): Promise<State> {
    const nowMs = this.now();
    const current = await this.store.read();
    const rolled = rollState(current, nowMs);
    if (rolled === current) return current;
    if (rolled.cycles === current.cycles) return rolled; // only anchors moved: not worth a write
    return this.store.update((latest) => {
      const next = rollState(latest, nowMs);
      return { state: next, result: next };
    });
  }

  async snapshot(): Promise<Snapshot> {
    return snapshot(await this.state(), this.now(), this.timeZone);
  }

  async brief(): Promise<string> {
    return briefMarkdown(await this.state(), this.now(), this.timeZone);
  }

  private mutate<T>(change: (state: State, nowMs: number) => { state: State; result: T }): Promise<T> {
    const nowMs = this.now();
    return this.store.update((current) => change(rollState(current, nowMs), nowMs));
  }

  // -- accounts and meters ---------------------------------------------------

  addAccount(input: AccountInput, source: MeterSource = { kind: 'manual' }): Promise<Account> {
    return this.mutate((state, nowMs) => {
      const added = addAccount(state, input, nowMs, source);
      return { state: added.state, result: added.account };
    });
  }

  /** Adds an account from the catalog. `overrides` may rename it or replace the price. */
  async addFromPreset(
    providerId: string,
    planId?: string | null,
    overrides: { label?: string; price?: Account['price']; billingDay?: number | null } = {},
    source: MeterSource = { kind: 'manual' }
  ): Promise<Account> {
    const provider = findProvider(CATALOG, providerId);
    if (!provider) {
      throw new ValidationError(
        'provider',
        `Unknown provider "${providerId}". Known: ${CATALOG.map((entry) => entry.id).join(', ')}. Use a custom account for anything else.`
      );
    }
    const plan = findPlan(provider, planId);
    if (!plan) {
      throw new ValidationError(
        'plan',
        `Unknown plan "${String(planId)}" for ${provider.name}. Known: ${provider.plans.map((entry) => entry.id).join(', ')}.`
      );
    }
    const billingDay = overrides.billingDay;
    if (billingDay !== undefined && billingDay !== null && (!Number.isInteger(billingDay) || billingDay < 1 || billingDay > 31)) {
      throw new ValidationError('billingDay', 'billingDay must be a whole number from 1 to 31.');
    }
    const input = presetAccountInput(provider, plan, overrides.label, billingDay);
    if (overrides.price !== undefined) input.price = overrides.price;
    return this.addAccount(input, source);
  }

  updateAccount(accountId: string, patch: AccountPatch): Promise<Account> {
    return this.mutate((state, nowMs) => {
      const next = updateAccount(state, accountId, patch, nowMs);
      return { state: next, result: next.accounts.find((account) => account.id === accountId) as Account };
    });
  }

  removeAccount(accountId: string): Promise<void> {
    return this.mutate((state) => ({ state: removeAccount(state, accountId), result: undefined }));
  }

  addMeter(accountId: string, input: MeterInput): Promise<Meter> {
    return this.mutate((state, nowMs) => {
      const added = addMeter(state, accountId, input, nowMs);
      return { state: added.state, result: added.meter };
    });
  }

  updateMeter(meterId: string, patch: MeterPatch): Promise<Meter> {
    return this.mutate((state, nowMs) => {
      const next = updateMeter(state, meterId, patch, nowMs);
      return { state: next, result: findMeter(next, meterId).meter };
    });
  }

  removeMeter(meterId: string): Promise<void> {
    return this.mutate((state, nowMs) => ({ state: removeMeter(state, meterId, nowMs), result: undefined }));
  }

  // -- readings ----------------------------------------------------------------

  /** Finds the meter a loose target refers to, or throws with the candidates. */
  resolve(state: State, target: ReportTarget): { account: Account; meter: Meter } {
    if (target.meterId) return findMeter(state, target.meterId);
    const name = [target.account ?? '', target.meter ?? ''].join(' ').trim();
    if (!name) throw new ValidationError('account', 'Name the account (id, label or provider).');
    // An account named by its exact id, with a meter named loosely, must not be confused by other accounts.
    const exact = target.account ? state.accounts.find((account) => account.id === target.account) : undefined;
    const scope = exact ? { ...state, accounts: [exact] } : state;
    const found = resolveTarget(scope, name.split(/\s+/).filter(Boolean));
    if (!found.ok) throw new AmbiguousTargetError(found.error, found.candidates);
    return found;
  }

  report(target: ReportTarget, reading: Reading, source: MeterSource = { kind: 'manual' }): Promise<ReportOutcome> {
    return this.mutate((state, nowMs) => {
      const { meter } = this.resolve(state, target);
      const next = applyReadingToState(state, findMeter(state, meter.id).account.id, meter.id, { ...reading, source }, nowMs);
      const after = findMeter(next, meter.id);
      return { state: next, result: after };
    });
  }

  /** Parses a quick-entry line without saving anything. */
  async previewQuick(text: string): Promise<ReturnType<typeof parseQuick>> {
    return parseQuick(text, await this.state(), this.now(), this.timeZone);
  }

  /** Parses and applies a quick-entry line. */
  quick(text: string, source: MeterSource = { kind: 'manual' }): Promise<ReportOutcome & { preview: string }> {
    return this.mutate((state, nowMs) => {
      const parsed = parseQuick(text, state, nowMs, this.timeZone);
      if (!parsed.ok) throw new AmbiguousTargetError(parsed.error, parsed.candidates);
      const next = applyReadingToState(state, parsed.account.id, parsed.meter.id, { ...parsed.reading, source }, nowMs);
      return { state: next, result: { ...findMeter(next, parsed.meter.id), preview: parsed.preview } };
    });
  }

  // -- spend -------------------------------------------------------------------

  addSpendSource(input: SpendSourceInput): Promise<SpendSource> {
    return this.mutate((state, nowMs) => {
      const added = addSpendSource(state, input, nowMs);
      return { state: added.state, result: added.source };
    });
  }

  updateSpendSource(id: string, patch: Partial<Pick<SpendSourceInput, 'label' | 'currency' | 'monthlyBudget'>>): Promise<void> {
    return this.mutate((state) => ({ state: updateSpendSource(state, id, patch), result: undefined }));
  }

  removeSpendSource(id: string): Promise<void> {
    return this.mutate((state) => ({ state: removeSpendSource(state, id), result: undefined }));
  }

  recordSpend(
    id: string,
    entry: { date?: string; amount: number; mode?: 'set' | 'add' },
    source?: MeterSource
  ): Promise<SpendSource> {
    return this.mutate((state, nowMs) => {
      const next = recordSpend(state, id, entry, nowMs, this.timeZone, source);
      return { state: next, result: next.spend.find((candidate) => candidate.id === id) as SpendSource };
    });
  }

  /** Finds a spend source by id or unambiguous label. */
  async findSpendSource(name: string): Promise<SpendSource> {
    const state = await this.state();
    const wanted = name.trim().toLowerCase();
    const exact = state.spend.find((source) => source.id === wanted || source.label.toLowerCase() === wanted);
    if (exact) return exact;
    const partial = state.spend.filter(
      (source) => source.label.toLowerCase().includes(wanted) || source.providerId === wanted
    );
    if (partial.length === 1) return partial[0] as SpendSource;
    throw new NotFoundError(
      partial.length === 0
        ? `No spend source matches "${name}". Known: ${state.spend.map((source) => source.id).join(', ') || 'none'}.`
        : `"${name}" matches several spend sources: ${partial.map((source) => source.id).join(', ')}.`
    );
  }

  // -- settings, export, import ----------------------------------------------

  updateSettings(patch: Partial<Settings>): Promise<Settings> {
    return this.mutate((state) => {
      const next = updateSettings(state, patch);
      return { state: next, result: next.settings };
    });
  }

  exportState(): Promise<State> {
    return this.state();
  }

  /** Replaces the whole state with a validated document. Throws before changing anything when invalid. */
  importState(document: unknown): Promise<State> {
    return this.mutate((_state, nowMs) => {
      const next = parseState(document, nowMs);
      return { state: next, result: next };
    });
  }

  // -- collectors ----------------------------------------------------------------

  /**
   * Applies what a collector found. Creates the account from the provider's preset on first success and
   * leaves meters the collector did not report alone. Returns the ids of the meters it changed.
   */
  applyCollected(collectorId: string, accounts: CollectedAccount[], spend: CollectedSpend[]): Promise<string[]> {
    const source: MeterSource = { kind: collectorId.endsWith('-statusline') ? 'statusline' : 'collector', id: collectorId };
    return this.mutate((initial, nowMs) => {
      let state = initial;
      const changed: string[] = [];

      for (const collected of accounts) {
        if (collected.meters.length === 0) continue;
        const provider = findProvider(CATALOG, collected.providerId);
        let account = state.accounts.find((candidate) => candidate.providerId === collected.providerId);
        if (!account) {
          const plan = provider ? findPlan(provider, collected.planId) ?? provider.plans[0] : null;
          const input: AccountInput =
            provider && plan
              ? presetAccountInput(provider, plan)
              : {
                  providerId: collected.providerId,
                  label: collected.providerId,
                  meters: collected.meters.map((meter) => ({
                    key: meter.key,
                    label: meter.label ?? meter.key,
                    unit: 'percent',
                    reset: { kind: 'none' }
                  }))
                };
          const added = addAccount(state, input, nowMs, source);
          state = added.state;
          account = added.account;
        }
        for (const collectedMeter of collected.meters) {
          let meter = account.meters.find((candidate) => candidate.key === collectedMeter.key);
          if (!meter) {
            // The account predates this meter (an older preset, or a custom account): add it from the
            // preset when the catalog knows the key, otherwise as a plain percent meter.
            const preset = provider?.plans.flatMap((plan) => plan.meters).find((entry) => entry.key === collectedMeter.key);
            const input: MeterInput = preset
              ? presetMeterInput(preset)
              : { key: collectedMeter.key, label: collectedMeter.label ?? collectedMeter.key, unit: 'percent', reset: { kind: 'none' } };
            const added = addMeter(state, account.id, input, nowMs);
            state = added.state;
            meter = added.meter;
            account = state.accounts.find((candidate) => candidate.id === (account as Account).id) as Account;
          }
          try {
            state = applyReadingToState(state, account.id, meter.id, { ...collectedMeter.reading, source }, nowMs);
            changed.push(meter.id);
          } catch (error) {
            // One unusable reading (a reset time already in the past, say) must not discard the rest.
            if (!(error instanceof ReadingError)) throw error;
          }
          account = state.accounts.find((candidate) => candidate.id === (account as Account).id) as Account;
        }
      }

      for (const collected of spend) {
        let target = state.spend.find(
          (candidate) => candidate.providerId === collected.providerId && candidate.source.id === collectorId
        );
        if (!target) {
          const added = addSpendSource(
            state,
            { providerId: collected.providerId, label: collected.label, currency: collected.currency },
            nowMs,
            source
          );
          state = added.state;
          target = added.source;
        }
        for (const day of collected.days) {
          state = recordSpend(state, target.id, { date: day.date, amount: day.amount, mode: 'set' }, nowMs, this.timeZone, source);
        }
      }
      return { state, result: changed };
    });
  }
}
