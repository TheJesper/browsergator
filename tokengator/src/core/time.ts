// Time helpers. No dependencies: zone maths goes through Intl so it works the same in Node and browsers.

export const MINUTE = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;
/** Mean Gregorian month, used to turn a monthly price into the value of a shorter window. */
export const MONTH = 30.436875 * DAY;

export function toMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
  let formatter = formatters.get(tz);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
    formatters.set(tz, formatter);
  }
  return formatter;
}

/** Wall-clock fields of an instant in a time zone. */
export function zonedParts(ms: number, tz: string): ZonedParts {
  const out: Record<string, number> = {};
  for (const part of formatterFor(tz).formatToParts(new Date(ms))) {
    if (part.type !== 'literal') out[part.type] = Number(part.value);
  }
  return {
    year: out['year'] ?? 1970,
    month: out['month'] ?? 1,
    day: out['day'] ?? 1,
    hour: out['hour'] ?? 0,
    minute: out['minute'] ?? 0,
    second: out['second'] ?? 0
  };
}

/** Offset of a zone from UTC at an instant, in milliseconds (positive east of Greenwich). */
function zoneOffset(ms: number, tz: string): number {
  const p = zonedParts(ms, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/**
 * The instant at which a zone's wall clock reads the given fields. Fields may overflow (day 0, month 13)
 * and are normalised like `Date.UTC`. A wall time skipped by a DST jump resolves to the instant just after it.
 */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  tz: string
): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute, 0);
  // Two passes: the offset at the guess can differ from the offset at the answer across a DST change.
  let guess = wall - zoneOffset(wall, tz);
  guess = wall - zoneOffset(guess, tz);
  return guess;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Parses "HH:MM" (24h). Falls back to midnight for anything malformed. */
export function parseClock(time: string): { hour: number; minute: number } {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!match) return { hour: 0, minute: 0 };
  const hour = clamp(Number(match[1]), 0, 23);
  const minute = clamp(Number(match[2]), 0, 59);
  return { hour, minute };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * A compact countdown: "9m", "3h 12m", "2d 4h", "23d". Two units at most, because nobody plans a month
 * to the minute but the last hour matters to the minute.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return '';
  const negative = ms < 0;
  let rest = Math.abs(ms);
  if (rest < MINUTE) return negative ? 'now' : '<1m';
  const days = Math.floor(rest / DAY);
  rest -= days * DAY;
  const hours = Math.floor(rest / HOUR);
  rest -= hours * HOUR;
  const minutes = Math.floor(rest / MINUTE);
  let text: string;
  if (days >= 10) text = `${days}d`;
  else if (days >= 1) text = hours ? `${days}d ${hours}h` : `${days}d`;
  else if (hours >= 1) text = minutes ? `${hours}h ${minutes}m` : `${hours}h`;
  else text = `${minutes}m`;
  return negative ? `${text} ago` : text;
}

/** "just now", "12m ago", "3h ago", "2d ago". */
export function formatAge(ms: number): string {
  if (!Number.isFinite(ms)) return 'never';
  if (ms < MINUTE) return 'just now';
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m ago`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h ago`;
  return `${Math.floor(ms / DAY)}d ago`;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * A moment as a person would say it, relative to `now`, in the viewer's zone: "today 14:05",
 * "tomorrow 09:00", "Thu 09:00", "Mon 24 Nov 09:00".
 */
export function formatMoment(ms: number, now: number, tz?: string): string {
  const zone = tz ?? localZone();
  const at = zonedParts(ms, zone);
  const today = zonedParts(now, zone);
  const clock = `${pad(at.hour)}:${pad(at.minute)}`;
  const dayIndex = Math.round(
    (Date.UTC(at.year, at.month - 1, at.day) - Date.UTC(today.year, today.month - 1, today.day)) / DAY
  );
  if (dayIndex === 0) return `today ${clock}`;
  if (dayIndex === 1) return `tomorrow ${clock}`;
  if (dayIndex === -1) return `yesterday ${clock}`;
  const weekday = WEEKDAYS[new Date(Date.UTC(at.year, at.month - 1, at.day)).getUTCDay()] ?? '';
  if (dayIndex > 1 && dayIndex < 7) return `${weekday} ${clock}`;
  const month = MONTHS[at.month - 1] ?? '';
  const yearSuffix = at.year === today.year ? '' : ` ${at.year}`;
  return `${weekday} ${at.day} ${month}${yearSuffix} ${clock}`;
}

export function localZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** `YYYY-MM-DD` of an instant in a zone. */
export function dateKey(ms: number, tz?: string): string {
  const p = zonedParts(ms, tz ?? localZone());
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

export const weekdayNames = WEEKDAYS;
export const monthNames = MONTHS;
