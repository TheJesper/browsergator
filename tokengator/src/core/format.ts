// Number, amount and money formatting shared by every interface.

import type { Meter, Unit } from './types.js';
import type { Money } from './forecast.js';

const UNIT_NOUNS: Record<Unit, [singular: string, plural: string]> = {
  percent: ['%', '%'],
  requests: ['request', 'requests'],
  credits: ['credit', 'credits'],
  tokens: ['token', 'tokens'],
  characters: ['character', 'characters'],
  minutes: ['minute', 'minutes'],
  hours: ['hour', 'hours'],
  images: ['image', 'images'],
  usd: ['$', '$'],
  count: ['unit', 'units']
};

export const UNITS: readonly { id: Unit; label: string }[] = [
  { id: 'percent', label: 'Percent only' },
  { id: 'requests', label: 'Requests' },
  { id: 'credits', label: 'Credits' },
  { id: 'tokens', label: 'Tokens' },
  { id: 'characters', label: 'Characters' },
  { id: 'minutes', label: 'Minutes' },
  { id: 'hours', label: 'Hours' },
  { id: 'images', label: 'Images' },
  { id: 'usd', label: 'US dollars' },
  { id: 'count', label: 'Other (name it)' }
];

/** 1284 -> "1,284", 12940 -> "12.9K", 4200000 -> "4.2M". Small numbers keep up to one decimal. */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${trim(value / 1_000_000)}M`;
  if (abs >= 10_000) return `${trim(value / 1_000)}K`;
  if (abs >= 100 || Number.isInteger(value)) return Math.round(value).toLocaleString('en-US');
  return trim(value);
}

function trim(value: number): string {
  return (Math.round(value * 10) / 10).toFixed(1).replace(/\.0$/, '');
}

/** A share 0..1 as a whole percentage. Tiny non-zero shares read "<1%" so they are not mistaken for none. */
export function formatPercent(fraction: number): string {
  if (!Number.isFinite(fraction)) return '0%';
  const pct = fraction * 100;
  if (pct > 0 && pct < 1) return '<1%';
  if (pct > 99 && pct < 100) return '99%';
  return `${Math.round(pct)}%`;
}

export function unitNoun(meter: Pick<Meter, 'unit' | 'unitLabel'>, amount: number): string {
  if (meter.unitLabel && meter.unitLabel.trim()) return meter.unitLabel.trim();
  const [singular, plural] = UNIT_NOUNS[meter.unit];
  return amount === 1 ? singular : plural;
}

/** An amount in the meter's own unit: "62%", "$12.40", "1,240 credits". */
export function formatAmount(meter: Pick<Meter, 'unit' | 'unitLabel'>, amount: number): string {
  if (meter.unit === 'percent') return `${Math.round(amount)}%`;
  if (meter.unit === 'usd') return formatMoney(amount, 'USD');
  return `${formatNumber(amount)} ${unitNoun(meter, amount)}`;
}

const moneyFormatters = new Map<string, Intl.NumberFormat | null>();

export function formatMoney(amount: number, currency: string): string {
  const code = currency.toUpperCase();
  const digits = Math.abs(amount) >= 100 ? 0 : 2;
  const key = `${code}:${digits}`;
  let formatter = moneyFormatters.get(key);
  if (formatter === undefined) {
    try {
      formatter = new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: code,
        currencyDisplay: 'narrowSymbol',
        minimumFractionDigits: digits,
        maximumFractionDigits: digits
      });
    } catch {
      formatter = null; // not an ISO code: fall back to "12.40 XYZ"
    }
    moneyFormatters.set(key, formatter);
  }
  if (formatter) return formatter.format(amount);
  return `${amount.toFixed(digits)} ${code}`;
}

/** Totals per currency, largest first: "$23.10 + 140 kr". Empty totals read as the fallback. */
export function formatMoneyTotals(totals: Money, preferred?: string, fallback = ''): string {
  const entries = Object.entries(totals).filter(([, amount]) => amount > 0.004);
  if (entries.length === 0) return fallback;
  entries.sort(([ca, a], [cb, b]) => {
    if (preferred && ca === preferred) return -1;
    if (preferred && cb === preferred) return 1;
    return b - a;
  });
  return entries.map(([currency, amount]) => formatMoney(amount, currency)).join(' + ');
}

/** "3.5×" with one decimal below ten, whole numbers above, and a ceiling so the absurd reads as absurd. */
export function formatMultiple(multiple: number): string {
  if (!Number.isFinite(multiple) || multiple > 99) return '99×+';
  if (multiple >= 10) return `${Math.round(multiple)}×`;
  return `${trim(multiple)}×`;
}
