// Optional pay-as-you-go API cost tracking. Deliberately separate from the waste maths: money spent is
// not quota wasted, and nothing in here feeds tiers, value at risk or the ledger.

import type { MeterSource, SpendSource, State } from './types.js';
import { NotFoundError, ValidationError, slugify } from './accounts.js';
import { dateKey, daysInMonth, iso } from './time.js';

export const MAX_SPEND_DAYS = 400;

export interface SpendSourceInput {
  providerId?: string;
  label: string;
  currency?: string;
  monthlyBudget?: number | null;
}

export interface SpendSummary {
  source: SpendSource;
  /** Spend in the current calendar month. */
  monthToDate: number;
  /** Mean per elapsed day of the month, including today. */
  dailyAverage: number;
  /** Straight-line projection to the end of the month. */
  projected: number;
  /** Share of the budget used, when a budget is set. */
  budgetFraction: number | null;
  overBudget: boolean;
  headingOver: boolean;
  /** Daily totals for the last `days` days, oldest first, zero-filled. */
  series: { date: string; amount: number }[];
  /** Total of the previous calendar month, for comparison. */
  previousMonth: number;
}

function validBudget(value: unknown): number | null {
  if (value === undefined || value === null || value === 0) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new ValidationError('monthlyBudget', 'monthlyBudget must be a number of 0 or more.');
  }
  return value;
}

function validCurrency(value: unknown): string {
  const currency = typeof value === 'string' && value.trim() ? value.trim().toUpperCase() : 'USD';
  if (!/^[A-Z]{3}$/.test(currency)) throw new ValidationError('currency', 'currency must be a three-letter code such as USD.');
  return currency;
}

export function addSpendSource(
  state: State,
  input: SpendSourceInput,
  nowMs: number,
  source: MeterSource = { kind: 'manual' }
): { state: State; source: SpendSource } {
  const label = typeof input.label === 'string' ? input.label.trim() : '';
  if (!label) throw new ValidationError('label', 'label is required.');
  if (label.length > 60) throw new ValidationError('label', 'label must be at most 60 characters.');
  if (state.spend.length >= 50) throw new ValidationError('spend', 'At most 50 spend sources are supported.');
  const taken = new Set(state.spend.map((entry) => entry.id));
  let id = slugify(label);
  for (let n = 2; taken.has(id); n += 1) id = `${slugify(label)}-${n}`;
  const created: SpendSource = {
    id,
    providerId: slugify(input.providerId ?? 'custom'),
    label,
    currency: validCurrency(input.currency),
    monthlyBudget: validBudget(input.monthlyBudget),
    entries: [],
    source,
    updatedAt: iso(nowMs)
  };
  return { state: { ...state, spend: [...state.spend, created] }, source: created };
}

function requireSource(state: State, id: string): SpendSource {
  const source = state.spend.find((entry) => entry.id === id);
  if (!source) throw new NotFoundError(`No spend source with id "${id}".`);
  return source;
}

export function updateSpendSource(
  state: State,
  id: string,
  patch: Partial<Pick<SpendSourceInput, 'label' | 'currency' | 'monthlyBudget'>>
): State {
  const source = requireSource(state, id);
  const next: SpendSource = { ...source };
  if (patch.label !== undefined) {
    const label = patch.label.trim();
    if (!label) throw new ValidationError('label', 'label is required.');
    next.label = label.slice(0, 60);
  }
  if (patch.currency !== undefined) next.currency = validCurrency(patch.currency);
  if ('monthlyBudget' in patch) next.monthlyBudget = validBudget(patch.monthlyBudget);
  return { ...state, spend: state.spend.map((entry) => (entry.id === id ? next : entry)) };
}

export function removeSpendSource(state: State, id: string): State {
  requireSource(state, id);
  return { ...state, spend: state.spend.filter((entry) => entry.id !== id) };
}

/**
 * Records one day's spend. `set` replaces the day's total (what a provider's cost report gives you);
 * `add` adds to it (what a person jotting down a charge wants).
 */
export function recordSpend(
  state: State,
  id: string,
  entry: { date?: string; amount: number; mode?: 'set' | 'add' },
  nowMs: number,
  tz?: string,
  via?: MeterSource
): State {
  const source = requireSource(state, id);
  if (typeof entry.amount !== 'number' || !Number.isFinite(entry.amount) || entry.amount < 0) {
    throw new ValidationError('amount', 'amount must be a number of 0 or more.');
  }
  const date = entry.date ?? dateKey(nowMs, tz);
  // The parser rolls "2026-11-31" over into December instead of refusing it, so compare what comes back:
  // a day the calendar does not have would count towards the month and appear on no day.
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(date) ? Date.parse(`${date}T00:00:00Z`) : Number.NaN;
  if (Number.isNaN(parsed) || iso(parsed).slice(0, 10) !== date) {
    throw new ValidationError('date', 'date must look like 2026-11-19.');
  }
  const entries = source.entries.slice();
  const index = entries.findIndex((existing) => existing.date === date);
  const previous = index >= 0 ? (entries[index]?.amount ?? 0) : 0;
  const amount = entry.mode === 'add' ? previous + entry.amount : entry.amount;
  if (index >= 0) entries[index] = { date, amount };
  else entries.push({ date, amount });
  entries.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const trimmed = entries.length > MAX_SPEND_DAYS ? entries.slice(entries.length - MAX_SPEND_DAYS) : entries;
  const next: SpendSource = { ...source, entries: trimmed, updatedAt: iso(nowMs), source: via ?? source.source };
  return { ...state, spend: state.spend.map((existing) => (existing.id === id ? next : existing)) };
}

export function summariseSpend(source: SpendSource, nowMs: number, tz?: string, days = 30): SpendSummary {
  const today = dateKey(nowMs, tz);
  const monthPrefix = today.slice(0, 7);
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const dayOfMonth = Number(today.slice(8, 10));
  const monthDays = daysInMonth(year, month);

  const previous = new Date(Date.UTC(year, month - 2, 1));
  const previousPrefix = `${previous.getUTCFullYear()}-${String(previous.getUTCMonth() + 1).padStart(2, '0')}`;

  let monthToDate = 0;
  let previousMonth = 0;
  const byDate = new Map<string, number>();
  for (const entry of source.entries) {
    byDate.set(entry.date, entry.amount);
    if (entry.date.startsWith(monthPrefix) && entry.date <= today) monthToDate += entry.amount;
    else if (entry.date.startsWith(previousPrefix)) previousMonth += entry.amount;
  }
  const dailyAverage = dayOfMonth > 0 ? monthToDate / dayOfMonth : 0;
  const projected = dailyAverage * monthDays;
  const budget = source.monthlyBudget;

  const series: SpendSummary['series'] = [];
  const todayUtc = Date.UTC(year, month - 1, dayOfMonth);
  for (let back = days - 1; back >= 0; back -= 1) {
    const date = new Date(todayUtc - back * 86_400_000).toISOString().slice(0, 10);
    series.push({ date, amount: byDate.get(date) ?? 0 });
  }

  return {
    source,
    monthToDate,
    dailyAverage,
    projected,
    budgetFraction: budget ? monthToDate / budget : null,
    overBudget: budget ? monthToDate > budget : false,
    headingOver: budget ? projected > budget : false,
    series,
    previousMonth
  };
}
