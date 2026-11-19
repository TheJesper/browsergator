// Building blocks every view shares: the forecast bar, state marks, monograms, countdowns and copy formats.

import { agentPrompt, meterMarkdown, meterRecord } from '../core/brief.js';
import { CATALOG } from '../core/catalog.js';
import { monogramFor } from '../core/catalog-types.js';
import type { MeterView } from '../core/forecast.js';
import { formatAmount, formatMoney, formatPercent } from '../core/format.js';
import { formatAge, formatDuration, formatMoment } from '../core/time.js';
import { stateLabel, statusLine } from '../core/wording.js';
import type { Prefs } from './app.js';
import { h, s, type Child } from './dom.js';

/** Tier or throttle state as one token, used for class names and marks. */
export function stateKey(view: MeterView): string {
  return view.tier ?? view.throttle ?? 'idle';
}

// Each state has its own shape so it reads without colour.
const MARKS: Record<string, () => SVGElement[]> = {
  'use-now': () => [s('path', { d: 'M6 0.8L11.2 6 6 11.2 0.8 6z', fill: 'currentColor' })],
  behind: () => [
    s('circle', { cx: 6, cy: 6, r: 4.6, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6 }),
    s('path', { d: 'M6 1.4a4.6 4.6 0 0 0 0 9.2z', fill: 'currentColor' })
  ],
  hot: () => [s('path', { d: 'M6 1.2l5 9.3H1z', fill: 'currentColor' })],
  'on-pace': () => [s('circle', { cx: 6, cy: 6, r: 4.4, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8 })],
  fresh: () => [s('circle', { cx: 6, cy: 6, r: 2.4, fill: 'currentColor' })],
  idle: () => [s('path', { d: 'M2 6h8', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', fill: 'none' })],
  balance: () => [s('rect', { x: 1.9, y: 1.9, width: 8.2, height: 8.2, rx: 1, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6 })],
  spent: () => [s('path', { d: 'M1.8 6.4l2.8 2.8 5.6-6.4', stroke: 'currentColor', 'stroke-width': 1.9, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', fill: 'none' })],
  expired: () => [s('path', { d: 'M2.4 2.4l7.2 7.2M9.6 2.4l-7.2 7.2', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', fill: 'none' })],
  blocked: () => [s('rect', { x: 1.6, y: 1.6, width: 8.8, height: 8.8, rx: 1.4, fill: 'currentColor' })],
  open: () => [s('circle', { cx: 6, cy: 6, r: 4.4, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.4 })]
};

export function stateMark(key: string): SVGElement {
  const draw = MARKS[key] ?? MARKS['idle'];
  return s('svg', { class: 'mark', viewBox: '0 0 12 12', 'aria-hidden': 'true' }, draw ? draw() : []);
}

/** Mark plus label, coloured by state. The label carries the meaning; the colour and shape repeat it. */
export function stateChip(view: MeterView): HTMLElement {
  const key = stateKey(view);
  return h('span', { class: `state t-${key}` }, stateMark(key), stateLabel(view));
}

export function monogram(view: Pick<MeterView, 'account'>, large = false): HTMLElement {
  return h(
    'span',
    { class: large ? 'mono lg' : 'mono', 'aria-hidden': 'true' },
    monogramFor(CATALOG, view.account.providerId, view.account.label)
  );
}

export interface BarShares {
  used: number;
  projected: number;
  expiring: number;
  now: number | null;
}

/** The three shares of a forecast bar, as fractions of the limit. */
export function barShares(view: MeterView): BarShares {
  const used = view.usedFraction;
  if (view.tier === null) return { used, projected: 0, expiring: 0, now: view.elapsedFraction };
  if (view.tier === 'expired') return { used, projected: 0, expiring: view.remainingFraction, now: null };
  if (view.projectedFraction === null) return { used, projected: 0, expiring: 0, now: null };
  // Too early to forecast: show only what is used and where the clock is.
  if (view.tier === 'fresh') return { used, projected: 0, expiring: 0, now: view.elapsedFraction };
  if (view.tier === 'spent') return { used, projected: 0, expiring: 0, now: null };
  const expiring = view.projectedUnused;
  const projected = Math.max(0, 1 - used - expiring);
  return { used, projected, expiring, now: view.elapsedFraction };
}

/** What the bar says, in words. Shown beside the bar and used as its accessible name. */
export function barCaption(view: MeterView, nowMs: number): { text: string; nodes: Child[] } {
  const usedPct = formatPercent(view.usedFraction);
  if (view.tier === null) {
    const text = view.throttle === 'idle' ? 'No window running' : `${usedPct} of the rate limit used`;
    return { text, nodes: [text] };
  }
  switch (view.tier) {
    case 'spent':
      return { text: 'Used up, nothing expires', nodes: [h('b', null, 'Used up'), ', nothing expires'] };
    case 'expired': {
      const text = `${usedPct} used, ${formatPercent(view.remainingFraction)} expired`;
      return { text, nodes: [h('b', null, `${usedPct} used`), ', ', h('span', { class: 'exp' }, `${formatPercent(view.remainingFraction)} expired`)] };
    }
    case 'idle':
    case 'balance': {
      const text = `${usedPct} used`;
      return { text, nodes: [h('b', null, text), view.needsReset ? ', set the reset time for a forecast' : ''] };
    }
    case 'fresh': {
      const text = `${usedPct} used, too early to forecast`;
      return { text, nodes: [h('b', null, `${usedPct} used`), ', too early to forecast'] };
    }
    case 'hot': {
      const when = view.runsOutAtMs !== null ? `runs out ${formatMoment(view.runsOutAtMs, nowMs)}` : 'will run out early';
      return { text: `${usedPct} used, ${when}`, nodes: [h('b', null, `${usedPct} used`), `, ${when}`] };
    }
    default: {
      const projected = formatPercent(view.projectedFraction ?? view.usedFraction);
      const expires = view.projectedUnused >= 0.005 ? formatPercent(view.projectedUnused) : null;
      const text = expires
        ? `${usedPct} used, on pace for ${projected}, ${expires} expires`
        : `${usedPct} used, on pace to finish`;
      return {
        text,
        nodes: expires
          ? [h('b', null, `${usedPct} used`), `, on pace for ${projected}, `, h('span', { class: 'exp' }, `${expires} expires`)]
          : [h('b', null, `${usedPct} used`), ', on pace to finish']
      };
    }
  }
}

export function forecastBar(view: MeterView, nowMs: number, size: 'sm' | 'lg' | 'thin' = 'sm'): HTMLElement {
  const shares = barShares(view);
  const classes = ['fbar'];
  if (size !== 'sm') classes.push(size);
  if (view.tier === 'spent') classes.push('is-spent');
  if (view.tier === 'expired') classes.push('is-settled');
  if (view.tier === null) classes.push('is-throttle');
  if (view.throttle === 'blocked') classes.push('is-blocked');
  if ((view.stale || view.meter.estimated) && view.msLeft !== null) classes.push('uncertain');
  const segment = (kind: string, share: number): HTMLElement | null =>
    share > 0.001 ? h('i', { class: `seg-${kind}`, style: { flex: `${share} 1 0`, minWidth: '2px' } }) : null;
  const rest = Math.max(0, 1 - shares.used - shares.projected - shares.expiring);
  const elapsed = shares.now !== null ? `, ${formatPercent(shares.now)} of the window elapsed` : '';
  return h(
    'div',
    { class: classes.join(' '), role: 'img', 'aria-label': `${barCaption(view, nowMs).text}${elapsed}` },
    h(
      'div',
      { class: 'fbar-track' },
      segment('used', shares.used),
      segment('proj', shares.projected),
      segment('exp', shares.expiring),
      rest > 0.001 ? h('i', { style: { flex: `${rest} 1 0` } }) : null
    ),
    shares.now !== null ? h('i', { class: 'fbar-now', style: { left: `${Math.min(100, Math.max(0, shares.now * 100))}%` } }) : null
  );
}

/** The bar's legend, shown once per view rather than on every row. */
export function barLegend(): HTMLElement {
  return h(
    'div',
    { class: 'legend', 'aria-hidden': 'true' },
    h('span', null, h('i', { class: 'l-used' }), 'Used'),
    h('span', null, h('i', { class: 'l-proj' }), 'Will be used at this pace'),
    h('span', null, h('i', { class: 'l-exp' }), 'Will expire'),
    h('span', null, h('i', { class: 'l-pace' }), 'Even pace')
  );
}

/** A reset time that the ticker keeps current. Shows a countdown or a clock time depending on preference. */
export function resetText(untilMs: number | null, nowMs: number, prefs: Pick<Prefs, 'times'>): HTMLElement {
  if (untilMs === null) return h('span', { class: 'num muted' }, '—');
  return h(
    'span',
    { class: 'num', dataset: { until: untilMs, mode: prefs.times }, title: `${formatMoment(untilMs, nowMs)} (in ${formatDuration(untilMs - nowMs)})` },
    renderUntil(untilMs, nowMs, prefs.times)
  );
}

export function renderUntil(untilMs: number, nowMs: number, mode: string): string {
  if (untilMs <= nowMs) return 'now';
  return mode === 'clock' ? formatMoment(untilMs, nowMs) : formatDuration(untilMs - nowMs);
}

/** Rewrites every countdown on the page. Called once a second, so it touches text nodes only. */
export function refreshCountdowns(root: ParentNode, nowMs: number): void {
  for (const el of root.querySelectorAll<HTMLElement>('[data-until]')) {
    const text = renderUntil(Number(el.dataset['until']), nowMs, el.dataset['mode'] ?? 'countdown');
    if (el.textContent !== text) el.textContent = text;
  }
}

/** The big figure of a row: share left or used, per preference. */
export function amountFigure(view: MeterView, prefs: Pick<Prefs, 'amounts'>): { value: string; unit: string } {
  const left = prefs.amounts === 'left';
  const fraction = left ? view.remainingFraction : view.usedFraction;
  if (view.meter.unit === 'percent') return { value: formatPercent(fraction), unit: left ? 'left' : 'used' };
  const amount = left ? view.remaining : view.used;
  return { value: formatPercent(fraction), unit: `${formatAmount(view.meter, amount)} ${left ? 'left' : 'used'}` };
}

export function riskText(view: MeterView): string {
  if (view.valueAtRisk === null || view.currency === null || view.valueAtRisk < 0.005) return '';
  return formatMoney(view.valueAtRisk, view.currency);
}

export function ageText(view: MeterView): string {
  if (view.meter.estimated) return 'assumed after reset';
  if (view.ageMs === null) return 'no reading yet';
  return `updated ${formatAge(view.ageMs)}`;
}

export function sourceText(view: MeterView): string {
  const source = view.meter.source;
  switch (source.kind) {
    case 'collector':
      return source.id ? `Automatic (${source.id})` : 'Automatic';
    case 'statusline':
      return source.id === 'antigravity-statusline' ? 'Antigravity status line' : 'Claude Code status line';
    case 'agent':
      return source.id ? `Reported by ${source.id}` : 'Reported by an agent';
    case 'demo':
      return 'Sample data';
    default:
      return 'Entered by hand';
  }
}

/** Small tags after a name: stale, assumed, blocked, snoozed. */
export function flags(view: MeterView, nowMs: number): HTMLElement[] {
  const out: HTMLElement[] = [];
  if (view.blockedBy !== null) {
    const until = view.blockedUntilMs !== null && view.blockedUntilMs > nowMs ? ` ${formatDuration(view.blockedUntilMs - nowMs)}` : '';
    out.push(h('span', { class: 'tag stop', title: `${view.blockedBy} is at its limit` }, `blocked${until}`));
  }
  // An idle window has nothing to be uncertain about, so it carries neither tag.
  const idle = view.tier === 'idle' || view.throttle === 'idle';
  if (view.meter.estimated && !idle) out.push(h('span', { class: 'tag warn', title: 'The window rolled over since the last reading' }, 'assumed'));
  else if (view.stale && !idle && view.tier !== 'expired') {
    // Say how old, not just that it is old: "4d" is a reason to go and look, "stale" is only a label.
    out.push(h('span', { class: 'tag warn', title: 'This reading is old. Refresh it before relying on the forecast.' }, view.ageMs === null ? 'no reading yet' : `updated ${formatAge(view.ageMs)}`));
  }
  if (view.snoozed) out.push(h('span', { class: 'tag' }, 'snoozed'));
  return out;
}

export function copyFormats(view: MeterView, nowMs: number): { label: string; text: () => string; toast?: string }[] {
  return [
    { label: 'Copy status line', text: () => statusLine(view, nowMs), toast: 'Status copied' },
    { label: 'Copy as Markdown', text: () => meterMarkdown(view, nowMs), toast: 'Markdown copied' },
    { label: 'Copy as JSON', text: () => JSON.stringify(meterRecord(view, nowMs), null, 2), toast: 'JSON copied' },
    { label: 'Copy agent prompt', text: () => agentPrompt(view, nowMs), toast: 'Prompt copied' }
  ];
}
