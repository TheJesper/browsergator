// Terminal rendering. Pure functions: state and options in, text out. Nothing here reads the clock,
// the environment or the terminal, so every layout can be tested as a string.
//
// The output has to read the same piped to a file as on screen. Colour is therefore only ever an
// addition: the three parts of a forecast bar use three different characters, every state is spelled
// out, and column widths are computed on the visible text so escape codes never shift a column.

import { CATEGORY_LABEL, type ProviderCategory, type ProviderPreset } from '../core/catalog-types.js';
import { CONNECT_GROUP_LABEL, type ConnectSnippet } from '../core/connect.js';
import { TIER_ORDER, sortViews, summarise, viewState, type MeterView, type Tier } from '../core/forecast.js';
import { formatMoney, formatMoneyTotals, formatPercent } from '../core/format.js';
import { formatAge, formatDuration } from '../core/time.js';
import type { Price, State } from '../core/types.js';
import { TIER_HINT, TIER_LABEL, stateLabel, summaryLine } from '../core/wording.js';

export type ColorMode = 'none' | '256' | 'truecolor';

export const BAR_CELLS = 20;
/** Quota already used: a fact, so it is solid. */
export const BAR_USED = '█';
/** Quota that will be used by the reset at the current pace. */
export const BAR_PROJECTED = '▒';
/** Quota that will expire unused. The lightest shade: it is the part that will not be there. */
export const BAR_EXPIRING = '░';
/** The rest of a bar that has no forecast. */
export const BAR_TRACK = '·';

/** The tiers a person can still act on. Everything else is shown only when asked for. */
export const ACTIVE_TIERS: readonly Tier[] = ['use-now', 'behind', 'hot', 'on-pace', 'fresh'];

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

type Tone = 'used' | 'expiring' | 'muted' | 'hot' | 'ok' | 'stop';

// Mid-tones on purpose: a terminal may be light or dark, and these hold up on both. They follow the
// dashboard's rule that colour means state: blue is used, orange is expiring, and nothing else is loud.
const TRUECOLOR: Record<Tone, string> = {
  used: '38;2;111;177;214',
  expiring: '38;2;222;138;90',
  muted: '38;2;128;141;144',
  hot: '38;2;201;169;79',
  ok: '38;2;122;176;138',
  stop: '38;2;208;106;142'
};

/** The nearest entries of the 256-colour palette, for terminals without 24-bit colour. */
const INDEXED: Record<Tone, string> = {
  used: '38;5;74',
  expiring: '38;5;173',
  muted: '38;5;245',
  hot: '38;5;179',
  ok: '38;5;108',
  stop: '38;5;168'
};

function paint(text: string, tone: Tone | null, mode: ColorMode, bold = false): string {
  if (mode === 'none' || text === '' || (tone === null && !bold)) return text;
  const codes = [bold ? '1' : '', tone === null ? '' : (mode === 'truecolor' ? TRUECOLOR : INDEXED)[tone]].filter(Boolean).join(';');
  return `\x1b[${codes}m${text}\x1b[0m`;
}

/**
 * Colour is used only on a terminal, and never when NO_COLOR is set or --no-color was given. The depth
 * comes from the stream when it can say, so a terminal without 24-bit colour gets the indexed palette
 * instead of garbage.
 */
export function colorMode(
  stream: { isTTY?: boolean; getColorDepth?: (env?: NodeJS.ProcessEnv) => number },
  env: NodeJS.ProcessEnv,
  disabled = false
): ColorMode {
  if (disabled || stream.isTTY !== true || env['NO_COLOR'] !== undefined || env['TERM'] === 'dumb') return 'none';
  let depth: number;
  try {
    depth = stream.getColorDepth ? stream.getColorDepth(env) : /^(truecolor|24bit)$/i.test(env['COLORTERM'] ?? '') ? 24 : 8;
  } catch {
    depth = 8;
  }
  if (depth >= 24) return 'truecolor';
  return depth >= 8 ? '256' : 'none';
}

// ---------------------------------------------------------------------------
// Widths
// ---------------------------------------------------------------------------

// eslint-disable-next-line no-control-regex -- matching the escape character is the point
const ANSI = /\x1b\[[0-9;]*m/g;

/** Length as a terminal shows it: escape codes take no room and a character outside the BMP is one cell. */
export function visibleLength(text: string): number {
  return [...text.replace(ANSI, '')].length;
}

export function padEnd(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - visibleLength(text)));
}

export function padStart(text: string, width: number): string {
  return ' '.repeat(Math.max(0, width - visibleLength(text))) + text;
}

/** Shortens plain text to a width, ending in an ellipsis when something was cut. */
export function truncate(text: string, width: number): string {
  const chars = [...text];
  if (chars.length <= width) return text;
  if (width <= 1) return chars.slice(0, Math.max(0, width)).join('');
  return `${chars.slice(0, width - 1).join('').trimEnd()}…`;
}

/** Aligns rows of cells into columns. Trailing blanks are dropped so piped output has none. */
export function columns(rows: readonly (readonly string[])[], gap = 2, indent = 0): string[] {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] ?? 0, visibleLength(cell));
    });
  }
  return rows.map((row) =>
    (' '.repeat(indent) + row.map((cell, index) => padEnd(cell, widths[index] ?? 0)).join(' '.repeat(gap))).trimEnd()
  );
}

// ---------------------------------------------------------------------------
// The forecast bar
// ---------------------------------------------------------------------------

/** True for the tiers whose bar shows a forecast rather than only what has been used. */
function hasForecast(view: MeterView): boolean {
  return (
    view.projectedFraction !== null &&
    (view.tier === 'use-now' || view.tier === 'behind' || view.tier === 'hot' || view.tier === 'on-pace')
  );
}

/**
 * One meter as a row of cells: used, then what the current pace will still use, then what will expire.
 * Meters without a forecast show what is used against a plain track.
 */
export function forecastBar(view: MeterView, mode: ColorMode = 'none', cells = BAR_CELLS): string {
  let used = Math.min(cells, Math.max(0, Math.round(view.usedFraction * cells)));
  // Anything used at all gets a cell, and anything left keeps one: a bar must not round a small
  // amount away into "untouched" or "finished".
  if (used === 0 && view.usedFraction > 0) used = 1;
  if (used === cells && view.remainingFraction >= 0.02) used = cells - 1;

  let projected = used;
  let tail = BAR_TRACK;
  let tailTone: Tone = 'muted';
  if (hasForecast(view)) {
    projected = Math.min(cells, Math.max(used, Math.round((view.projectedFraction ?? 0) * cells)));
    if (view.projectedUnused > 0) {
      tail = BAR_EXPIRING;
      tailTone = 'expiring';
      // The expiring share is why the row is on screen; it never rounds down to nothing.
      if (projected === cells && view.projectedUnused >= 0.02) projected = Math.max(used, cells - 1);
    }
  } else if (view.tier === 'expired' && view.remainingFraction > 0.005) {
    tail = BAR_EXPIRING;
    tailTone = 'expiring';
  }

  // Used and projected share one colour, the hue for "quota that gets used"; the shade tells them apart.
  return paint(BAR_USED.repeat(used) + BAR_PROJECTED.repeat(projected - used), 'used', mode) + paint(tail.repeat(cells - projected), tailTone, mode);
}

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

export interface StatusOptions {
  color?: ColorMode;
  /** Also show quiet tiers, snoozed accounts and rate limits. */
  all?: boolean;
  /** Terminal width in columns. Names are shortened to fit; without it nothing is shortened. */
  width?: number;
  /** How the CLI is invoked, for the hints. */
  program?: string;
}

interface Row {
  label: string;
  tone: Tone | null;
  name: string;
  bar: string;
  left: string;
  reset: string;
  risk: string;
  note: string;
}

interface Group {
  title: string;
  tone: Tone | null;
  hint: string;
  rows: Row[];
}

function labelTone(view: MeterView): Tone | null {
  if (view.tier === null) return view.throttle === 'blocked' ? 'stop' : null;
  switch (view.tier) {
    case 'use-now':
    case 'behind':
      return 'expiring';
    case 'hot':
      return 'hot';
    case 'spent':
      return 'ok';
    case 'expired':
      return 'stop';
    default:
      return null;
  }
}

function resetCell(view: MeterView): string {
  if (view.msLeft === null) return view.needsReset ? 'unknown' : '-';
  return view.msLeft <= 0 ? 'now' : formatDuration(view.msLeft);
}

function riskCell(view: MeterView): string {
  if (view.valueAtRisk === null || view.currency === null || view.valueAtRisk < 0.005) return '';
  return formatMoney(view.valueAtRisk, view.currency);
}

/** What a person needs to know before trusting or acting on the row. */
function notes(view: MeterView, nowMs: number): string[] {
  const out: string[] = [];
  if (view.snoozed) out.push('snoozed');
  if (view.blockedBy !== null) {
    out.push(
      view.blockedUntilMs !== null && view.blockedUntilMs > nowMs
        ? `blocked by ${view.blockedBy} for ${formatDuration(view.blockedUntilMs - nowMs)}`
        : `blocked by ${view.blockedBy}`
    );
  }
  if (view.meter.estimated) out.push('assumed since the reset');
  else if (view.ageMs === null) out.push('no reading yet');
  else if (view.stale) out.push(`updated ${formatAge(view.ageMs)}`);
  return out;
}

function rowOf(view: MeterView, nowMs: number, mode: ColorMode): Row {
  return {
    label: stateLabel(view),
    tone: labelTone(view),
    name: `${view.account.label} · ${view.meter.label}`,
    bar: forecastBar(view, mode),
    left: formatPercent(view.remainingFraction),
    reset: resetCell(view),
    risk: riskCell(view),
    note: notes(view, nowMs).join(', ')
  };
}

const HEADER = { label: 'State', name: 'Quota', bar: 'Forecast', left: 'Left', reset: 'Resets in', risk: 'At risk' };
const GAP = '  ';
const INDENT = '  ';
const MIN_NAME = 16;
/** Below this many characters a name such as "Claude Max · Weekly limit" no longer says which meter it is. */
const COMFORTABLE_NAME = 28;
const MAX_NAME = 48;

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** What `tokengator status` prints when nothing is tracked yet. */
export function renderEmpty(program = 'tokengator'): string {
  return [
    'No subscriptions are tracked yet.',
    '',
    'Add one from the catalog:',
    ...columns(
      [
        [`${program} add --list`, 'what the catalog knows'],
        [`${program} add <provider>`, 'add a subscription with its usual limits']
      ],
      3,
      2
    ),
    '',
    'Or open the dashboard and press A:',
    `  ${program} serve`,
    ''
  ].join('\n');
}

/** The queue as a table: one meter per row, grouped by state in "use first" order. */
export function renderStatus(state: State, nowMs: number, options: StatusOptions = {}): string {
  const mode = options.color ?? 'none';
  const program = options.program ?? 'tokengator';
  const all = options.all === true;
  if (state.accounts.length === 0) return renderEmpty(program);

  const views = sortViews(viewState(state, nowMs));
  const allowances = views.filter((view) => view.tier !== null);
  const awake = allowances.filter((view) => !view.snoozed);
  const snoozed = allowances.filter((view) => view.snoozed);
  const throttles = views.filter((view) => view.tier === null);

  const groups: Group[] = [];
  const hiddenKinds: string[] = [];
  let hidden = 0;
  for (const tier of TIER_ORDER) {
    const members = awake.filter((view) => view.tier === tier);
    if (members.length === 0) continue;
    if (all || ACTIVE_TIERS.includes(tier)) {
      groups.push({
        title: TIER_LABEL[tier],
        tone: labelTone(members[0] as MeterView),
        hint: TIER_HINT[tier],
        rows: members.map((view) => rowOf(view, nowMs, mode))
      });
    } else {
      hidden += members.length;
      hiddenKinds.push(TIER_LABEL[tier].toLowerCase());
    }
  }
  if (all) {
    if (snoozed.length > 0) {
      groups.push({ title: 'Snoozed', tone: null, hint: 'Left out of the queue and of alerts until the snooze ends.', rows: snoozed.map((view) => rowOf(view, nowMs, mode)) });
    }
    if (throttles.length > 0) {
      groups.push({ title: 'Rate limits', tone: null, hint: 'Short windows that gate an account. Nothing expires with them.', rows: throttles.map((view) => rowOf(view, nowMs, mode)) });
    }
  } else {
    if (snoozed.length > 0) {
      hidden += snoozed.length;
      hiddenKinds.push('snoozed');
    }
    if (throttles.length > 0) {
      hidden += throttles.length;
      hiddenKinds.push('rate limits');
    }
  }

  const lines: string[] = [];
  const rows = groups.flatMap((group) => group.rows);
  if (rows.length > 0) {
    const widthOf = (pick: (row: Row) => string, header: string): number =>
      Math.max(visibleLength(header), ...rows.map((row) => visibleLength(pick(row))));
    const labelW = widthOf((row) => row.label, HEADER.label);
    const leftW = widthOf((row) => row.left, HEADER.left);
    const resetW = widthOf((row) => row.reset, HEADER.reset);
    const riskW = widthOf((row) => row.risk, HEADER.risk);
    const natural = Math.min(MAX_NAME, widthOf((row) => row.name, HEADER.name));
    const afterName = BAR_CELLS + leftW + resetW + riskW + GAP.length * 4;
    // On a terminal too narrow to leave the names readable, the state column is the one to go: the
    // heading above each group already says it, and the name is what tells two rows apart.
    const roomWithState = options.width === undefined ? natural : options.width - INDENT.length - labelW - GAP.length - afterName;
    const compact = roomWithState < Math.min(natural, COMFORTABLE_NAME);
    const lead = INDENT.length + (compact ? 0 : labelW + GAP.length);
    const nameW = options.width === undefined ? natural : Math.max(MIN_NAME, Math.min(natural, options.width - lead - afterName));

    const line = (cells: { label: string; name: string; bar: string; left: string; reset: string; risk: string; note: string }): string[] => {
      const body =
        INDENT +
        [
          ...(compact ? [] : [padEnd(cells.label, labelW)]),
          padEnd(cells.name, nameW),
          padEnd(cells.bar, BAR_CELLS),
          padStart(cells.left, leftW),
          padEnd(cells.reset, resetW),
          padStart(cells.risk, riskW)
        ].join(GAP);
      if (!cells.note) return [body.trimEnd()];
      const inline = body + GAP + cells.note;
      if (options.width === undefined || visibleLength(inline) <= options.width) return [inline];
      // A remark that does not fit beside its row goes under the name, a little further in so it
      // reads as part of that row, instead of wrapping in the middle of the table.
      return [body.trimEnd(), ' '.repeat(lead + 2) + cells.note];
    };

    lines.push(...line({ ...HEADER, note: '' }).map((text) => paint(text, 'muted', mode)));
    for (const group of groups) {
      lines.push('');
      const title = `${group.title} (${group.rows.length})`;
      const withHint = `${title}  ${group.hint}`;
      // The explanation is dropped rather than wrapped when the terminal is too narrow for it.
      const fits = options.width === undefined || visibleLength(withHint) <= options.width;
      lines.push(paint(title, group.tone, mode, true) + (fits ? `  ${paint(group.hint, 'muted', mode)}` : ''));
      for (const row of group.rows) {
        // Without the state column, a state that differs from the heading (a blocked rate limit, a
        // snoozed quota's tier) moves into the remarks so it is never lost.
        const state = compact && row.label !== group.title ? row.label.toLowerCase() : '';
        lines.push(
          ...line({
            label: paint(row.label, row.tone, mode),
            name: truncate(row.name, nameW),
            bar: row.bar,
            left: row.left,
            reset: row.reset,
            risk: paint(row.risk, 'expiring', mode),
            note: paint([state, row.note].filter(Boolean).join(', '), 'muted', mode)
          })
        );
      }
    }
    lines.push('');
    lines.push(
      [
        `${paint(BAR_USED, 'used', mode)} ${paint('used', 'muted', mode)}`,
        `${paint(BAR_PROJECTED, 'used', mode)} ${paint('will be used at this pace', 'muted', mode)}`,
        `${paint(BAR_EXPIRING, 'expiring', mode)} ${paint('will expire unused', 'muted', mode)}`
      ].join('   ')
    );
  }

  if (hidden > 0) {
    const kinds = hiddenKinds.join(', ');
    const text =
      rows.length > 0
        ? `${plural(hidden, 'more is', 'more are')} not shown (${kinds}).`
        : `Nothing is in an active window (${plural(hidden, 'meter', 'meters')}: ${kinds}).`;
    lines.push(paint(`${text} Show everything: ${program} status --all`, 'muted', mode));
  }

  const summary = summarise(state, nowMs);
  const currency = state.settings.currency;
  if (lines.length > 0) lines.push('');
  const lost = formatMoneyTotals(summary.lost30, currency);
  if (lost) lines.push(paint(`Expired unused in the last 30 days: ${summary.lostIsEstimate ? 'about ' : ''}${lost}.`, 'muted', mode));
  lines.push(paint(summaryLine(summary, currency), summary.useNow > 0 ? 'expiring' : null, mode, true));
  if (summary.stale > 0) {
    lines.push(
      paint(
        `${plural(summary.stale, 'reading is', 'readings are')} stale. Refresh: ${program} collectors run, or ${program} set <account> <amount>.`,
        'muted',
        mode
      )
    );
  }
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// Other listings
// ---------------------------------------------------------------------------

function priceText(price: Price | null): string {
  if (!price) return '';
  // A list of plans reads better as "$20/mo" than "$20.00/mo".
  return `${formatMoney(price.amount, price.currency).replace(/\.00$/, '')}/${price.period === 'year' ? 'yr' : 'mo'}`;
}

/** The catalog for `tokengator add --list`: providers by category, with the ids of their plans. */
export function renderCatalog(catalog: readonly ProviderPreset[], checked: string, program = 'tokengator'): string {
  if (catalog.length === 0) {
    return [
      'The catalog has no providers.',
      `Any subscription can still be added by hand in the dashboard: ${program} serve`,
      ''
    ].join('\n');
  }
  const lines: string[] = [`Catalog, checked ${checked}. Presets are a starting point; every number can be edited afterwards.`];
  // One width for the whole list, so the columns line up from one category to the next.
  const idW = Math.max(...catalog.map((provider) => visibleLength(provider.id)));
  const nameW = Math.max(...catalog.map((provider) => visibleLength(provider.name)));
  const categories = Object.keys(CATEGORY_LABEL) as ProviderCategory[];
  for (const category of categories) {
    const providers = catalog.filter((provider) => provider.category === category);
    if (providers.length === 0) continue;
    lines.push('', CATEGORY_LABEL[category]);
    for (const provider of providers) {
      const plans = provider.plans
        .map((plan) => {
          const price = priceText(plan.price);
          return price ? `${plan.id} (${price})` : plan.id;
        })
        .join(', ');
      lines.push(`  ${padEnd(provider.id, idW)}  ${padEnd(provider.name, nameW)}  ${plans}`.trimEnd());
    }
  }
  lines.push('', `Add one: ${program} add <provider> [--plan <plan>] [--label <name>] [--billing-day <1-31>]`, '');
  return lines.join('\n');
}

export interface CollectorRow {
  id: string;
  sourceKind: string;
  enabled: boolean;
  available: boolean;
  reason: string | null;
  lastOutcome: string | null;
  lastMessage: string | null;
}

/** Collectors as a table: id, kind of source, switched on or off, whether it can run, and how the last run went. */
export function renderCollectors(collectors: readonly CollectorRow[]): string {
  if (collectors.length === 0) return 'No collectors.\n';
  const rows = collectors.map((collector) => [
    collector.id,
    collector.sourceKind,
    collector.enabled ? 'on' : 'off',
    collector.available ? 'available' : (collector.reason ?? 'not available'),
    collector.lastOutcome === null ? '-' : collector.lastMessage ? `${collector.lastOutcome}: ${collector.lastMessage}` : collector.lastOutcome
  ]);
  return `${columns([['Id', 'Source', 'Enabled', 'Available', 'Last run'], ...rows]).join('\n')}\n`;
}

/** Connection snippets grouped the way the dashboard's Connect panel groups them. */
export function renderConnect(snippets: readonly ConnectSnippet[]): string {
  const lines: string[] = [];
  const groups = Object.keys(CONNECT_GROUP_LABEL) as ConnectSnippet['group'][];
  for (const group of groups) {
    const members = snippets.filter((snippet) => snippet.group === group);
    if (members.length === 0) continue;
    if (lines.length > 0) lines.push('');
    lines.push(CONNECT_GROUP_LABEL[group]);
    for (const snippet of members) {
      lines.push('', `  ${snippet.title} (${snippet.id})`, `  ${snippet.description}`, '');
      lines.push(...snippet.code.split('\n').map((codeLine) => `    ${codeLine}`));
    }
  }
  return `${lines.join('\n')}\n`;
}
