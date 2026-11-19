// The Overview's charts. Each is drawn at the width its tile gives it, one SVG unit to one CSS pixel, so
// labels keep their size from a phone to a wide screen. Colour still means state: hatched orange is what is
// expected to expire, solid orange what did, blue what was used. Providers are told apart by name only.

import type { MeterView, Money } from '../core/forecast.js';
import { formatMoney, formatMoneyTotals, formatPercent } from '../core/format.js';
import type { ExpiryOutlook, LedgerWeek } from '../core/insights.js';
import { formatMoment } from '../core/time.js';
import { TIER_LABEL, moneyPair } from '../core/wording.js';
import { niceCeil, roundedTop, shortDate } from './charts.js';
import { h, s, type Child } from './dom.js';
import { barCaption, stateKey, stateMark } from './parts.js';
import { withTip } from './ui.js';

let patternSeq = 0;

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
 * A day with resets that cost nothing gets a small tick under the axis.
 */
export function expiryColumns(outlook: ExpiryOutlook, W: number, opts: ExpiryChartOptions): SVGElement {
  const days = outlook.days;
  const n = Math.max(1, days.length);
  const narrow = W < 360;
  const left = narrow ? 4 : 44;
  const right = 8;
  const top = narrow && W < 300 ? 34 : 22;
  const PH = 96;
  const axisY = top + PH;
  const creditsCurrency = days.map((day) => Object.keys(day.credits)[0]).find(Boolean) ?? 'USD';
  const creditOf = (day: (typeof days)[number]): number => day.credits[creditsCurrency] ?? 0;
  const planOf = (day: (typeof days)[number]): number => (opts.noPrices ? day.count : (day.plan[opts.currency] ?? 0));
  const hasCredits = !opts.noPrices && days.some((day) => creditOf(day) > 0.004);
  const CH = 30;
  const creditsTop = axisY + 30;
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

  const figure = moneyPair(outlook.firstWeek.plan, outlook.firstWeek.credits, opts.currency);
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
  // The first seven days are bracketed: "this week" is the figure people act on.
  const divider = left + Math.min(7, n) * slot;
  svg.appendChild(s('line', { class: 'grid week', x1: divider, x2: divider, y1: top - 4, y2: hasCredits ? creditsAxis : axisY }));
  svg.appendChild(
    s(
      'text',
      { class: 'bracket', x: left, y: 12 },
      `${opts.noPrices ? 'Next 7 days, quotas losing 5% or more: ' : 'Next 7 days: '}`,
      s('tspan', { class: 'fig' }, opts.noPrices ? String(days.slice(0, 7).reduce((sum, day) => sum + day.count, 0)) : figure || formatMoney(0, opts.currency))
    )
  );

  let tallest = -1;
  days.forEach((day, i) => {
    const value = planOf(day);
    if (value > (tallest >= 0 ? planOf(days[tallest] as (typeof days)[number]) : 0)) tallest = i;
    if (value > 0.004) {
      const height = Math.max(2, PH * (Math.min(value, scale) / scale));
      svg.appendChild(s('path', { class: day.uncertain ? 'exp-col uncertain' : 'exp-col', d: roundedTop(x(i), axisY - height, bar, height, 3), fill: `url(#${patternId})` }));
    } else if (day.entries.length > 0) {
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
    const px = x(tallest) + bar / 2;
    svg.appendChild(s('text', { class: 'peak', x: Math.min(Math.max(px, left + 12), W - right - 12), y: y(planOf(peak)) - 5, 'text-anchor': 'middle' }, label));
  }
  // Labels along the axis: today, the end of the first week, the last day.
  const last = days[n - 1];
  svg.appendChild(s('text', { x: left, y: axisY + 16, 'text-anchor': 'start' }, 'today'));
  if (!narrow && days[7]) svg.appendChild(s('text', { x: divider, y: axisY + 16, 'text-anchor': 'middle' }, shortDate(days[7].startMs)));
  if (last) svg.appendChild(s('text', { x: W - right, y: axisY + 16, 'text-anchor': 'end' }, shortDate(last.startMs)));

  if (hasCredits) {
    svg.appendChild(s('line', { class: 'axis', x1: left, x2: W - right, y1: creditsAxis, y2: creditsAxis }));
    svg.appendChild(s('text', { class: 'lane', x: narrow ? left + 2 : left - 6, y: creditsTop + 4, 'text-anchor': narrow ? 'start' : 'end' }, 'Credits'));
    const topCredit = days.reduce((best, day, i) => (creditOf(day) > creditOf(days[best] as (typeof days)[number]) ? i : best), 0);
    const credit = creditOf(days[topCredit] as (typeof days)[number]);
    if (credit > 0.004) {
      const px = x(topCredit) + bar + 4;
      const anchor = px > W - 60 ? 'end' : 'start';
      svg.appendChild(s('text', { class: 'peak', x: anchor === 'end' ? x(topCredit) - 4 : px, y: creditsAxis - 4, 'text-anchor': anchor }, axisMoney(credit, creditsCurrency)));
    }
  }

  // One hit area per day, the full height: the pointer only has to be on the right day.
  days.forEach((day, i) => {
    const hit = s('rect', { class: 'hit', x: left + i * slot, y: 0, width: slot, height: H });
    const current = day.entries.filter((entry) => entry.current);
    if (day.entries.length > 0) {
      withTip(hit, () => {
        const money = opts.noPrices ? '' : moneyPair(day.plan, day.credits, opts.currency);
        const lines: Child[] = [h('b', null, money ? `${money} expires` : current.some((entry) => entry.projectedUnused >= 0.05) ? 'Some quota expires, no price set' : 'Nothing expires'), h('br'), h('span', null, formatMoment(day.startMs, opts.nowMs, opts.tz).replace(/ \d\d:\d\d$/, ''))];
        for (const entry of day.entries.slice(0, 5)) {
          const name = opts.nameOf(entry.id);
          const text = !entry.current
            ? `${name}: renews, nothing forecast yet`
            : entry.tier === 'spent'
              ? `${name}: used up`
              : `${name}: ${formatPercent(entry.projectedUnused)} unused at this pace, resets ${formatMoment(entry.atMs, opts.nowMs, opts.tz).replace(/^.* (\d\d:\d\d)$/, '$1')}`;
          lines.push(h('br'), h('span', null, text));
        }
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
  const amount = (week: LedgerWeek): number => week.lost[currency] ?? 0;
  const estimated = (week: LedgerWeek): number => week.lostEstimated[currency] ?? 0;
  const scale = niceCeil(Math.max(...weeks.map(amount), 1));
  const cx = (i: number): number => left + i * slot + slot / 2;
  const y1 = (value: number): number => base1 - panel * (Math.min(value, scale) / scale);
  const y2 = (fraction: number): number => base2 - panel * Math.min(Math.max(fraction, 0), 1);

  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, 'aria-hidden': 'true' });
  // Panel titles sit in the plot's top-left, so neither panel needs a legend.
  svg.appendChild(s('text', { class: 'panel', x: left, y: top1 - 4 }, `Expired each week, ${currency === 'USD' ? 'plan money' : currency}`));
  svg.appendChild(s('line', { class: 'grid', x1: left, x2: W - right, y1: y1(scale), y2: y1(scale) }));
  svg.appendChild(s('text', { class: 'tick', x: left - 6, y: y1(scale) + 4, 'text-anchor': 'end' }, axisMoney(scale, currency)));
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
      // Windows closed and nothing expired: a hairline on the axis says "zero", unlike an empty week.
      svg.appendChild(s('rect', { class: 'zero-tick', x: x0, y: base1 - 2, width: bar, height: 2 }));
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
    const hit = s('rect', { class: 'hit', x: left + i * slot, y: 0, width: slot, height: H });
    withTip(hit, () => {
      const lines: Child[] = [];
      if (week.windows === 0) lines.push(h('b', null, 'No window closed'));
      else {
        const money = moneyPair(week.lost, week.creditsLost, currency);
        const estimate = (week.lostEstimated[currency] ?? 0) > 0.004;
        lines.push(h('b', null, money ? `${estimate ? 'about ' : ''}${money} expired` : 'Nothing expired'), h('br'), h('span', null, `${week.windows === 1 ? '1 window' : `${week.windows} windows`} closed${week.estimatedWindows ? `, ${week.estimatedWindows} estimated` : ''}`));
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

/** True when part of a quota is expected to expire: the one thing the even-pace chart colours. */
export function willExpire(view: MeterView): boolean {
  return view.projectedUnused >= 0.05 && view.meter.rollover !== 'carries';
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
        tabindex: index === 0 ? 0 : -1,
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
  // Roving focus: one tab stop for the whole chart, arrows to move, in the order of the queue.
  holder.addEventListener('keydown', (event) => {
    const index = marks.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    const moves: Record<string, number> = { ArrowRight: index + 1, ArrowDown: index + 1, ArrowLeft: index - 1, ArrowUp: index - 1, Home: 0, End: marks.length - 1 };
    const target = moves[event.key];
    if (target === undefined) return;
    const next = Math.min(marks.length - 1, Math.max(0, target));
    // Taken here, so the page's own arrow keys (which move through the rows) do not act as well.
    event.preventDefault();
    marks[index]?.setAttribute('tabindex', '-1');
    marks[next]?.setAttribute('tabindex', '0');
    marks[next]?.focus();
  });
  return holder;
}

/** Totals of a Money record in its own currencies, for a table cell: "$23.10", "" when empty. */
export function moneyCell(money: Money, currency: string): string {
  return formatMoneyTotals(money, currency);
}
