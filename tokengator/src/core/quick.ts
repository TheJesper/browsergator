// Quick entry: one line such as "claude weekly 62%" or "suno 1200 left resets in 9d" becomes a reading.
// The same parser backs the dashboard field, `tokengator set` and the MCP `quick_update` tool.
//
//   entry   := account [meter] amount [reset]
//   amount  := N% [used|left] | N [used|left] | N/M
//   reset   := ("resets" | "reset" | "until" | "ends") when | "in" duration
//   when    := duration | weekday [clock] | "today"|"tomorrow" [clock] | clock | date [clock]

import type { Account, Meter, Reading, State } from './types.js';
import { formatAmount, formatPercent } from './format.js';
import {
  DAY,
  HOUR,
  MINUTE,
  formatDuration,
  formatMoment,
  iso,
  localZone,
  monthNames,
  weekdayNames,
  zonedParts,
  zonedTimeToUtc
} from './time.js';

export interface QuickCandidate {
  accountId: string;
  meterId: string | null;
  label: string;
}

export type QuickResult =
  | { ok: true; account: Account; meter: Meter; reading: Reading; preview: string }
  | { ok: false; error: string; candidates: QuickCandidate[] };

const AMOUNT = /^\$?(\d[\d,]*(?:\.\d+)?)([kKmM]?)(%?)$/;
const RATIO = /^\$?(\d[\d,]*(?:\.\d+)?)([kKmM]?)\/\$?(\d[\d,]*(?:\.\d+)?)([kKmM]?)$/;
const RESET_WORDS = new Set(['resets', 'reset', 'until', 'ends', 'renews', 'expires']);
const LEFT_WORDS = new Set(['left', 'remaining', 'remain', 'free', 'unused']);
const USED_WORDS = new Set(['used', 'spent', 'consumed', 'gone']);

function scale(digits: string, suffix: string): number {
  const base = Number(digits.replace(/,/g, ''));
  if (suffix === 'k' || suffix === 'K') return base * 1_000;
  if (suffix === 'm' || suffix === 'M') return base * 1_000_000;
  return base;
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * True when every token is the start of a different word. Each word can be claimed once: on an account
 * "Max Plan" the line "max plan max" has one "max" too many for the name, so the last one is left over
 * for the meter instead of being swallowed.
 */
function matches(tokens: string[], haystack: string[]): boolean {
  const pool = [...new Set(haystack)];
  const take = (index: number, free: string[]): boolean => {
    if (index === tokens.length) return true;
    const token = tokens[index] as string;
    return free.some((word, at) => word.startsWith(token) && take(index + 1, [...free.slice(0, at), ...free.slice(at + 1)]));
  };
  return take(0, pool);
}

/** Finds a meter inside one account by key, label or unambiguous words. Used when the account is already known. */
export function resolveMeterIn(
  account: Account,
  meterName: string
): { ok: true; meter: Meter } | { ok: false; error: string; candidates: QuickCandidate[] } {
  const wanted = meterName.trim();
  const tokens = words(wanted);
  const all = (): QuickCandidate[] => account.meters.map((meter) => ({ accountId: account.id, meterId: meter.id, label: `${account.label}, ${meter.label}` }));
  if (tokens.length === 0) {
    const meter = defaultMeter(account);
    return meter ? { ok: true, meter } : { ok: false, error: `${account.label} has no meters.`, candidates: [] };
  }
  const exact = account.meters.filter((meter) => meter.id === wanted || meter.key === tokens.join('-') || meter.label.toLowerCase() === wanted.toLowerCase());
  if (exact.length === 1) return { ok: true, meter: exact[0] as Meter };
  const loose = account.meters.filter((meter) => matches(tokens, meterWords(meter)));
  if (loose.length === 1) return { ok: true, meter: loose[0] as Meter };
  return {
    ok: false,
    error: loose.length === 0 ? `${account.label} has no meter matching "${wanted}".` : `"${wanted}" matches more than one meter of ${account.label}.`,
    candidates: loose.length === 0 ? all() : loose.map((meter) => ({ accountId: account.id, meterId: meter.id, label: `${account.label}, ${meter.label}` }))
  };
}

function accountWords(account: Account): string[] {
  return [...words(account.label), ...words(account.providerId), ...words(account.plan ?? ''), ...words(account.id)];
}

function meterWords(meter: Meter): string[] {
  return [...words(meter.label), ...words(meter.key)];
}

/** The meter a bare account name refers to: its first allowance that carries value, else its first meter. */
export function defaultMeter(account: Account): Meter | null {
  const allowances = account.meters.filter((meter) => meter.role === 'allowance');
  return allowances.find((meter) => meter.valueShare > 0) ?? allowances[0] ?? account.meters[0] ?? null;
}

interface Resolved {
  account: Account;
  meter: Meter;
  /** Higher is a tighter match. */
  score: number;
}

/**
 * Finds the account and meter a list of name tokens refers to. Exposed for the MCP and HTTP layers, which
 * accept the same loose naming ("claude", "claude weekly", an id).
 */
export function resolveTarget(
  state: State,
  nameTokens: string[]
): { ok: true; account: Account; meter: Meter } | { ok: false; error: string; candidates: QuickCandidate[] } {
  // Split on punctuation too, so an id such as "claude-max" matches the same way its label does.
  const tokens = words(nameTokens.join(' '));
  if (tokens.length === 0) return { ok: false, error: 'Name an account first.', candidates: allCandidates(state) };

  // An exact meter id short-circuits everything else.
  const joined = nameTokens.join(' ').trim();
  for (const account of state.accounts) {
    const byId = account.meters.find((meter) => meter.id === joined);
    if (byId) return { ok: true, account, meter: byId };
  }

  const found: Resolved[] = [];
  for (let split = tokens.length; split >= 1; split -= 1) {
    const accountTokens = tokens.slice(0, split);
    const meterTokens = tokens.slice(split);
    for (const account of state.accounts) {
      if (!matches(accountTokens, accountWords(account))) continue;
      const exactAccount = account.id === accountTokens.join('-') || account.label.toLowerCase() === accountTokens.join(' ');
      if (meterTokens.length === 0) {
        const meter = defaultMeter(account);
        if (meter) found.push({ account, meter, score: split * 10 + (exactAccount ? 5 : 0) });
        continue;
      }
      for (const meter of account.meters) {
        if (!matches(meterTokens, meterWords(meter))) continue;
        const exactMeter = meter.key === meterTokens.join('-') || meter.label.toLowerCase() === meterTokens.join(' ');
        found.push({ account, meter, score: split * 10 + (exactAccount ? 5 : 0) + (exactMeter ? 3 : 0) + 1 });
      }
    }
    if (found.length > 0) break; // the longest account match wins; shorter splits are only fallbacks
  }

  if (found.length === 0) {
    return {
      ok: false,
      error: `No account matches "${nameTokens.join(' ')}".`,
      candidates: allCandidates(state)
    };
  }
  const best = Math.max(...found.map((entry) => entry.score));
  const top = found.filter((entry) => entry.score === best);
  const unique = new Map(top.map((entry) => [entry.meter.id, entry]));
  if (unique.size > 1) {
    return {
      ok: false,
      error: `"${nameTokens.join(' ')}" matches more than one meter. Add a word to tell them apart.`,
      candidates: [...unique.values()].map((entry) => ({
        accountId: entry.account.id,
        meterId: entry.meter.id,
        label: `${entry.account.label}, ${entry.meter.label}`
      }))
    };
  }
  const only = top[0] as Resolved;
  return { ok: true, account: only.account, meter: only.meter };
}

function allCandidates(state: State): QuickCandidate[] {
  return state.accounts.slice(0, 12).map((account) => ({ accountId: account.id, meterId: null, label: account.label }));
}

// ---------------------------------------------------------------------------
// "when" expressions
// ---------------------------------------------------------------------------

const DURATION_PART = /(\d+(?:\.\d+)?)\s*(w|wk|wks|week|weeks|d|day|days|h|hr|hrs|hour|hours|m|min|mins|minute|minutes)(?![a-z])/g;

/** "3h20m", "2d 4h", "45 min", "1w" -> milliseconds. Null when the text is not purely a duration. */
export function parseDuration(text: string): number | null {
  const source = text.trim().toLowerCase();
  if (!source) return null;
  let total = 0;
  let consumed = 0;
  DURATION_PART.lastIndex = 0;
  for (let match = DURATION_PART.exec(source); match; match = DURATION_PART.exec(source)) {
    const amount = Number(match[1]);
    const unit = (match[2] as string)[0];
    total += amount * (unit === 'w' ? 7 * DAY : unit === 'd' ? DAY : unit === 'h' ? HOUR : MINUTE);
    consumed += match[0].length;
  }
  if (consumed === 0) return null;
  // Anything besides the matched parts and separators means this was not a plain duration.
  if (source.replace(DURATION_PART, '').replace(/[\s,]|and/g, '') !== '') return null;
  return total;
}

function parseClockLoose(text: string): { hour: number; minute: number } | null {
  const match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(text.trim().toLowerCase());
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = match[2] ? Number(match[2]) : 0;
  const meridiem = match[3];
  if (!meridiem && !match[2]) return null; // a bare "9" is not a time
  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

/**
 * Parses a reset time relative to `nowMs`, read in `tz` (the viewer's zone by default). Returns a UTC instant
 * strictly in the future, or null when the text is not understood.
 */
export function parseWhen(text: string, nowMs: number, tz: string = localZone()): number | null {
  const stripped = text.trim().replace(/^(in|at|on)\s+/i, '');
  const source = stripped.toLowerCase();
  if (!source) return null;

  const duration = parseDuration(source);
  if (duration !== null) return duration > 0 ? nowMs + duration : null;

  // Full ISO instants with an offset are unambiguous; let the platform read them.
  if (/^\d{4}-\d{2}-\d{2}t\d{2}:\d{2}(:\d{2}(\.\d+)?)?(z|[+-]\d{2}:?\d{2})$/.test(source)) {
    const ms = Date.parse(stripped);
    return Number.isFinite(ms) && ms > nowMs ? ms : null;
  }

  const today = zonedParts(nowMs, tz);
  const future = (ms: number): number | null => (ms > nowMs ? ms : null);

  // ISO date with an optional local clock: "2026-11-21", "2026-11-21 09:00", "2026-11-21T09:00"
  const isoDate = /^(\d{4})-(\d{2})-(\d{2})(?:[t\s]+(.+))?$/.exec(source);
  if (isoDate) {
    const clock = isoDate[4] ? parseClockLoose(isoDate[4]) : { hour: 0, minute: 0 };
    if (!clock) return null;
    return future(zonedTimeToUtc(Number(isoDate[1]), Number(isoDate[2]), Number(isoDate[3]), clock.hour, clock.minute, tz));
  }

  const parts = source.split(/[\s,]+/).filter(Boolean);
  const head = parts[0] ?? '';
  const rest = parts.slice(1).join(' ');
  const clockOf = (fallbackMidnight: boolean): { hour: number; minute: number } | null => {
    if (!rest) return fallbackMidnight ? { hour: 0, minute: 0 } : null;
    return parseClockLoose(rest);
  };

  if (head === 'today' || head === 'tonight') {
    const clock = rest ? parseClockLoose(rest) : { hour: 23, minute: 59 };
    if (!clock) return null;
    return future(zonedTimeToUtc(today.year, today.month, today.day, clock.hour, clock.minute, tz));
  }
  if (head === 'tomorrow' || head === 'tmrw') {
    const clock = clockOf(true);
    if (!clock) return null;
    return zonedTimeToUtc(today.year, today.month, today.day + 1, clock.hour, clock.minute, tz);
  }

  const weekday = weekdayNames.findIndex((name) => head.startsWith(name.toLowerCase()) && head.length >= 3);
  if (weekday >= 0 && /^[a-z]+$/.test(head)) {
    const clock = clockOf(true);
    if (!clock) return null;
    const todayIndex = new Date(Date.UTC(today.year, today.month - 1, today.day)).getUTCDay();
    for (let ahead = 0; ahead <= 7; ahead += 1) {
      if ((todayIndex + ahead) % 7 !== weekday) continue;
      const candidate = zonedTimeToUtc(today.year, today.month, today.day + ahead, clock.hour, clock.minute, tz);
      if (candidate > nowMs) return candidate;
    }
    return null;
  }

  // "nov 21 [clock]" or "21 nov [clock]"
  const monthOf = (word: string): number =>
    word.length >= 3 ? monthNames.findIndex((name) => word.startsWith(name.toLowerCase())) : -1;
  let month = -1;
  let day = Number.NaN;
  let clockText = '';
  if (monthOf(head) >= 0 && /^\d{1,2}$/.test(parts[1] ?? '')) {
    month = monthOf(head);
    day = Number(parts[1]);
    clockText = parts.slice(2).join(' ');
  } else if (/^\d{1,2}$/.test(head) && monthOf(parts[1] ?? '') >= 0) {
    month = monthOf(parts[1] as string);
    day = Number(head);
    clockText = parts.slice(2).join(' ');
  }
  if (month >= 0 && day >= 1 && day <= 31) {
    const clock = clockText ? parseClockLoose(clockText) : { hour: 0, minute: 0 };
    if (!clock) return null;
    const thisYear = zonedTimeToUtc(today.year, month + 1, day, clock.hour, clock.minute, tz);
    return thisYear > nowMs ? thisYear : zonedTimeToUtc(today.year + 1, month + 1, day, clock.hour, clock.minute, tz);
  }

  // A bare clock time: the next time the clock reads it.
  const clock = parseClockLoose(source);
  if (clock) {
    const todayAt = zonedTimeToUtc(today.year, today.month, today.day, clock.hour, clock.minute, tz);
    return todayAt > nowMs ? todayAt : zonedTimeToUtc(today.year, today.month, today.day + 1, clock.hour, clock.minute, tz);
  }
  return null;
}

// ---------------------------------------------------------------------------
// The entry line
// ---------------------------------------------------------------------------

interface AmountSuffix {
  left: boolean;
  limit: number | null;
}

/** The words allowed after an amount: used/left markers and "of <limit>". Null when anything else follows. */
function readSuffix(after: string[]): AmountSuffix | null {
  let left = false;
  let limit: number | null = null;
  for (let index = 0; index < after.length; index += 1) {
    const word = (after[index] as string).toLowerCase();
    if (LEFT_WORDS.has(word)) left = true;
    else if (USED_WORDS.has(word)) continue;
    else if (word === 'of' && index + 1 < after.length) {
      const match = AMOUNT.exec(after[index + 1] as string);
      if (!match || match[3] === '%') return null;
      limit = scale(match[1] as string, match[2] as string);
      index += 1;
    } else return null;
  }
  return { left, limit };
}

export function parseQuick(text: string, state: State, nowMs: number, tz: string = localZone()): QuickResult {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return { ok: false, error: 'Type an account and an amount, for example "claude 62%".', candidates: allCandidates(state) };
  }

  // The reset clause starts at the first reset word.
  let resetAt = tokens.findIndex((token) => RESET_WORDS.has(token.toLowerCase()));
  let clauseEnd = resetAt >= 0 ? resetAt : tokens.length;

  // The amount is the first number whose trailing words make sense. Starting the search at 1 keeps a
  // number that is part of a name ("plan 5 62%") from being read as the amount.
  const findAmount = (end: number): { index: number; suffix: AmountSuffix } | null => {
    for (let index = 1; index < end; index += 1) {
      const token = tokens[index] as string;
      if (!AMOUNT.test(token) && !RATIO.test(token)) continue;
      const suffix = readSuffix(tokens.slice(index + 1, end));
      if (suffix) return { index, suffix };
    }
    return null;
  };

  let amount = findAmount(clauseEnd);
  if (resetAt < 0) {
    // "suno 1200 left in 9d": without a reset word, "in" opens the reset clause.
    const inIndex = tokens.findIndex((token, index) => index > 0 && token.toLowerCase() === 'in');
    if (inIndex >= 0) {
      const withIn = findAmount(inIndex);
      if (withIn || !amount) {
        amount = withIn;
        resetAt = inIndex;
        clauseEnd = inIndex;
      }
    }
  }

  if (!amount && resetAt < 0) {
    const stray = tokens.slice(1).some((token) => AMOUNT.test(token) || RATIO.test(token));
    if (stray) {
      return {
        ok: false,
        error: 'Did not understand the words after the amount. Use "used" or "left", then optionally "resets <when>".',
        candidates: []
      };
    }
  }

  const nameEnd = amount ? amount.index : clauseEnd;
  const target = resolveTarget(state, tokens.slice(0, nameEnd));
  if (!target.ok) return target;
  const { account, meter } = target;

  const reading: Reading = {};
  if (amount) {
    const token = tokens[amount.index] as string;
    const { left, limit } = amount.suffix;
    const ratio = RATIO.exec(token);
    if (ratio) {
      const value = scale(ratio[1] as string, ratio[2] as string);
      reading.limit = scale(ratio[3] as string, ratio[4] as string);
      if (!(reading.limit > 0)) return { ok: false, error: 'The limit after the slash must be greater than 0.', candidates: [] };
      if (left) reading.remaining = value;
      else reading.used = value;
    } else {
      const match = AMOUNT.exec(token) as RegExpExecArray;
      const value = scale(match[1] as string, match[2] as string);
      // On a percent-only meter a bare number can only be a percentage, unless "of N" says what it counts.
      const isPercent = match[3] === '%' || (meter.unit === 'percent' && limit === null);
      if (isPercent) {
        if (value > 100) return { ok: false, error: 'A percentage must be between 0 and 100.', candidates: [] };
        if (left) reading.remainingPercent = value;
        else reading.usedPercent = value;
      } else if (left) reading.remaining = value;
      else reading.used = value;
    }
    // The limit stays on the reading even for a percent-only meter: it is what turns "45/200" into 22.5%.
    if (limit !== null) reading.limit = limit;
  }

  if (resetAt >= 0) {
    const first = (tokens[resetAt] as string).toLowerCase();
    const whenText = tokens.slice(first === 'in' ? resetAt : resetAt + 1).join(' ');
    const when = parseWhen(whenText, nowMs, tz);
    if (when === null) {
      return {
        ok: false,
        error: `Did not understand the reset time "${whenText}". Try "in 3h", "thu 09:00", "tomorrow 9am" or "2026-11-21 09:00".`,
        candidates: []
      };
    }
    reading.resetsAt = iso(when);
  }

  if (!amount && resetAt < 0) {
    return {
      ok: false,
      error: `Add an amount for ${account.label}, for example "${words(account.label)[0] ?? 'name'} 62%" or "1200 left".`,
      candidates: []
    };
  }

  return { ok: true, account, meter, reading, preview: previewReading(account, meter, reading, nowMs, tz) };
}

/** How the line was understood, spelling out both used and left so a wrong guess is caught before saving. */
export function previewReading(account: Account, meter: Meter, reading: Reading, nowMs: number, tz?: string): string {
  const limit = reading.limit ?? meter.limit;
  let used: number | null = null;
  if (reading.used !== undefined) used = reading.used;
  else if (reading.remaining !== undefined) used = Math.max(0, limit - reading.remaining);
  else if (reading.usedPercent !== undefined) used = (reading.usedPercent / 100) * limit;
  else if (reading.remainingPercent !== undefined) used = (1 - reading.remainingPercent / 100) * limit;

  const parts: string[] = [];
  if (used !== null && limit > 0) {
    const usedFraction = Math.min(1, used / limit);
    if (meter.unit === 'percent') {
      // Round once and derive the other side, so "77.5%" never previews as "78% used, 23% left".
      const usedPct = Math.round(usedFraction * 100);
      parts.push(`${usedPct}% used, ${100 - usedPct}% left`);
    } else {
      const probe = { unit: meter.unit, unitLabel: meter.unitLabel };
      parts.push(
        `${formatAmount(probe, used)} used, ${formatAmount(probe, Math.max(0, limit - used))} left (${formatPercent(1 - usedFraction)})`
      );
    }
  }
  if (reading.resetsAt) {
    const at = Date.parse(reading.resetsAt);
    parts.push(`resets ${formatMoment(at, nowMs, tz)} (in ${formatDuration(at - nowMs)})`);
  }
  return `${account.label}, ${meter.label}: ${parts.join(', ')}`;
}
