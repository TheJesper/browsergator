// Reminders: which quotas deserve a nudge right now, and the calendar of upcoming resets.
//
// A reminder exists because quota expires exactly when nobody is looking at the dashboard. The rule is
// deliberately blunt: a quota earns one reminder per window, at the moment it becomes "use now", and never
// again for that window. Anything chattier gets switched off within a week.

import { allowanceQueue, horizonFor, type MeterView } from './forecast.js';
import { nextBoundary, nominalWindowMs, windowLengthMs } from './reset.js';
import { DAY, HOUR, formatDuration, formatMoment, toMs } from './time.js';
import type { State } from './types.js';
import { leftText, riskMoney } from './wording.js';

export interface Reminder {
  /** One per meter per window: the window's end identifies it. */
  key: string;
  meterId: string;
  title: string;
  body: string;
  resetsAtMs: number;
}

/** How many reminder keys to remember. Far more than there are live windows. */
export const MAX_REMINDER_KEYS = 400;
/**
 * Windows shorter than this are never raised outside the dashboard, and get no calendar entry: a session
 * or a daily limit would ring several times a day, which is how reminders get switched off for good.
 */
export const MIN_REMINDER_WINDOW = 2 * DAY;
/**
 * Sources that derive the reset time from "seconds remaining" report it a little differently on every
 * reading. Two reset times this close together are the same window.
 */
const SAME_WINDOW_MS = 30 * 60_000;

export function reminderKey(view: Pick<MeterView, 'id' | 'resetsAtMs'>): string | null {
  return view.resetsAtMs === null ? null : `${view.id}@${view.resetsAtMs}`;
}

function reminderFor(view: MeterView, nowMs: number, tz?: string): Reminder | null {
  const key = reminderKey(view);
  if (key === null || view.resetsAtMs === null) return null;
  if (view.tier !== 'use-now' || view.snoozed) return null;
  if (view.windowMs === null || view.windowMs < MIN_REMINDER_WINDOW) return null;
  // A closed session limit that outlasts the window means there is nothing the person can do about it.
  if (view.blockedUntilMs !== null && view.blockedUntilMs >= view.resetsAtMs) return null;

  const meterName = view.meter.label.charAt(0).toLowerCase() + view.meter.label.slice(1);
  const parts = [`${leftText(view)} of the ${meterName}, resets in ${formatDuration(view.resetsAtMs - nowMs)} (${formatMoment(view.resetsAtMs, nowMs, tz)}).`];
  const money = riskMoney(view);
  if (money) parts.push(`About ${money} expires at this pace.`);
  if (view.blockedUntilMs !== null && view.blockedUntilMs > nowMs) {
    parts.push(`Usable again ${formatMoment(view.blockedUntilMs, nowMs, tz)}${view.blockedBy ? `, when the ${view.blockedBy.toLowerCase()} reopens` : ''}.`);
  }
  if (view.stale) parts.push('The reading is old, so check the real number first.');
  return { key, meterId: view.id, title: `Use ${view.account.label} now`, body: parts.join(' '), resetsAtMs: view.resetsAtMs };
}

/** Every quota that should be raised now and has not been raised for its current window. Most urgent first. */
export function dueReminders(state: State, nowMs: number, sent: readonly string[], tz?: string): Reminder[] {
  const raised = new Map<string, number[]>();
  for (const key of sent) {
    const split = key.lastIndexOf('@');
    const at = Number(key.slice(split + 1));
    if (split <= 0 || !Number.isFinite(at)) continue;
    const meterId = key.slice(0, split);
    raised.set(meterId, [...(raised.get(meterId) ?? []), at]);
  }
  const due: Reminder[] = [];
  for (const view of allowanceQueue(state, nowMs)) {
    const reminder = reminderFor(view, nowMs, tz);
    if (!reminder) continue;
    const already = raised.get(reminder.meterId)?.some((at) => Math.abs(at - reminder.resetsAtMs) <= SAME_WINDOW_MS) ?? false;
    if (!already) due.push(reminder);
  }
  return due;
}

/** Folds several reminders into one message, so three quotas ending together make one notification. */
export function digestReminders(reminders: readonly Reminder[]): { title: string; body: string } | null {
  const first = reminders[0];
  if (!first) return null;
  if (reminders.length === 1) return { title: first.title, body: first.body };
  const shown = reminders.slice(0, 3).map((reminder) => `${reminder.title.replace(/^Use | now$/g, '')}: ${reminder.body.split('. ')[0]?.replace(/\.$/, '') ?? ''}.`);
  const rest = reminders.length - shown.length;
  return { title: `${reminders.length} quotas to use now`, body: [...shown, rest > 0 ? `And ${rest} more.` : ''].filter(Boolean).join('\n') };
}

/** The remembered keys plus the new ones, without those whose window has ended, capped. */
export function rememberReminders(sent: readonly string[], fresh: readonly string[], nowMs: number): string[] {
  const live = [...new Set([...sent, ...fresh])].filter((key) => {
    const at = Number(key.slice(key.lastIndexOf('@') + 1));
    return Number.isFinite(at) && at > nowMs;
  });
  return live.slice(-MAX_REMINDER_KEYS);
}

// ---------------------------------------------------------------------------
// Calendar (iCalendar, RFC 5545)
// ---------------------------------------------------------------------------

export interface CalendarOptions {
  /** How far ahead to list resets. */
  daysAhead?: number;
  /** Where the dashboard lives, for the event description. */
  dashboardUrl?: string;
}

const MAX_EVENTS_PER_METER = 14;

const stamp = (ms: number): string => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

const escapeText = (text: string): string => text.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

/** Lines longer than 75 octets continue on the next line after a space. Counts bytes, not characters. */
function fold(line: string): string {
  const out: string[] = [];
  let current = '';
  let bytes = 0;
  for (const char of line) {
    const size = char.codePointAt(0)! <= 0x7f ? 1 : char.codePointAt(0)! <= 0x7ff ? 2 : char.codePointAt(0)! <= 0xffff ? 3 : 4;
    const limit = out.length === 0 ? 75 : 74;
    if (bytes + size > limit) {
      out.push(current);
      current = '';
      bytes = 0;
    }
    current += char;
    bytes += size;
  }
  out.push(current);
  return out.join('\r\n ');
}

/** Upcoming ends of a meter's windows: the one it is in, then those its rule alone determines. */
function upcomingResets(view: MeterView, nowMs: number, untilMs: number): number[] {
  const first = toMs(view.meter.resetsAt);
  if (first === null || first <= nowMs || first > untilMs) return [];
  const resets = [first];
  const rule = view.meter.reset;
  while (resets.length < MAX_EVENTS_PER_METER) {
    const last = resets[resets.length - 1] as number;
    // A rolling window opens on first use, so only the current one has a known end.
    const next = rule.kind === 'interval' ? last + rule.hours * HOUR : rule.kind === 'daily' || rule.kind === 'monthly' ? nextBoundary(rule, last) : null;
    if (next === null || next > untilMs) break;
    resets.push(next);
  }
  return resets;
}

/**
 * An iCalendar feed with one entry per upcoming reset of every expiring quota. Each entry covers the last
 * stretch before the reset, the same stretch the dashboard calls "use now", and rings when it begins.
 * The entries say what resets, not how much is left: a calendar copy is always older than the dashboard.
 */
export function calendarFeed(state: State, nowMs: number, options: CalendarOptions = {}): string {
  const untilMs = nowMs + (options.daysAhead ?? 62) * DAY;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Tokengator//Quota resets//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:Tokengator resets',
    'X-WR-CALDESC:When prepaid AI quota expires',
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H'
  ];
  for (const view of allowanceQueue(state, nowMs, 'reset')) {
    // Carried-over quota does not expire at its reset, and a balance has no reset at all.
    if (view.meter.rollover !== 'none' || view.snoozed) continue;
    const length = windowLengthMs(view.meter) ?? nominalWindowMs(view.meter.reset);
    if (length === null || length < MIN_REMINDER_WINDOW) continue;
    const lead = horizonFor(length);
    const meterName = view.meter.label.charAt(0).toLowerCase() + view.meter.label.slice(1);
    for (const resetMs of upcomingResets(view, nowMs, untilMs)) {
      const description = [
        `The ${meterName} of ${view.account.label} resets at the end of this entry. Whatever is left then expires.`,
        options.dashboardUrl ? `What is left right now: ${options.dashboardUrl}` : '',
        view.account.usageUrl ? `Usage page: ${view.account.usageUrl}` : ''
      ]
        .filter(Boolean)
        .join('\n');
      lines.push(
        'BEGIN:VEVENT',
        `UID:${view.id.replace(/[^A-Za-z0-9:._-]/g, '-')}-${stamp(resetMs)}@tokengator`,
        `DTSTAMP:${stamp(nowMs)}`,
        `DTSTART:${stamp(Math.max(nowMs, resetMs - lead))}`,
        `DTEND:${stamp(resetMs)}`,
        `SUMMARY:${escapeText(`Use up ${view.account.label}: ${meterName} resets`)}`,
        `DESCRIPTION:${escapeText(description)}`,
        'TRANSP:TRANSPARENT',
        'BEGIN:VALARM',
        'ACTION:DISPLAY',
        `DESCRIPTION:${escapeText(`${view.account.label}: ${meterName} resets in ${formatDuration(lead)}`)}`,
        'TRIGGER:PT0S',
        'END:VALARM',
        'END:VEVENT'
      );
    }
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(fold).join('\r\n')}\r\n`;
}
