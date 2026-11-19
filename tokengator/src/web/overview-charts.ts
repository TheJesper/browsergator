// The Overview's charts. Each is drawn at the width its tile gives it, one SVG unit to one CSS pixel, so
// labels keep their size from a phone to a wide screen. Colour still means state: hatched orange is what is
// expected to expire, solid orange what did, blue what was used. Providers are told apart by name only.

import { hasMoney } from '../core/brief.js';
import type { MeterView, Money } from '../core/forecast.js';
import { formatMoney, formatMoneyTotals, formatPercent } from '../core/format.js';
import { FORECAST_TIERS, expectsToExpire, type ExpiryEntry, type ExpiryOutlook, type LedgerWeek } from '../core/insights.js';
import { formatMoment } from '../core/time.js';
import { TIER_LABEL, lostText, moneyPair } from '../core/wording.js';
import { niceCeil, roundedTop, shortDate } from './charts.js';
import { h, s, type Child } from './dom.js';
import { barCaption, stateKey, stateMark } from './parts.js';
import { withTip } from './ui.js';

let patternSeq = 0;

/** The even-pace mark that last had focus, so the chart's one tab stop survives a redraw. */
let lastPaceMark: string | null = null;

/** About how wide a label is drawn, in pixels: the chart text is 11px and its digits are tabular. */
function labelWidth(text: string): number {
  return text.length * 6.4 + 2;
}

/** The x of a label centred on `px`, kept inside `from`..`to`. */
function clampLabel(px: number, text: string, from: number, to: number): number {
  const half = labelWidth(text) / 2;
  return Math.min(Math.max(px, from + half), to - half);
}

/** Orange stripes, on the soft orange ground or on nothing. Classes, not inline styles, so contrast themes can repaint them. */
function hatch(id: string, period: number, ground = true): SVGElement {
  return s(
    'pattern',
    { id, width: period, height: period, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' },
    ground ? s('rect', { class: 'hatch-ground', width: period, height: period }) : null,
    s('rect', { class: 'hatch-stripe', width: period / 2, height: period })
  );
}

/** A whole-unit money label for an axis: "$10", "$2.50". */
function axisMoney(amount: number, currency: string): string {
  return formatMoney(amount, currency).replace(/\.00\b/, '');
}

/** The amount in one currency, or the largest currency when that one has none. */
export function pick(money: Money, currency: string): { amount: number; currency: string } {
  if ((money[currency] ?? 0) > 0) return { amount: money[currency] as number, currency };
  const [code, amount] = Object.entries(money).sort(([, a], [, b]) => b - a)[0] ?? [currency, 0];
  return { amount, currency: code };
}

/** A day's quota that is expected to lose part of itself at the reset: the test `expectsToExpire` applies. */
function forecastLoss(entry: ExpiryEntry): boolean {
  return entry.current && FORECAST_TIERS.includes(entry.tier) && entry.projectedUnused >= 0.05;
}

/** What one quota does at a day's reset, for the tooltip. A new window has no forecast, so it gets none. */
function entryLine(entry: ExpiryEntry, name: string, nowMs: number, tz: string): string {
  const at = formatMoment(entry.atMs, nowMs, tz).replace(/^.* (\d\d:\d\d)$/, '$1');
  if (!entry.current) return `${name}: renews, nothing forecast yet`;
  if (entry.tier === 'spent') return `${name}: used up`;
  if (entry.tier === 'fresh') return `${name}: too early to forecast, resets ${at}`;
  if (!FORECAST_TIERS.includes(entry.tier)) return `${name}: ${TIER_LABEL[entry.tier].toLowerCase()}, resets ${at}`;
  return `${name}: ${formatPercent(entry.projectedUnused)} unused at this pace, resets ${at}`;
}

// ---------------------------------------------------------------------------
// What expires, and when
// ---------------------------------------------------------------------------

export interface ExpiryChartOptions {
  currency: string;
  /** No subscription has a price, so the columns count quotas instead of money. */
  noPrices: boolean;
  nameOf: (id: string) => string;
  onSelect: (id: string) => void;
  nowMs: number;
  tz: string;
}

/**
 * One column per day for the next 30 days: the money expected to expire at that day's resets, hatched because
 * it is a forecast. Dollar credits get their own lane and scale below, so the two are never stacked or added.
 * A day whose resets put nothing at stake gets a small tick under the axis. A bracket over the first seven
 * days marks the span the tile's "next 7 days" figure covers; the figure itself is text beside the chart.
 */
export function expiryColumns(outlook: ExpiryOutlook, W: number, opts: ExpiryChartOptions): SVGElement {
  const days = outlook.days;
  const n = Math.max(1, days.length);
  const narrow = W < 360;
  const left = narrow ? 4 : 44;
  const right = 8;
  // A band at the top holds the bracket; the plot starts below it, so the peak label never reaches it.
  const bracketY = 5;
  const top = 25;
  const PH = 96;
  const axisY = top + PH;
  const creditsCurrency = days.map((day) => Object.keys(day.credits)[0]).find(Boolean) ?? 'USD';
  const creditOf = (day: (typeof days)[number]): number => day.credits[creditsCurrency] ?? 0;
  const planOf = (day: (typeof days)[number]): number => (opts.noPrices ? day.count : (day.plan[opts.currency] ?? 0));
  const hasCredits = !opts.noPrices && days.some((day) => creditOf(day) > 0.004);
  const CH = 30;
  // Room under the axis labels for the credit lane's own labels, which sit above its columns.
  const creditsTop = axisY + 40;
  const creditsAxis = creditsTop + CH;
  const H = hasCredits ? creditsAxis + 6 : axisY + 20;
  const slot = (W - left - right) / n;
  const bar = Math.max(2, Math.min(18, slot - 2));
  const period = bar < 12 ? 4 : 5;
  const patternId = `exp-${(patternSeq += 1)}`;
  const max = Math.max(...days.map(planOf), 0);
  const scale = opts.noPrices ? Math.max(1, Math.ceil(max)) : niceCeil(Math.max(max, 1));
  const creditMax = niceCeil(Math.max(...days.map(creditOf), 1));
  const x = (i: number): number => left + i * slot + (slot - bar) / 2;
  const y = (value: number): number => top + PH * (1 - Math.min(value, scale) / scale);

  const svg = s(
    'svg',
    { viewBox: `0 0 ${W} ${H}`, width: W, height: H, 'aria-hidden': 'true' },
    s('defs', null, hatch(patternId, period))
  );
  // Grid and axis first, so the columns draw over them.
  if (!narrow) {
    for (const value of opts.noPrices ? [scale] : [scale / 2, scale]) {
      svg.appendChild(s('line', { class: 'grid', x1: left, x2: W - right, y1: y(value), y2: y(value) }));
      svg.appendChild(s('text', { class: 'tick', x: left - 6, y: y(value) + 4, 'text-anchor': 'end' }, opts.noPrices ? String(value) : axisMoney(value, opts.currency)));
    }
  }
  svg.appendChild(s('line', { class: 'axis', x1: left, x2: W - right, y1: axisY, y2: axisY }));
  // The first seven days, bracketed from above: the span the "next 7 days" figure adds up.
  const divider = left + Math.min(7, n) * slot;
  svg.appendChild(s('path', { class: 'bracket-line', d: `M${left + 0.5} ${bracketY + 5}V${bracketY + 0.5}H${divider - 1.5}V${bracketY + 5}` }));

  let tallest = -1;
  days.forEach((day, i) => {
    const value = planOf(day);
    if (value > (tallest >= 0 ? planOf(days[tallest] as (typeof days)[number]) : 0)) tallest = i;
    if (value > 0.004) {
      const height = Math.max(2, PH * (Math.min(value, scale) / scale));
      svg.appendChild(s('path', { class: day.uncertain ? 'exp-col uncertain' : 'exp-col', d: roundedTop(x(i), axisY - height, bar, height, 3), fill: `url(#${patternId})` }));
    } else if (day.entries.length > 0 && !hasMoney(day.plan) && !hasMoney(day.credits)) {
      // Only where nothing is at stake in any currency: money in another currency or in credits is not "nothing".
      svg.appendChild(s('line', { class: 'reset-tick', x1: left + i * slot + slot / 2, x2: left + i * slot + slot / 2, y1: axisY + 2, y2: axisY + 6 }));
    }
    if (hasCredits && creditOf(day) > 0.004) {
      const height = Math.max(2, CH * (creditOf(day) / creditMax));
      svg.appendChild(s('path', { class: day.uncertain ? 'exp-col uncertain' : 'exp-col', d: roundedTop(x(i), creditsAxis - height, bar, height, 3), fill: `url(#${patternId})` }));
    }
  });
  // Only the tallest column carries its value: the axis and the tooltips carry the rest.
  const peak = days[tallest];
  if (peak && planOf(peak) > 0.004) {
    const label = opts.noPrices ? String(planOf(peak)) : axisMoney(planOf(peak), opts.currency);
    // Never higher than the band under the bracket, and never off the plot's ends.
    svg.appendChild(s('text', { class: 'peak', x: clampLabel(x(tallest) + bar / 2, label, left, W - right), y: Math.max(y(planOf(peak)) - 5, top - 5), 'text-anchor': 'middle' }, label));
  }
  // Labels along the axis: today, the end of the first week, the last day.
  const last = days[n - 1];
  svg.appendChild(s('text', { x: left, y: axisY + 16, 'text-anchor': 'start' }, 'today'));
  if (!narrow && days[7]) svg.appendChild(s('text', { x: divider, y: axisY + 16, 'text-anchor': 'middle' }, shortDate(days[7].startMs)));
  if (last) svg.appendChild(s('text', { x: W - right, y: axisY + 16, 'text-anchor': 'end' }, shortDate(last.startMs)));

  if (hasCredits) {
    svg.appendChild(s('line', { class: 'axis', x1: left, x2: W - right, y1: creditsAxis, y2: creditsAxis }));
    const topCredit = days.reduce((best, day, i) => (creditOf(day) > creditOf(days[best] as (typeof days)[number]) ? i : best), 0);
    const credit = creditOf(days[topCredit] as (typeof days)[number]);
    // The largest credit column carries its value above it, as the plan peak does, kept inside the lane.
    let peakFrom = Infinity;
    if (credit > 0.004) {
      const label = axisMoney(credit, creditsCurrency);
      const height = Math.max(2, CH * (credit / creditMax));
      const px = clampLabel(x(topCredit) + bar / 2, label, left, W - right);
      peakFrom = px - labelWidth(label) / 2;
      svg.appendChild(s('text', { class: 'peak', x: px, y: creditsAxis - height - 4, 'text-anchor': 'middle' }, label));
    }
    if (!narrow) svg.appendChild(s('text', { class: 'lane', x: left - 6, y: creditsTop + 4, 'text-anchor': 'end' }, 'Credits'));
    else {
      // No gutter on a narrow chart: the lane is named above its columns, at whichever end its peak label leaves free.
      const atStart = peakFrom > left + labelWidth('Credits') + 6;
      svg.appendChild(s('text', { class: 'lane', x: atStart ? left : W - right, y: creditsTop - 4, 'text-anchor': atStart ? 'start' : 'end' }, 'Credits'));
    }
  }

  // One hit area per day, the full height: the pointer only has to be on the right day. Out of the tab
  // order: the drawing is hidden from assistive technology, and the table says the same.
  days.forEach((day, i) => {
    const hit = s('rect', { class: 'hit', x: left + i * slot, y: 0, width: slot, height: H, tabindex: -1 });
    const current = day.entries.filter((entry) => entry.current);
    if (day.entries.length > 0) {
      withTip(hit, () => {
        const money = opts.noPrices ? '' : moneyPair(day.plan, day.credits, opts.currency);
        // The same test as the even-pace chart's orange: a new window is too early to say it expires.
        const losing = current.filter(forecastLoss);
        const unpriced = losing.filter((entry) => entry.valueAtRisk === null).length;
        const headline = money
          ? `${money} expires`
          : unpriced > 0
            ? 'Some quota expires, no price set'
            : losing.length > 0
              ? 'Some quota expires'
              : 'Nothing expected to expire';
        const also = money && unpriced > 0 ? h('span', null, `, and ${unpriced === 1 ? '1 more quota' : `${unpriced} more quotas`} with no price set`) : null;
        const lines: Child[] = [h('b', null, headline), also, h('br'), h('span', null, formatMoment(day.startMs, opts.nowMs, opts.tz).replace(/ \d\d:\d\d$/, ''))];
        for (const entry of day.entries.slice(0, 5)) lines.push(h('br'), h('span', null, entryLine(entry, opts.nameOf(entry.id), opts.nowMs, opts.tz)));
        if (day.entries.length > 5) lines.push(h('br'), h('span', null, `and ${day.entries.length - 5} more`));
        return lines;
      });
      // A click opens the quota with the most at stake that day.
      const best = [...current].sort((a, b) => (b.valueAtRisk ?? b.projectedUnused) - (a.valueAtRisk ?? a.projectedUnused))[0] ?? day.entries[0];
      if (best) {
        hit.classList.add('pick');
        hit.addEventListener('click', () => opts.onSelect(best.id));
      }
    }
    svg.appendChild(hit);
  });
  return svg;
}

// ---------------------------------------------------------------------------
// Finished windows, week by week
// ---------------------------------------------------------------------------

/**
 * Two panels on one twelve-week axis: the money that expired each week (solid, with the estimated part
 * outlined above it), and the share used over the 30 days ending with each week (a line). Two charts that
 * share the time axis, never two scales on one plot. A week in which no window closed has no column.
 * The money panel charts plan money in the preferred currency, or, when no week holds any in it, in the
 * currency that holds the most, as `pick` does. Credits and other currencies are in the tooltip and the table.
 */
export function weeklyPanels(weeks: readonly LedgerWeek[], W: number, currency: string, nowMs: number): SVGElement {
  const left = W < 300 ? 30 : 40;
  const right = 10;
  const panel = 54;
  const gap = 22;
  const top1 = 14;
  const base1 = top1 + panel;
  const top2 = base1 + gap;
  const base2 = top2 + panel;
  const H = base2 + 20;
  const n = Math.max(1, weeks.length);
  const slot = (W - left - right) / n;
  const bar = Math.max(4, Math.min(16, slot - 6));
  const held: Money = {};
  for (const week of weeks) for (const [code, value] of Object.entries(week.lost)) held[code] = (held[code] ?? 0) + value;
  const shown = pick(held, currency).currency;
  const amount = (week: LedgerWeek): number => week.lost[shown] ?? 0;
  const estimated = (week: LedgerWeek): number => week.lostEstimated[shown] ?? 0;
  const scale = niceCeil(Math.max(...weeks.map(amount), 1));
  const cx = (i: number): number => left + i * slot + slot / 2;
  const y1 = (value: number): number => base1 - panel * (Math.min(value, scale) / scale);
  const y2 = (fraction: number): number => base2 - panel * Math.min(Math.max(fraction, 0), 1);

  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, 'aria-hidden': 'true' });
  // Panel titles sit in the plot's top-left, so neither panel needs a legend.
  svg.appendChild(s('text', { class: 'panel', x: left, y: top1 - 4 }, `Expired each week, plan money${shown === 'USD' ? '' : ` in ${shown}`}`));
  svg.appendChild(s('line', { class: 'grid', x1: left, x2: W - right, y1: y1(scale), y2: y1(scale) }));
  svg.appendChild(s('text', { class: 'tick', x: left - 6, y: y1(scale) + 4, 'text-anchor': 'end' }, axisMoney(scale, shown)));
  svg.appendChild(s('line', { class: 'axis', x1: left, x2: W - right, y1: base1, y2: base1 }));

  svg.appendChild(s('text', { class: 'panel', x: left, y: top2 - 4 }, 'Used, trailing 30 days'));
  svg.appendChild(s('line', { class: 'grid', x1: left, x2: W - right, y1: y2(1), y2: y2(1) }));
  svg.appendChild(s('line', { class: 'grid', x1: left, x2: W - right, y1: y2(0.5), y2: y2(0.5) }));
  svg.appendChild(s('text', { class: 'tick', x: left - 6, y: y2(1) + 4, 'text-anchor': 'end' }, '100%'));
  svg.appendChild(s('text', { class: 'tick', x: left - 6, y: y2(0.5) + 4, 'text-anchor': 'end' }, '50%'));
  svg.appendChild(s('line', { class: 'axis', x1: left, x2: W - right, y1: base2, y2: base2 }));

  weeks.forEach((week, i) => {
    if (week.windows === 0) return;
    const total = amount(week);
    const est = Math.min(estimated(week), total);
    const measured = total - est;
    const x0 = cx(i) - bar / 2;
    if (total <= 0.004) {
      // Windows closed and no money expired: a hairline on the axis says "zero", unlike an empty week. Not
      // for a week whose money is in credits or another currency: that is not zero, only not on this scale.
      if (!hasMoney(week.lost) && !hasMoney(week.creditsLost)) svg.appendChild(s('rect', { class: 'zero-tick', x: x0, y: base1 - 2, width: bar, height: 2 }));
      return;
    }
    const hMeasured = measured > 0.004 ? Math.max(2, panel * (measured / scale)) : 0;
    const hTotal = Math.max(2, panel * (Math.min(total, scale) / scale));
    if (hMeasured > 0) svg.appendChild(s('path', { class: 'lost-col', d: roundedTop(x0, base1 - hMeasured, bar, hMeasured, est > 0.004 ? 0 : 3) }));
    if (est > 0.004) {
      const gapAbove = hMeasured > 0 ? 2 : 0;
      const hEst = Math.max(2, hTotal - hMeasured - gapAbove);
      svg.appendChild(s('path', { class: 'lost-col est', d: roundedTop(x0 + 0.75, base1 - hMeasured - gapAbove - hEst + 0.75, bar - 1.5, hEst - 0.75, 3) }));
    }
  });

  // The share used: one line, broken where the trailing 30 days hold no window.
  let d = '';
  let pen = false;
  weeks.forEach((week, i) => {
    if (week.trailingUtilisation === null) {
      pen = false;
      return;
    }
    d += `${pen ? 'L' : 'M'}${cx(i).toFixed(1)} ${y2(week.trailingUtilisation).toFixed(1)}`;
    pen = true;
  });
  if (d) svg.appendChild(s('path', { class: 'util-line', d }));
  const lastIndex = weeks.length - 1;
  const last = weeks[lastIndex];
  if (last && last.trailingUtilisation !== null) {
    svg.appendChild(s('circle', { class: 'dot', cx: cx(lastIndex), cy: y2(last.trailingUtilisation), r: 4 }));
    svg.appendChild(s('text', { class: 'peak', x: cx(lastIndex) - 8, y: y2(last.trailingUtilisation) - 8, 'text-anchor': 'end' }, formatPercent(last.trailingUtilisation)));
  }

  const first = weeks[0];
  if (first && W >= 260) svg.appendChild(s('text', { x: left, y: H - 4, 'text-anchor': 'start' }, shortDate(first.startMs)));
  svg.appendChild(s('text', { x: W - right, y: H - 4, 'text-anchor': 'end' }, 'this week'));

  weeks.forEach((week, i) => {
    const hit = s('rect', { class: 'hit', x: left + i * slot, y: 0, width: slot, height: H, tabindex: -1 });
    withTip(hit, () => {
      const lines: Child[] = [];
      if (week.windows === 0) lines.push(h('b', null, 'No window closed'));
      else {
        // The shared wording: each part "about" a whole amount when estimated windows are behind it.
        const money = hasMoney(week.lost) || hasMoney(week.creditsLost) ? lostText(week.lost, week.creditsLost, currency, hasMoney(week.lostEstimated), hasMoney(week.creditsLostEstimated)) : '';
        lines.push(h('b', null, money ? `${money} expired` : 'No money expired'), h('br'), h('span', null, `${week.windows === 1 ? '1 window' : `${week.windows} windows`} closed${week.estimatedWindows ? `, ${week.estimatedWindows} estimated` : ''}`));
      }
      if (week.trailingUtilisation !== null) lines.push(h('br'), h('span', null, `${formatPercent(week.trailingUtilisation)} used over the 30 days to ${formatMoment(week.endMs, nowMs).replace(/ \d\d:\d\d$/, '')}`));
      lines.push(h('br'), h('span', null, `week of ${shortDate(week.startMs)}`));
      return lines;
    });
    svg.appendChild(hit);
  });
  return svg;
}

// ---------------------------------------------------------------------------
// Every quota against an even pace
// ---------------------------------------------------------------------------

export interface PaceOptions {
  rankOf: (id: string) => number;
  selected: MeterView | null;
  nowMs: number;
  nameOf: (id: string) => string;
  onSelect: (id: string) => void;
}

/**
 * True when part of a quota is expected to expire: the one thing the even-pace chart colours. The same test
 * as the expiry chart's, so a new window, too early to forecast, is never orange.
 */
export function willExpire(view: MeterView): boolean {
  return expectsToExpire(view);
}

/**
 * Every running quota at its share of the window gone (across) and its share used (up), beside the diagonal
 * of an even pace. The marks are buttons over the drawing, so they take focus and keep it across a redraw.
 * Arrow keys move through them in the order of the queue.
 */
export function paceMap(views: readonly MeterView[], W: number, opts: PaceOptions): HTMLElement {
  const left = 40;
  const right = 20;
  const top = 12;
  const PW = W - left - right;
  const PH = Math.round(Math.min(230, Math.max(170, W * 0.42)));
  const H = PH + top + 40;
  const x = (fraction: number): number => left + Math.min(Math.max(fraction, 0), 1) * PW;
  const y = (fraction: number): number => top + (1 - Math.min(Math.max(fraction, 0), 1)) * PH;
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, 'aria-hidden': 'true' });
  svg.appendChild(s('line', { class: 'grid', x1: x(0.5), x2: x(0.5), y1: y(1), y2: y(0) }));
  svg.appendChild(s('line', { class: 'grid', x1: x(0), x2: x(1), y1: y(0.5), y2: y(0.5) }));
  svg.appendChild(s('line', { class: 'grid', x1: x(0), x2: x(1), y1: y(1), y2: y(1) }));
  svg.appendChild(s('line', { class: 'grid', x1: x(1), x2: x(1), y1: y(1), y2: y(0) }));
  svg.appendChild(s('line', { class: 'axis', x1: x(0), x2: x(1), y1: y(0), y2: y(0) }));
  svg.appendChild(s('line', { class: 'axis', x1: x(0), x2: x(0), y1: y(0), y2: y(1) }));
  svg.appendChild(s('line', { class: 'guide', x1: x(0), y1: y(0), x2: x(1), y2: y(1) }));
  const angle = (-Math.atan(PH / PW) * 180) / Math.PI;
  svg.appendChild(s('text', { class: 'guide-label', x: x(0.3), y: y(0.3) - 6, transform: `rotate(${angle.toFixed(1)} ${x(0.3)} ${y(0.3) - 6})` }, 'even pace'));
  for (const f of [0, 0.5, 1]) {
    svg.appendChild(s('text', { class: 'tick', x: x(f), y: y(0) + 16, 'text-anchor': f === 0 ? 'start' : f === 1 ? 'end' : 'middle' }, formatPercent(f)));
    if (f > 0) svg.appendChild(s('text', { class: 'tick', x: left - 6, y: y(f) + 4, 'text-anchor': 'end' }, formatPercent(f)));
  }
  svg.appendChild(s('text', { class: 'axis-title', x: x(0.5), y: H - 4, 'text-anchor': 'middle' }, 'share of the window gone'));
  svg.appendChild(s('text', { class: 'axis-title', x: left - 6, y: y(1) - 2, 'text-anchor': 'end', dy: '-0.4em' }, 'used'));

  // The selected quota's forecast: dashed to its reset, and the share that would expire hatched beyond it.
  const chosen = opts.selected;
  if (chosen && views.some((view) => view.id === chosen.id) && chosen.projectedFraction !== null && chosen.elapsedFraction !== null && chosen.tier !== 'fresh' && chosen.tier !== 'spent') {
    svg.appendChild(s('line', { class: 'proj', x1: x(chosen.elapsedFraction), y1: y(chosen.usedFraction), x2: x(1), y2: y(chosen.projectedFraction) }));
    svg.appendChild(s('circle', { class: 'pm-end', cx: x(1), cy: y(chosen.projectedFraction), r: 4 }));
    if (chosen.projectedUnused >= 0.01) {
      const id = `pm-hatch-${(patternSeq += 1)}`;
      svg.appendChild(s('defs', null, hatch(id, 4)));
      svg.appendChild(s('rect', { class: 'pm-exp', x: x(1) + 4, y: y(1), width: 7, height: Math.max(2, y(chosen.projectedFraction) - y(1)), rx: 2, fill: `url(#${id})` }));
    }
  }

  const holder = h('div', { class: 'pm', style: { width: `${W}px`, height: `${H}px` } }, svg);
  const ordered = [...views].sort((a, b) => opts.rankOf(a.id) - opts.rankOf(b.id));
  // The one tab stop: the selected mark, else the mark last focused if it is still drawn, else the first.
  // Chosen from state a redraw keeps, so returning by Tab lands where the reader left.
  const stopAt = (id: string | null | undefined): number => (id ? ordered.findIndex((view) => view.id === id) : -1);
  const stop = [stopAt(opts.selected?.id), stopAt(lastPaceMark), 0].find((index) => index >= 0) ?? 0;
  const marks: HTMLButtonElement[] = [];
  ordered.forEach((view, index) => {
    const key = stateKey(view);
    const risk = willExpire(view);
    const classes = ['pm-mark', risk ? 'risk' : 'quiet'];
    if (chosen?.id === view.id) classes.push('selected');
    if (view.stale || view.meter.estimated) classes.push('uncertain');
    const rank = opts.rankOf(view.id);
    const mark = h(
      'button',
      {
        class: classes.join(' '),
        type: 'button',
        id: `ov-pm-${view.id}`,
        tabindex: index === stop ? 0 : -1,
        'aria-label': `${rank}. ${opts.nameOf(view.id)}: ${TIER_LABEL[view.tier ?? 'idle'] ?? ''}, ${formatPercent(view.usedFraction)} used with ${formatPercent(view.elapsedFraction ?? 0)} of the window gone. ${barCaption(view, opts.nowMs).text}`,
        'aria-pressed': String(chosen?.id === view.id),
        dataset: { id: view.id, nav: 'row' },
        style: { left: `${x(view.elapsedFraction ?? 0) - 12}px`, top: `${y(view.usedFraction) - 12}px` },
        onclick: () => opts.onSelect(view.id)
      },
      stateMark(key)
    ) as HTMLButtonElement;
    withTip(mark, () => [
      h('b', null, `${formatPercent(view.usedFraction)} used`),
      h('span', null, `, ${formatPercent(view.elapsedFraction ?? 0)} of the window gone`),
      h('br'),
      h('span', null, opts.nameOf(view.id)),
      h('br'),
      h('span', null, barCaption(view, opts.nowMs).text),
      view.meter.reset.kind === 'once' ? [h('br'), h('span', null, 'A one-off pack: its pace is measured from when tracking began.')] : null
    ]);
    marks.push(mark);
    holder.appendChild(mark);
  });
  // Roving focus: one tab stop for the whole chart, arrows to move, in the order of the queue. Whatever puts
  // focus on a mark (arrows, a click, or focus put back after a redraw) makes it the tab stop.
  holder.addEventListener('focusin', (event) => {
    const index = marks.indexOf(event.target as HTMLButtonElement);
    if (index < 0) return;
    lastPaceMark = ordered[index]?.id ?? null;
    marks.forEach((mark, i) => mark.setAttribute('tabindex', i === index ? '0' : '-1'));
  });
  holder.addEventListener('keydown', (event) => {
    const index = marks.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    const moves: Record<string, number> = { ArrowRight: index + 1, ArrowDown: index + 1, ArrowLeft: index - 1, ArrowUp: index - 1, Home: 0, End: marks.length - 1 };
    const target = moves[event.key];
    if (target === undefined) return;
    const next = Math.min(marks.length - 1, Math.max(0, target));
    // Taken here, so the page's own arrow keys (which move through the rows) do not act as well.
    event.preventDefault();
    marks[next]?.focus();
  });
  return holder;
}

/** Totals of a Money record in its own currencies, for a table cell: "$23.10", "" when empty. */
export function moneyCell(money: Money, currency: string): string {
  return formatMoneyTotals(money, currency);
}
