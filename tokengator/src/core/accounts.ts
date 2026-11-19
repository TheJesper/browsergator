// Pure state transitions for accounts, meters and settings, with the validation every interface shares.
// The HTTP API, the MCP server, the CLI and the in-browser sample backend all go through these.

import type {
  Account,
  Meter,
  MeterRole,
  MeterSource,
  Price,
  ResetRule,
  Settings,
  State,
  Unit
} from './types.js';
import { STATE_VERSION, emptyState } from './types.js';
import { anchorMeter, rollState } from './reset.js';
import { iso, isValidTimeZone, toMs } from './time.js';

export class ValidationError extends Error {
  constructor(
    readonly field: string,
    message: string
  ) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

const UNIT_IDS: readonly Unit[] = [
  'percent',
  'requests',
  'credits',
  'tokens',
  'characters',
  'minutes',
  'hours',
  'images',
  'usd',
  'count'
];

export interface MeterInput {
  key?: string;
  label: string;
  role?: MeterRole;
  unit?: Unit;
  unitLabel?: string;
  limit?: number;
  used?: number;
  reset: ResetRule;
  resetsAt?: string | null;
  windowStartedAt?: string | null;
  rollover?: 'none' | 'carries';
  valueShare?: number;
  /** Throttles only: the limit covers part of the plan and does not block the rest. */
  partial?: boolean;
}

export interface AccountInput {
  providerId?: string;
  label: string;
  plan?: string | null;
  price?: Price | null;
  usageUrl?: string | null;
  notes?: string | null;
  meters: MeterInput[];
}

export type AccountPatch = Partial<Pick<Account, 'label' | 'plan' | 'price' | 'usageUrl' | 'notes' | 'snoozedUntil'>>;
export type MeterPatch = Partial<
  Pick<MeterInput, 'label' | 'role' | 'unit' | 'unitLabel' | 'limit' | 'used' | 'reset' | 'resetsAt' | 'windowStartedAt' | 'rollover' | 'valueShare' | 'partial'>
>;

export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || 'item';
}

function uniqueSlug(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; n < 10_000; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${taken.size + 1}`;
}

function text(field: string, value: unknown, max: number, required: boolean): string | null {
  if (value === undefined || value === null || value === '') {
    if (required) throw new ValidationError(field, `${field} is required.`);
    return null;
  }
  if (typeof value !== 'string') throw new ValidationError(field, `${field} must be text.`);
  const trimmed = value.trim();
  if (!trimmed && required) throw new ValidationError(field, `${field} is required.`);
  if (trimmed.length > max) throw new ValidationError(field, `${field} must be at most ${max} characters.`);
  return trimmed || null;
}

function instant(field: string, value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || toMs(value) === null) {
    throw new ValidationError(field, `${field} must be an ISO 8601 date and time.`);
  }
  return iso(toMs(value) as number);
}

export function validateResetRule(rule: unknown, field = 'reset'): ResetRule {
  if (!rule || typeof rule !== 'object') throw new ValidationError(field, `${field} is required.`);
  const r = rule as Record<string, unknown>;
  const hours = (): number => {
    const value = r['hours'];
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 24 * 366) {
      throw new ValidationError(`${field}.hours`, 'hours must be a number greater than 0.');
    }
    return value;
  };
  const clock = (): string => {
    const value = r['time'] ?? '00:00';
    if (typeof value !== 'string' || !/^([01]?\d|2[0-3]):[0-5]\d$/.test(value)) {
      throw new ValidationError(`${field}.time`, 'time must look like 09:00 (24-hour clock).');
    }
    return value.padStart(5, '0');
  };
  const zone = (): string => {
    const value = r['tz'] ?? 'UTC';
    if (typeof value !== 'string' || !isValidTimeZone(value)) {
      throw new ValidationError(`${field}.tz`, `"${String(value)}" is not a known time zone. Use an IANA name such as Europe/Stockholm.`);
    }
    return value;
  };
  switch (r['kind']) {
    case 'rolling':
      return { kind: 'rolling', hours: hours() };
    case 'interval':
      return { kind: 'interval', hours: hours() };
    case 'daily':
      return { kind: 'daily', time: clock(), tz: zone() };
    case 'monthly': {
      const day = r['day'];
      if (typeof day !== 'number' || !Number.isInteger(day) || day < 1 || day > 31) {
        throw new ValidationError(`${field}.day`, 'day must be a whole number from 1 to 31.');
      }
      return { kind: 'monthly', day, time: clock(), tz: zone() };
    }
    case 'once':
      return { kind: 'once' };
    case 'none':
      return { kind: 'none' };
    default:
      throw new ValidationError(
        `${field}.kind`,
        'reset.kind must be one of rolling, interval, daily, monthly, once, none.'
      );
  }
}

function validatePrice(value: unknown): Price | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object') throw new ValidationError('price', 'price must be an object.');
  const p = value as Record<string, unknown>;
  const amount = p['amount'];
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
    throw new ValidationError('price.amount', 'price.amount must be a number of 0 or more.');
  }
  if (amount === 0) return null;
  const currency = typeof p['currency'] === 'string' ? p['currency'].trim().toUpperCase() : 'USD';
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new ValidationError('price.currency', 'price.currency must be a three-letter code such as USD.');
  }
  const period = p['period'] === 'year' ? 'year' : 'month';
  return { amount, currency, period };
}

function buildMeter(
  accountId: string,
  input: MeterInput,
  index: number,
  takenKeys: Set<string>,
  nowMs: number,
  source: MeterSource,
  isFirstAllowance: boolean
): Meter {
  const field = `meters[${index}]`;
  const label = text(`${field}.label`, input.label, 60, true) as string;
  const role: MeterRole = input.role === 'throttle' ? 'throttle' : 'allowance';
  const unit: Unit = input.unit ?? 'percent';
  if (!UNIT_IDS.includes(unit)) throw new ValidationError(`${field}.unit`, `unit must be one of ${UNIT_IDS.join(', ')}.`);
  let limit = unit === 'percent' ? 100 : input.limit;
  if (limit === undefined) throw new ValidationError(`${field}.limit`, 'limit is required unless the unit is percent.');
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) {
    throw new ValidationError(`${field}.limit`, 'limit must be a number greater than 0.');
  }
  if (unit === 'percent') limit = 100;
  const used = input.used ?? 0;
  if (typeof used !== 'number' || !Number.isFinite(used) || used < 0) {
    throw new ValidationError(`${field}.used`, 'used must be a number of 0 or more.');
  }
  const reset = validateResetRule(input.reset, `${field}.reset`);
  const valueShare = input.valueShare ?? (role === 'allowance' && isFirstAllowance ? 1 : 0);
  if (typeof valueShare !== 'number' || valueShare < 0 || valueShare > 1) {
    throw new ValidationError(`${field}.valueShare`, 'valueShare must be between 0 and 1.');
  }
  const key = uniqueSlug(slugify(input.key ?? label), takenKeys);
  takenKeys.add(key);
  const meter: Meter = {
    id: `${accountId}:${key}`,
    key,
    label,
    role,
    unit,
    limit,
    used,
    reset,
    windowStartedAt: instant(`${field}.windowStartedAt`, input.windowStartedAt),
    resetsAt: instant(`${field}.resetsAt`, input.resetsAt),
    rollover: input.rollover === 'carries' ? 'carries' : 'none',
    valueShare: role === 'throttle' ? 0 : valueShare,
    source,
    // A meter created with a starting amount counts as read; an untouched preset does not.
    updatedAt: input.used !== undefined ? iso(nowMs) : null,
    samples: input.used !== undefined ? [{ t: iso(nowMs), used }] : [],
    estimated: false,
    expired: false
  };
  const unitLabel = text(`${field}.unitLabel`, input.unitLabel, 24, false);
  if (unitLabel) meter.unitLabel = unitLabel;
  if (role === 'throttle' && input.partial === true) meter.partial = true;
  return anchorMeter(meter, nowMs);
}

export function addAccount(
  state: State,
  input: AccountInput,
  nowMs: number,
  source: MeterSource = { kind: 'manual' }
): { state: State; account: Account } {
  const label = text('label', input.label, 60, true) as string;
  if (!Array.isArray(input.meters) || input.meters.length === 0) {
    throw new ValidationError('meters', 'An account needs at least one meter.');
  }
  if (input.meters.length > 12) throw new ValidationError('meters', 'An account can have at most 12 meters.');
  const id = uniqueSlug(slugify(label), new Set(state.accounts.map((account) => account.id)));
  const takenKeys = new Set<string>();
  let seenAllowance = false;
  const meters = input.meters.map((meterInput, index) => {
    const isAllowance = meterInput.role !== 'throttle';
    const meter = buildMeter(id, meterInput, index, takenKeys, nowMs, source, isAllowance && !seenAllowance);
    if (isAllowance) seenAllowance = true;
    return meter;
  });
  const account: Account = {
    id,
    providerId: slugify(input.providerId ?? 'custom'),
    label,
    plan: text('plan', input.plan, 60, false),
    price: validatePrice(input.price),
    usageUrl: validateUrl(input.usageUrl),
    notes: text('notes', input.notes, 2000, false),
    meters,
    snoozedUntil: null,
    createdAt: iso(nowMs),
    updatedAt: iso(nowMs)
  };
  return { state: { ...state, accounts: [...state.accounts, account] }, account };
}

function validateUrl(value: unknown): string | null {
  const url = text('usageUrl', value, 500, false);
  if (!url) return null;
  if (!/^https?:\/\//i.test(url)) throw new ValidationError('usageUrl', 'usageUrl must start with http:// or https://.');
  return url;
}

function requireAccount(state: State, accountId: string): Account {
  const account = state.accounts.find((candidate) => candidate.id === accountId);
  if (!account) throw new NotFoundError(`No account with id "${accountId}".`);
  return account;
}

function replaceAccount(state: State, next: Account): State {
  return { ...state, accounts: state.accounts.map((account) => (account.id === next.id ? next : account)) };
}

export function updateAccount(state: State, accountId: string, patch: AccountPatch, nowMs: number): State {
  const account = requireAccount(state, accountId);
  const next: Account = { ...account, updatedAt: iso(nowMs) };
  if ('label' in patch) next.label = text('label', patch.label, 60, true) as string;
  if ('plan' in patch) next.plan = text('plan', patch.plan, 60, false);
  if ('price' in patch) next.price = validatePrice(patch.price);
  if ('usageUrl' in patch) next.usageUrl = validateUrl(patch.usageUrl);
  if ('notes' in patch) next.notes = text('notes', patch.notes, 2000, false);
  if ('snoozedUntil' in patch) next.snoozedUntil = instant('snoozedUntil', patch.snoozedUntil);
  return replaceAccount(state, next);
}

export function removeAccount(state: State, accountId: string): State {
  requireAccount(state, accountId);
  // Finished cycles are kept on purpose: the ledger is a record of what happened.
  return { ...state, accounts: state.accounts.filter((account) => account.id !== accountId) };
}

export function findMeter(state: State, meterId: string): { account: Account; meter: Meter } {
  for (const account of state.accounts) {
    const meter = account.meters.find((candidate) => candidate.id === meterId);
    if (meter) return { account, meter };
  }
  throw new NotFoundError(`No meter with id "${meterId}".`);
}

export function addMeter(state: State, accountId: string, input: MeterInput, nowMs: number): { state: State; meter: Meter } {
  const account = requireAccount(state, accountId);
  if (account.meters.length >= 12) throw new ValidationError('meters', 'An account can have at most 12 meters.');
  const takenKeys = new Set(account.meters.map((meter) => meter.key));
  const hasAllowance = account.meters.some((meter) => meter.role === 'allowance');
  const meter = buildMeter(account.id, input, account.meters.length, takenKeys, nowMs, { kind: 'manual' }, !hasAllowance);
  const next = { ...account, meters: [...account.meters, meter], updatedAt: iso(nowMs) };
  return { state: replaceAccount(state, next), meter };
}

export function updateMeter(state: State, meterId: string, patch: MeterPatch, nowMs: number): State {
  const { account, meter } = findMeter(state, meterId);
  let next: Meter = { ...meter };
  if ('label' in patch) next.label = text('label', patch.label, 60, true) as string;
  if ('role' in patch) {
    next.role = patch.role === 'throttle' ? 'throttle' : 'allowance';
    if (next.role === 'throttle') next.valueShare = 0;
  }
  if ('unit' in patch && patch.unit !== undefined) {
    if (!UNIT_IDS.includes(patch.unit)) throw new ValidationError('unit', `unit must be one of ${UNIT_IDS.join(', ')}.`);
    if (patch.unit !== next.unit) {
      // Samples are amounts in the old unit; they mean nothing in the new one.
      next.samples = [];
      if (patch.unit === 'percent') {
        next.used = next.limit > 0 ? (next.used / next.limit) * 100 : 0;
        next.limit = 100;
      }
    }
    next.unit = patch.unit;
  }
  if ('unitLabel' in patch) {
    const unitLabel = text('unitLabel', patch.unitLabel, 24, false);
    if (unitLabel) next.unitLabel = unitLabel;
    else delete next.unitLabel;
  }
  if ('limit' in patch && patch.limit !== undefined && next.unit !== 'percent') {
    if (typeof patch.limit !== 'number' || !Number.isFinite(patch.limit) || patch.limit <= 0) {
      throw new ValidationError('limit', 'limit must be a number greater than 0.');
    }
    next.limit = patch.limit;
  }
  if ('used' in patch && patch.used !== undefined) {
    if (typeof patch.used !== 'number' || !Number.isFinite(patch.used) || patch.used < 0) {
      throw new ValidationError('used', 'used must be a number of 0 or more.');
    }
    next.used = patch.used;
    next.updatedAt = iso(nowMs);
    next.estimated = false;
    next.samples = [...next.samples, { t: iso(nowMs), used: patch.used }];
  }
  if ('reset' in patch && patch.reset !== undefined) {
    const rule = validateResetRule(patch.reset);
    if (JSON.stringify(rule) !== JSON.stringify(next.reset)) {
      next.reset = rule;
      // A different rule means the stored window no longer describes anything.
      next.resetsAt = null;
      next.windowStartedAt = null;
      next.expired = false;
    }
  }
  if ('resetsAt' in patch) {
    next.resetsAt = instant('resetsAt', patch.resetsAt);
    next.expired = false;
    if (!('windowStartedAt' in patch)) next.windowStartedAt = null;
  }
  if ('windowStartedAt' in patch) next.windowStartedAt = instant('windowStartedAt', patch.windowStartedAt);
  if ('rollover' in patch) next.rollover = patch.rollover === 'carries' ? 'carries' : 'none';
  if ('partial' in patch || 'role' in patch) {
    const partial = ('partial' in patch ? patch.partial === true : next.partial === true) && next.role === 'throttle';
    if (partial) next.partial = true;
    else delete next.partial;
  }
  if ('valueShare' in patch && patch.valueShare !== undefined) {
    if (typeof patch.valueShare !== 'number' || patch.valueShare < 0 || patch.valueShare > 1) {
      throw new ValidationError('valueShare', 'valueShare must be between 0 and 1.');
    }
    next.valueShare = next.role === 'throttle' ? 0 : patch.valueShare;
  }
  const start = toMs(next.windowStartedAt);
  const end = toMs(next.resetsAt);
  if (start !== null && end !== null && start >= end) {
    throw new ValidationError('windowStartedAt', 'The window must start before it resets.');
  }
  next = anchorMeter(next, nowMs);
  const nextAccount = {
    ...account,
    updatedAt: iso(nowMs),
    meters: account.meters.map((candidate) => (candidate.id === meterId ? next : candidate))
  };
  return replaceAccount(state, nextAccount);
}

export function removeMeter(state: State, meterId: string, nowMs: number): State {
  const { account } = findMeter(state, meterId);
  if (account.meters.length === 1) {
    throw new ValidationError('meter', 'An account needs at least one meter. Remove the account instead.');
  }
  const next = { ...account, updatedAt: iso(nowMs), meters: account.meters.filter((meter) => meter.id !== meterId) };
  return replaceAccount(state, next);
}

export function updateSettings(state: State, patch: Partial<Settings>): State {
  const settings: Settings = { ...state.settings };
  if (patch.currency !== undefined) {
    const currency = String(patch.currency).trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) throw new ValidationError('currency', 'currency must be a three-letter code such as USD.');
    settings.currency = currency;
  }
  if (patch.enabledCollectors !== undefined) {
    if (!Array.isArray(patch.enabledCollectors) || patch.enabledCollectors.some((id) => typeof id !== 'string')) {
      throw new ValidationError('enabledCollectors', 'enabledCollectors must be a list of collector ids.');
    }
    settings.enabledCollectors = [...new Set(patch.enabledCollectors.map((id) => id.trim()).filter(Boolean))].slice(0, 50);
  }
  return { ...state, settings };
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validates an untrusted document (an import, or the state file itself) and returns a clean State.
 * Throws a ValidationError naming the first invalid field.
 */
export function parseState(document: unknown, nowMs: number): State {
  if (!isRecord(document)) throw new ValidationError('state', 'The document must be a JSON object.');
  if (document['version'] !== STATE_VERSION) {
    throw new ValidationError('version', `Unsupported state version ${String(document['version'])}; expected ${STATE_VERSION}.`);
  }
  let state = emptyState();
  const accounts = document['accounts'] ?? [];
  if (!Array.isArray(accounts)) throw new ValidationError('accounts', 'accounts must be a list.');
  if (accounts.length > 200) throw new ValidationError('accounts', 'At most 200 accounts are supported.');

  const rebuilt: Account[] = [];
  const takenIds = new Set<string>();
  accounts.forEach((raw, accountIndex) => {
    if (!isRecord(raw)) throw new ValidationError(`accounts[${accountIndex}]`, 'Each account must be an object.');
    const meters = raw['meters'];
    if (!Array.isArray(meters) || meters.length === 0) {
      throw new ValidationError(`accounts[${accountIndex}].meters`, 'An account needs at least one meter.');
    }
    const prefix = (error: unknown): never => {
      if (error instanceof ValidationError) {
        throw new ValidationError(`accounts[${accountIndex}].${error.field}`, error.message);
      }
      throw error;
    };
    try {
      const built = addAccount(
        { ...state, accounts: [] },
        {
          providerId: typeof raw['providerId'] === 'string' ? raw['providerId'] : 'custom',
          label: raw['label'] as string,
          plan: raw['plan'] as string | null,
          price: raw['price'] as Price | null,
          usageUrl: raw['usageUrl'] as string | null,
          notes: raw['notes'] as string | null,
          meters: meters.map((meter) => (isRecord(meter) ? (meter as unknown as MeterInput) : ({} as MeterInput)))
        },
        nowMs
      ).account;
      // Keep the document's own ids so references from cycles and external tools stay valid.
      const wantedId = typeof raw['id'] === 'string' && /^[a-z0-9-]{1,48}$/.test(raw['id']) ? raw['id'] : built.id;
      const id = uniqueSlug(wantedId, takenIds);
      takenIds.add(id);
      const restored: Account = {
        ...built,
        id,
        snoozedUntil: instant('snoozedUntil', raw['snoozedUntil']),
        createdAt: instant('createdAt', raw['createdAt']) ?? built.createdAt,
        updatedAt: instant('updatedAt', raw['updatedAt']) ?? built.updatedAt,
        meters: built.meters.map((meter, meterIndex) => {
          const source = meters[meterIndex] as Record<string, unknown>;
          const samples = Array.isArray(source['samples'])
            ? source['samples']
                .filter((sample): sample is { t: string; used: number } =>
                  isRecord(sample) && typeof sample['t'] === 'string' && toMs(sample['t']) !== null && typeof sample['used'] === 'number'
                )
                .slice(-240)
                .map((sample) => ({ t: iso(toMs(sample.t) as number), used: Math.max(0, sample.used) }))
            : [];
          const kind = isRecord(source['source']) ? source['source']['kind'] : undefined;
          const sourceKind: MeterSource['kind'] =
            kind === 'agent' || kind === 'collector' || kind === 'statusline' || kind === 'demo' ? kind : 'manual';
          const meterSource: MeterSource = { kind: sourceKind };
          if (isRecord(source['source']) && typeof source['source']['id'] === 'string') {
            meterSource.id = source['source']['id'].slice(0, 60);
          }
          return {
            ...meter,
            id: `${id}:${meter.key}`,
            source: meterSource,
            updatedAt: instant('updatedAt', source['updatedAt']),
            samples,
            estimated: source['estimated'] === true,
            expired: source['expired'] === true
          };
        })
        .map((meter, meterIndex) => {
          // `note` on the source and `partial` on the meter are optional; keep them when present.
          const source = meters[meterIndex] as Record<string, unknown>;
          const next = { ...meter };
          if (isRecord(source['source']) && typeof source['source']['note'] === 'string') {
            next.source = { ...next.source, note: source['source']['note'].slice(0, 200) };
          }
          return next;
        })
      };
      rebuilt.push(restored);
    } catch (error) {
      prefix(error);
    }
  });
  state = { ...state, accounts: rebuilt };

  const cycles = document['cycles'] ?? [];
  if (!Array.isArray(cycles)) throw new ValidationError('cycles', 'cycles must be a list.');
  state.cycles = cycles
    .filter(
      (cycle): cycle is State['cycles'][number] =>
        isRecord(cycle) &&
        typeof cycle['meterId'] === 'string' &&
        typeof cycle['endedAt'] === 'string' &&
        toMs(cycle['endedAt']) !== null &&
        typeof cycle['limit'] === 'number' &&
        typeof cycle['used'] === 'number' &&
        typeof cycle['wastedFraction'] === 'number'
    )
    .slice(-2000)
    .map((cycle) => ({
      id: String(cycle.id ?? `${cycle.meterId}:${cycle.endedAt}`),
      accountId: String(cycle.accountId ?? ''),
      meterId: cycle.meterId,
      providerId: String(cycle.providerId ?? 'custom'),
      accountLabel: String(cycle.accountLabel ?? '').slice(0, 60),
      meterLabel: String(cycle.meterLabel ?? '').slice(0, 60),
      unit: UNIT_IDS.includes(cycle.unit) ? cycle.unit : 'percent',
      startedAt: toMs(cycle.startedAt) === null ? null : iso(toMs(cycle.startedAt) as number),
      endedAt: iso(toMs(cycle.endedAt) as number),
      limit: cycle.limit,
      used: cycle.used,
      wastedFraction: Math.min(1, Math.max(0, cycle.wastedFraction)),
      wastedValue: typeof cycle.wastedValue === 'number' ? cycle.wastedValue : null,
      currency: typeof cycle.currency === 'string' ? cycle.currency.slice(0, 3).toUpperCase() : null,
      confidence: cycle.confidence === 'measured' ? 'measured' : 'estimated'
    }));

  const spend = document['spend'] ?? [];
  if (!Array.isArray(spend)) throw new ValidationError('spend', 'spend must be a list.');
  state.spend = spend.filter(isRecord).slice(0, 50).map((raw, index) => {
    const label = text(`spend[${index}].label`, raw['label'], 60, true) as string;
    const currency = typeof raw['currency'] === 'string' && /^[A-Za-z]{3}$/.test(raw['currency']) ? raw['currency'].toUpperCase() : 'USD';
    const entries = Array.isArray(raw['entries'])
      ? raw['entries']
          .filter(
            (entry): entry is { date: string; amount: number } =>
              isRecord(entry) && typeof entry['date'] === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(entry['date']) && typeof entry['amount'] === 'number' && entry['amount'] >= 0
          )
          .map((entry) => ({ date: entry.date, amount: entry.amount }))
          .sort((a, b) => (a.date < b.date ? -1 : 1))
          .slice(-400)
      : [];
    const budget = raw['monthlyBudget'];
    // Keep where the figures come from: a collector finds its own spend source again by this id, and
    // would otherwise start a duplicate after an import.
    const from = isRecord(raw['source']) ? raw['source'] : {};
    const kind = from['kind'];
    const source: MeterSource = {
      kind: kind === 'agent' || kind === 'collector' || kind === 'statusline' || kind === 'demo' ? kind : 'manual'
    };
    if (typeof from['id'] === 'string') source.id = from['id'].slice(0, 60);
    if (typeof from['note'] === 'string') source.note = from['note'].slice(0, 200);
    return {
      id: typeof raw['id'] === 'string' && /^[a-z0-9-]{1,48}$/.test(raw['id']) ? raw['id'] : slugify(label),
      providerId: slugify(typeof raw['providerId'] === 'string' ? raw['providerId'] : 'custom'),
      label,
      currency,
      monthlyBudget: typeof budget === 'number' && budget > 0 ? budget : null,
      entries,
      source,
      updatedAt: instant(`spend[${index}].updatedAt`, raw['updatedAt'])
    };
  });

  if (isRecord(document['settings'])) {
    const raw = document['settings'];
    state = updateSettings(state, {
      currency: typeof raw['currency'] === 'string' ? raw['currency'] : 'USD',
      enabledCollectors: Array.isArray(raw['enabledCollectors'])
        ? raw['enabledCollectors'].filter((id): id is string => typeof id === 'string')
        : []
    });
  }
  return rollState(state, nowMs);
}
