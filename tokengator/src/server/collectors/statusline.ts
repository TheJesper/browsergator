// Claude Code status line input. Claude Code pipes a JSON document to its status line command after every
// turn; for subscribers it carries the 5-hour and 7-day windows. Reading it needs no credential and no
// network: Claude Code already has the numbers and hands them over.
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

/** Pulls the rate-limit windows out of status line input. Returns an empty list for anything else. */
export function parseStatusline(input: string, nowMs: number): CollectedMeter[] {
  let document: unknown;
  try {
    document = JSON.parse(input);
  } catch {
    return [];
  }
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

function part(view: MeterView, label: string): string {
  const reset = view.msLeft !== null && view.msLeft > 0 ? ` ${formatDuration(view.msLeft)}` : '';
  return `${label} ${formatPercent(view.remainingFraction)} left${reset}`;
}

/** One line for the terminal: the Claude windows, and anything else that needs using now. */
export function statuslineText(state: State, nowMs: number): string {
  const claude = state.accounts.find((account) => account.providerId === 'claude');
  const parts: string[] = [];
  if (claude) {
    const views = viewAccount(claude, nowMs);
    const weekly = views.find((view) => view.meter.key === 'weekly');
    const session = views.find((view) => view.meter.key === 'session');
    if (session && session.msLeft !== null) parts.push(part(session, '5h'));
    if (weekly) {
      let text = part(weekly, 'week');
      if (weekly.tier === 'use-now') {
        const money = weekly.valueAtRisk && weekly.currency && weekly.valueAtRisk >= 0.005 ? `, ${formatMoney(weekly.valueAtRisk, weekly.currency)} at risk` : '';
        text += ` (use now${money})`;
      } else if (weekly.tier === 'behind') text += ` (behind pace, ${formatPercent(weekly.projectedUnused)} will expire)`;
      else if (weekly.tier === 'hot') text += ' (running hot)';
      parts.push(text);
    }
  }
  const others = state.accounts
    .filter((account) => account.providerId !== 'claude')
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

/**
 * Takes the JSON Claude Code writes to a status line command, records any rate-limit windows it carries,
 * and returns the line to print. Never throws: a status line that fails breaks the user's terminal.
 */
export async function runStatusline(input: string, service: TokengatorService): Promise<string> {
  try {
    const nowMs = service.nowMs();
    const meters = parseStatusline(input, nowMs);
    if (meters.length > 0) {
      try {
        await service.applyCollected(STATUSLINE_COLLECTOR_ID, [{ providerId: 'claude', meters }], []);
      } catch {
        // The state file may be locked or read-only; the line below still reflects what is stored.
      }
    }
    return statuslineText(await service.state(), service.nowMs());
  } catch {
    return 'tokengator';
  }
}
