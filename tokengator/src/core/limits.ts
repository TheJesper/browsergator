// The bounds every input passes before it can reach the state. They exist so that nothing a person, an
// agent or a provider's API sends can produce a document that will not load again, a calculation that
// overflows, or text that does something on the way out.

/**
 * The largest amount, limit, price or spend figure accepted. No quota is anywhere near it, and everything
 * at or below it survives the arithmetic done on it and a round trip through JSON as the same number.
 */
export const MAX_AMOUNT = 1e12;

/** The smallest limit accepted. Smaller is not a quota anyone tracks, and dividing by it overflows. */
export const MIN_LIMIT = 1e-6;

/** The shortest window accepted: one minute. A window of nearly zero length rolls over without end. */
export const MIN_WINDOW_HOURS = 1 / 60;

/** The longest window accepted: 366 days. */
export const MAX_WINDOW_HOURS = 24 * 366;

/** A finite number from 0 to MAX_AMOUNT. */
export function isAmount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_AMOUNT;
}

/** A finite number from MIN_LIMIT to MAX_AMOUNT. */
export function isLimit(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= MIN_LIMIT && value <= MAX_AMOUNT;
}

// C0 and C1 control characters, the line and paragraph separators, and the characters that reorder or hide
// text. None belongs in a name, and each does something somewhere: an escape sequence in a terminal, a
// carriage return in a calendar line, a NUL in a command argument. Written as escapes inside strings so
// that this file itself contains none of them.
const INVISIBLE = '\\u007f-\\u009f\\u2028\\u2029\\u200b-\\u200f\\u202a-\\u202e\\u2066-\\u2069\\ufeff';
const CONTROL = new RegExp(`[\\u0000-\\u001f${INVISIBLE}]`, 'gu');
const CONTROL_EXCEPT_BREAKS = new RegExp(`[\\u0000-\\u0008\\u000b-\\u001f${INVISIBLE}]`, 'gu');

/** One line of plain text: control characters become spaces, runs of space collapse, the ends are trimmed. */
export function plainLine(value: string): string {
  return value.replace(CONTROL, ' ').replace(/ {2,}/g, ' ').trim();
}

/** Plain text that may span lines (notes): tabs and line feeds are kept, every other control character goes. */
export function plainBlock(value: string): string {
  return value.replace(/\r\n?/g, '\n').replace(CONTROL_EXCEPT_BREAKS, '').trim();
}

// A date and time as ISO 8601 writes it. `Date.parse` alone also accepts "1", "March 7" and whatever else
// the engine feels like reading, and stores the result as if it had been asked for.
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:[Zz]|[+-]\d{2}(?::?\d{2})?)?)?$/;
const EARLIEST = Date.UTC(1990, 0, 1);
const LATEST = Date.UTC(2200, 0, 1);

/**
 * Milliseconds for an ISO 8601 date and time, or null when the text is not one or names a moment no reset
 * will ever fall on. The range also keeps every instant derived from it (a window start, a later boundary)
 * inside what a date can represent.
 */
export function parseInstant(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!ISO_INSTANT.test(text)) return null;
  const ms = Date.parse(text);
  if (!Number.isFinite(ms) || ms < EARLIEST || ms > LATEST) return null;
  return ms;
}
