// Status line input. Claude Code pipes a JSON document to its status line command after every turn; for
// subscribers it carries the 5-hour and 7-day windows. The Antigravity CLI has the same hook. Reading
// either needs no credential and no network: the tool already has the numbers and hands them over.
//
// Shape (code.claude.com/docs/en/statusline):
//   rate_limits.five_hour.used_percentage   number 0..100
//   rate_limits.five_hour.resets_at         Unix seconds
//   rate_limits.seven_day.{used_percentage,resets_at}
// Either window can be absent: before the first response of a session, on plans without that window, or
// once its reset has passed.

import { viewAccount, type MeterView } from '../../core/forecast.js';
import { formatMoney, formatPercent } from '../../core/format.js';
import { formatDuration } from '../../core/time.js';
import type { State } from '../../core/types.js';
import type { TokengatorService } from '../service.js';
import { instant, numeric, record } from './fetch.js';
import type { CollectedMeter } from './types.js';

export const STATUSLINE_COLLECTOR_ID = 'claude-statusline';
export const ANTIGRAVITY_STATUSLINE_ID = 'antigravity-statusline';

export interface StatuslineReading {
  providerId: 'claude' | 'antigravity';
  collectorId: string;
  meters: CollectedMeter[];
}

/** Pulls the rate-limit windows out of Claude Code status line input. Returns an empty list for anything else. */
export function parseStatusline(input: string, nowMs: number): CollectedMeter[] {
  let document: unknown;
  try {
    document = JSON.parse(input);
  } catch {
    return [];
  }
  return claudeMeters(document, nowMs);
}

function claudeMeters(document: unknown, nowMs: number): CollectedMeter[] {
  const limits = record(record(document)?.['rate_limits']);
  if (!limits) return [];
  const meters: CollectedMeter[] = [];
  for (const [field, key] of [
    ['five_hour', 'session'],
    ['seven_day', 'weekly']
  ] as const) {
    const window = record(limits[field]);
    const used = numeric(window?.['used_percentage']);
    if (!window || used === null) continue;
    const reading: CollectedMeter['reading'] = { usedPercent: Math.min(100, Math.max(0, used)) };
    const resetsAt = instant(window['resets_at']);
    // A reset time already behind us describes a window that is over; the percentage alone is still useful.
    if (resetsAt && Date.parse(resetsAt) > nowMs) reading.resetsAt = resetsAt;
    meters.push({ key, reading });
  }
  return meters;
}

// The Antigravity CLI has the same kind of hook (antigravity.google/docs/cli/statusline): it pipes
//   quota.<bucket>.remaining_fraction   number 0..1
//   quota.<bucket>.reset_time           ISO 8601
// with bucket ids such as gemini-weekly, gemini-5h, 3p-weekly and 3p-5h.
function antigravityMeters(document: unknown, nowMs: number): CollectedMeter[] {
  const quota = record(record(document)?.['quota']);
  if (!quota) return [];
  const meters: CollectedMeter[] = [];
  for (const [bucket, raw] of Object.entries(quota).slice(0, 12)) {
    const entry = record(raw);
    const remaining = numeric(entry?.['remaining_fraction']);
    if (!entry || remaining === null || entry['disabled'] === true) continue;
    const key = bucket.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    if (!key) continue;
    const reading: CollectedMeter['reading'] = { remainingPercent: Math.min(100, Math.max(0, remaining * 100)) };
    const resetsAt = instant(entry['reset_time']);
    if (resetsAt && Date.parse(resetsAt) > nowMs) reading.resetsAt = resetsAt;
    meters.push({ key, label: bucket, reading });
  }
  return meters;
}

/** Works out which tool sent the input and what it says. Null when it carries no quota data. */
export function readStatusline(input: string, nowMs: number): StatuslineReading | null {
  let document: unknown;
  try {
    document = JSON.parse(input);
  } catch {
    return null;
  }
  const claude = claudeMeters(document, nowMs);
  if (claude.length > 0) return { providerId: 'claude', collectorId: STATUSLINE_COLLECTOR_ID, meters: claude };
  const antigravity = antigravityMeters(document, nowMs);
  if (antigravity.length > 0) return { providerId: 'antigravity', collectorId: ANTIGRAVITY_STATUSLINE_ID, meters: antigravity };
  return null;
}

function part(view: MeterView, label: string): string {
  const reset = view.msLeft !== null && view.msLeft > 0 ? ` ${formatDuration(view.msLeft)}` : '';
  return `${label} ${formatPercent(view.remainingFraction)} left${reset}`;
}

/** One line for the terminal: the windows of the tool that asked, and anything else that needs using now. */
export function statuslineText(state: State, nowMs: number, providerId: string = 'claude'): string {
  const own = state.accounts.find((account) => account.providerId === providerId);
  const parts: string[] = [];
  if (own) {
    const views = viewAccount(own, nowMs);
    // The first rate window and the first allowance are the two numbers a terminal has room for.
    const session = views.find((view) => view.tier === null && !view.meter.partial && view.msLeft !== null);
    const weekly = views.find((view) => view.tier !== null);
    if (session) parts.push(part(session, shortLabel(session)));
    if (weekly) {
      let text = part(weekly, shortLabel(weekly));
      if (weekly.tier === 'use-now') {
        const money = weekly.valueAtRisk && weekly.currency && weekly.valueAtRisk >= 0.005 ? `, ${formatMoney(weekly.valueAtRisk, weekly.currency)} at risk` : '';
        text += ` (use now${money})`;
      } else if (weekly.tier === 'behind') text += ` (behind pace, ${formatPercent(weekly.projectedUnused)} will expire)`;
      else if (weekly.tier === 'hot') text += ' (running hot)';
      parts.push(text);
    }
  }
  const others = state.accounts
    .filter((account) => account.providerId !== providerId)
    .flatMap((account) => viewAccount(account, nowMs))
    .filter((view) => view.tier === 'use-now' && !view.snoozed)
    .sort((a, b) => (a.msLeft ?? 0) - (b.msLeft ?? 0));
  if (others.length > 0) {
    const first = others[0] as MeterView;
    const more = others.length > 1 ? ` +${others.length - 1}` : '';
    parts.push(`use now: ${first.account.label} ${formatPercent(first.remainingFraction)} left${first.msLeft !== null ? ` ${formatDuration(first.msLeft)}` : ''}${more}`);
  }
  return parts.length > 0 ? parts.join(' · ') : 'tokengator';
}

/** "5h" or "week": the window's length is the shortest honest name for it. */
function shortLabel(view: MeterView): string {
  const hours = view.windowMs === null ? null : view.windowMs / 3_600_000;
  if (hours === null) return view.meter.label.toLowerCase();
  if (hours <= 12) return `${Math.round(hours)}h`;
  if (hours <= 36) return 'day';
  if (hours <= 24 * 10) return 'week';
  return 'month';
}

/**
 * Takes the JSON Claude Code writes to a status line command, records any rate-limit windows it carries,
 * and returns the line to print. Never throws: a status line that fails breaks the user's terminal.
 */
export async function runStatusline(input: string, service: TokengatorService): Promise<string> {
  try {
    const reading = readStatusline(input, service.nowMs());
    if (reading) {
      try {
        await service.applyCollected(reading.collectorId, [{ providerId: reading.providerId, meters: reading.meters }], []);
      } catch {
        // The state file may be locked or read-only; the line below still reflects what is stored.
      }
    }
    return statuslineText(await service.state(), service.nowMs(), reading?.providerId ?? 'claude');
  } catch {
    return 'tokengator';
  }
}
