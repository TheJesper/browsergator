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
  slugify,
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
import { parseQuick, resolveMeterIn, resolveTarget } from '../core/quick.js';
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

/**
 * The error for a quick-entry line that did not parse. With candidates it is a naming problem the caller
 * can resolve by picking one; without, the line itself is invalid.
 */
export function quickError(parsed: { error: string; candidates: { accountId: string; meterId: string | null; label: string }[] }): Error {
  return parsed.candidates.length > 0 ? new AmbiguousTargetError(parsed.error, parsed.candidates) : new ValidationError('text', parsed.error);
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
    // An account named by its exact id is settled; only the meter is looked for, and only inside it. Joining
    // the two names would let a meter word that also occurs in the account label vanish into the account.
    const exact = target.account ? state.accounts.find((account) => account.id === target.account) : undefined;
    if (exact) {
      const meter = resolveMeterIn(exact, target.meter ?? '');
      if (!meter.ok) throw new AmbiguousTargetError(meter.error, meter.candidates);
      return { account: exact, meter: meter.meter };
    }
    const found = resolveTarget(state, name.split(/\s+/).filter(Boolean));
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

  /**
   * Parses a quick-entry line without saving anything. `timeZone` is the zone of whoever typed the line,
   * when that is not this machine's: "fri 09:00" means nine o'clock where they are.
   */
  async previewQuick(text: string, timeZone: string = this.timeZone): Promise<ReturnType<typeof parseQuick>> {
    return parseQuick(text, await this.state(), this.now(), timeZone);
  }

  /** Parses and applies a quick-entry line. */
  quick(text: string, source: MeterSource = { kind: 'manual' }, timeZone: string = this.timeZone): Promise<ReportOutcome & { preview: string }> {
    return this.mutate((state, nowMs) => {
      const parsed = parseQuick(text, state, nowMs, timeZone);
      if (!parsed.ok) throw quickError(parsed);
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

  /**
   * Switches one collector on or off. The list is changed where it is read, inside the store's lock, so
   * two switches made at the same moment (two clicks, or the dashboard and the command line) both take
   * effect. Returns whether the collector is on afterwards, read back from what was stored.
   */
  setCollectorEnabled(id: string, enabled: boolean): Promise<boolean> {
    return this.mutate((state) => {
      const current = new Set(state.settings.enabledCollectors);
      if (current.has(id) === enabled) return { state, result: enabled };
      if (enabled) current.add(id);
      else current.delete(id);
      const next = updateSettings(state, { enabledCollectors: [...current] });
      return { state: next, result: next.settings.enabledCollectors.includes(id) };
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
        // Stored provider ids are slugs, so compare in that form or a non-slug id makes a new account each run.
        const providerId = slugify(collected.providerId);
        const candidates = state.accounts.filter((candidate) => candidate.providerId === providerId);
        // With two accounts of one provider, keep feeding the one this collector fed before.
        let account =
          candidates.find((candidate) => candidate.meters.some((meter) => meter.source.id === collectorId)) ?? candidates[0];
        const fallbackMeter = (meter: CollectedAccount['meters'][number]): MeterInput => {
          const input: MeterInput = {
            key: meter.key,
            label: meter.label ?? meter.key,
            unit: 'percent',
            // Without a known cadence, a reported reset is treated as a single deadline rather than ignored.
            reset: meter.reset ?? (meter.reading.resetsAt && Date.parse(meter.reading.resetsAt) > nowMs ? { kind: 'once' } : { kind: 'none' })
          };
          if (meter.role) input.role = meter.role;
          return input;
        };
        if (!account) {
          const plan = provider ? findPlan(provider, collected.planId) ?? provider.plans[0] : null;
          const input: AccountInput =
            provider && plan
              ? presetAccountInput(provider, plan)
              : {
                  providerId: collected.providerId,
                  label: collected.providerId,
                  meters: collected.meters.map(fallbackMeter)
                };
          // The preset lists everything the plan can have. What the source says this account lacks is left out.
          const absent = new Set(collected.absent ?? []);
          const kept = input.meters.filter((meter) => meter.key === undefined || !absent.has(meter.key));
          if (kept.length > 0) input.meters = kept;
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
            const input: MeterInput = preset ? presetMeterInput(preset) : fallbackMeter(collectedMeter);
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
          (candidate) => candidate.providerId === slugify(collected.providerId) && candidate.source.id === collectorId
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
          try {
            state = recordSpend(state, target.id, { date: day.date, amount: day.amount, mode: 'set' }, nowMs, this.timeZone, source);
          } catch (error) {
            // One malformed day in a provider's report must not discard the other thirty.
            if (!(error instanceof ValidationError)) throw error;
          }
        }
      }
      return { state, result: changed };
    });
  }
}
