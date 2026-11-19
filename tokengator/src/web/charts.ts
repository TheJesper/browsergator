// Hand-drawn SVG charts. Three forms, each chosen for one job: a burn-up of the current window (change over
// time against an even-pace guide), columns of past windows (how much was left each time), and daily spend.

import type { MeterView } from '../core/forecast.js';
import { formatAmount, formatMoney, formatPercent } from '../core/format.js';
import type { SpendSummary } from '../core/spend.js';
import { formatMoment, toMs } from '../core/time.js';
import { expiredMoney } from '../core/wording.js';
import type { ClosedCycle } from '../core/types.js';
import { h, s } from './dom.js';
import { hideTip, showTip, withTip } from './ui.js';

let patternSeq = 0;

function hatchPattern(id: string): SVGElement {
  return s(
    'pattern',
    { id, width: 5, height: 5, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' },
    s('rect', { width: 5, height: 5, style: { fill: 'var(--expiring-soft)' } }),
    s('rect', { width: 2.5, height: 5, style: { fill: 'var(--expiring)' } })
  );
}

/**
 * Usage over the current window. The diagonal is an even pace; the solid line is what was actually used;
 * the dashed line carries the current pace to the reset; the hatched block at the right edge is what that
 * leaves unused.
 */
export function burnUp(view: MeterView, nowMs: number): HTMLElement {
  const start = view.windowStartMs;
  const end = view.resetsAtMs;
  if (start === null || end === null || end <= start || view.limit <= 0) {
    return h('p', { class: 'hint' }, view.needsReset ? 'Set the reset time to see the window.' : 'No window is running, so there is nothing to chart yet.');
  }
  const W = 360;
  const H = 156;
  const left = 34;
  const right = 18;
  const top = 12;
  const bottom = 24;
  const x = (ms: number): number => left + ((Math.min(Math.max(ms, start), end) - start) / (end - start)) * (W - left - right);
  const y = (fraction: number): number => top + (1 - Math.min(Math.max(fraction, 0), 1)) * (H - top - bottom);
  const clampedNow = Math.min(Math.max(nowMs, start), end);
  const patternId = `hatch-${(patternSeq += 1)}`;

  const samples = view.meter.samples
    .map((sample) => ({ t: toMs(sample.t) ?? 0, f: view.limit > 0 ? sample.used / view.limit : 0, used: sample.used }))
    .filter((sample) => sample.t >= start && sample.t <= end)
    .sort((a, b) => a.t - b.t);
  // The window opens at zero; the line holds its last value up to now.
  const points = [{ t: start, f: 0, used: 0 }, ...samples, { t: clampedNow, f: view.usedFraction, used: view.used }];
  const line = points.map((point, index) => `${index === 0 ? 'M' : 'L'}${x(point.t).toFixed(1)} ${y(point.f).toFixed(1)}`).join(' ');
  const area = `${line} L${x(clampedNow).toFixed(1)} ${y(0).toFixed(1)} L${x(start).toFixed(1)} ${y(0).toFixed(1)} Z`;

  const projected = view.tier !== null && view.projectedFraction !== null ? view.projectedFraction : null;
  // A window that has only just started has no forecast, and the chart must not draw one either.
  const showForecast = projected !== null && view.tier !== 'spent' && view.tier !== 'expired' && view.tier !== 'fresh' && nowMs < end;
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Usage over the current window: ${formatPercent(view.usedFraction)} used so far.` });
  svg.appendChild(s('defs', null, hatchPattern(patternId)));

  for (const tick of [0, 0.5, 1]) {
    svg.appendChild(s('line', { class: tick === 0 ? 'axis' : 'grid', x1: left, x2: W - right, y1: y(tick), y2: y(tick) }));
    svg.appendChild(s('text', { x: left - 6, y: y(tick) + 3.5, 'text-anchor': 'end' }, `${tick * 100}%`));
  }
  svg.appendChild(s('line', { class: 'guide', x1: x(start), y1: y(0), x2: x(end), y2: y(1) }));
  svg.appendChild(s('path', { class: 'area', d: area }));

  if (showForecast && projected !== null) {
    svg.appendChild(s('line', { class: 'proj', x1: x(clampedNow), y1: y(view.usedFraction), x2: x(end), y2: y(projected) }));
    if (view.projectedUnused >= 0.01) {
      // A 2px surface gap separates the block from the plot edge, like every other touching mark.
      svg.appendChild(
        s('rect', { x: x(end) + 2, y: y(1), width: 10, height: Math.max(1, y(projected) - y(1)), rx: 2, style: { fill: `url(#${patternId})` } })
      );
    }
  }
  svg.appendChild(s('path', { class: 'actual', d: line }));
  svg.appendChild(s('line', { class: 'nowline', x1: x(clampedNow), x2: x(clampedNow), y1: top, y2: H - bottom }));
  svg.appendChild(s('circle', { class: 'dot', cx: x(clampedNow), cy: y(view.usedFraction), r: 4.5 }));

  svg.appendChild(s('text', { x: left, y: H - 7, 'text-anchor': 'start' }, formatMoment(start, nowMs).replace(/ \d{2}:\d{2}$/, '')));
  svg.appendChild(s('text', { x: W - right, y: H - 7, 'text-anchor': 'end' }, `resets ${formatMoment(end, nowMs)}`));
  const nowX = x(clampedNow);
  if (nowX > left + 62 && nowX < W - right - 96) svg.appendChild(s('text', { x: nowX, y: H - 7, 'text-anchor': 'middle' }, 'now'));

  // Crosshair: the pointer only has to be near a reading, never on the 2px line.
  const cross = s('line', { class: 'cross', y1: top, y2: H - bottom, x1: 0, x2: 0, visibility: 'hidden' });
  const probe = s('circle', { class: 'dot', r: 4, visibility: 'hidden' });
  const hit = s('rect', { class: 'hit', x: left, y: top, width: W - left - right, height: H - top - bottom });
  hit.addEventListener('pointermove', (event) => {
    const pointer = event as PointerEvent;
    const box = svg.getBoundingClientRect();
    const px = ((pointer.clientX - box.left) / box.width) * W;
    let nearest = points[0];
    for (const point of points) {
      if (nearest === undefined || Math.abs(x(point.t) - px) < Math.abs(x(nearest.t) - px)) nearest = point;
    }
    if (!nearest) return;
    cross.setAttribute('x1', String(x(nearest.t)));
    cross.setAttribute('x2', String(x(nearest.t)));
    cross.setAttribute('visibility', 'visible');
    probe.setAttribute('cx', String(x(nearest.t)));
    probe.setAttribute('cy', String(y(nearest.f)));
    probe.setAttribute('visibility', 'visible');
    showTip(
      pointer.clientX,
      pointer.clientY,
      h('b', null, `${formatPercent(nearest.f)} used`),
      h('span', null, view.meter.unit === 'percent' ? '' : `, ${formatAmount(view.meter, nearest.used)}`),
      h('br'),
      h('span', null, formatMoment(nearest.t, nowMs))
    );
  });
  hit.addEventListener('pointerleave', () => {
    cross.setAttribute('visibility', 'hidden');
    probe.setAttribute('visibility', 'hidden');
    hideTip();
  });
  svg.append(cross, probe, hit);

  const legend = h(
    'div',
    { class: 'legend', style: { marginTop: '8px' }, 'aria-hidden': 'true' },
    h('span', null, h('i', { class: 'l-line' }), 'Used'),
    h('span', null, h('i', { class: 'l-guide' }), 'Even pace'),
    showForecast ? h('span', null, h('i', { class: 'l-dash' }), 'At this pace') : null,
    showForecast && view.projectedUnused >= 0.01 ? h('span', null, h('i', { class: 'l-exp' }), `${formatPercent(view.projectedUnused)} expires`) : null
  );
  return h('div', { class: 'chart' }, svg, legend);
}

/**
 * One column per finished window: the part that was used, and above it, solid, the part that expired.
 * Solid because it happened; the hatched version elsewhere is a forecast.
 */
export function cycleColumns(cycles: readonly ClosedCycle[], nowMs: number, width = 320): HTMLElement {
  if (cycles.length === 0) return h('p', { class: 'hint' }, 'No finished windows yet. History builds up as windows close.');
  const H = 70;
  const top = 4;
  const bottom = 16;
  const plot = H - top - bottom;
  const slot = Math.min(26, width / cycles.length);
  const bar = Math.min(18, slot - 6);
  const total = slot * cycles.length;
  const svg = s('svg', { viewBox: `0 0 ${total} ${H}`, style: { maxWidth: `${total}px` }, role: 'img', 'aria-label': `Utilisation of the last ${cycles.length} windows.` });
  svg.appendChild(s('line', { class: 'axis', x1: 0, x2: total, y1: H - bottom, y2: H - bottom }));
  cycles.forEach((cycle, index) => {
    const usedFraction = 1 - cycle.wastedFraction;
    const cx = index * slot + (slot - bar) / 2;
    const usedHeight = Math.max(usedFraction > 0 ? 2 : 0, usedFraction * plot);
    // The gap between the two parts is surface, not a stroke.
    const wastedHeight = cycle.wastedFraction >= 0.02 ? Math.max(2, cycle.wastedFraction * plot - 2) : 0;
    // An estimated window is drawn as outlines, at full strength: fading it would take it below 3:1.
    const group = s('g', { class: cycle.confidence === 'estimated' ? 'est' : null });
    if (usedHeight > 0) {
      group.appendChild(
        s('path', {
          class: cycle.wastedFraction < 0.02 ? 'col-ok' : 'col-used',
          d: roundedTop(cx, H - bottom - usedHeight, bar, usedHeight, wastedHeight > 0 ? 0 : 3)
        })
      );
    }
    if (wastedHeight > 0) {
      group.appendChild(s('path', { class: 'waste-solid', d: roundedTop(cx, top + (plot - usedHeight - 2 - wastedHeight), bar, wastedHeight, 3) }));
    }
    const ended = toMs(cycle.endedAt) ?? nowMs;
    const hit = s('rect', { class: 'hit', x: index * slot, y: 0, width: slot, height: H, tabindex: 0, 'aria-label': describeCycle(cycle, nowMs) });
    withTip(hit, () => [
      h('b', null, `${formatPercent(usedFraction)} used`),
      cycle.wastedFraction >= 0.005
        ? h(
            'span',
            null,
            `, ${cycle.confidence === 'estimated' ? 'about ' : ''}${formatPercent(cycle.wastedFraction)} expired${expiredMoney(cycle.wastedValue, cycle.currency, cycle.unit) ? ` (${expiredMoney(cycle.wastedValue, cycle.currency, cycle.unit)})` : ''}`
          )
        : h('span', null, ', nothing expired'),
      h('br'),
      h('span', null, `ended ${formatMoment(ended, nowMs)}`)
    ]);
    svg.append(group, hit);
  });
  const first = cycles[0];
  const last = cycles[cycles.length - 1];
  if (first && last) {
    // Two dates need room; a short run of columns gets only the latest one.
    if (total >= 110) svg.appendChild(s('text', { x: 0, y: H - 3, 'text-anchor': 'start' }, shortDate(toMs(first.endedAt) ?? nowMs)));
    svg.appendChild(s('text', { x: total, y: H - 3, 'text-anchor': 'end' }, shortDate(toMs(last.endedAt) ?? nowMs)));
  }
  return h('div', { class: 'chart' }, svg);
}

function describeCycle(cycle: ClosedCycle, nowMs: number): string {
  const ended = formatMoment(toMs(cycle.endedAt) ?? nowMs, nowMs);
  return `Window ended ${ended}: ${formatPercent(1 - cycle.wastedFraction)} used, ${formatPercent(cycle.wastedFraction)} expired.`;
}

export function shortDate(ms: number): string {
  const date = new Date(ms);
  return `${date.getDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][date.getMonth()] ?? ''}`;
}

/** A bar with a rounded data end and a square baseline. */
export function roundedTop(x: number, y: number, width: number, height: number, radius: number): string {
  const r = Math.min(radius, width / 2, height);
  return `M${x} ${y + height} V${y + r} Q${x} ${y} ${x + r} ${y} H${x + width - r} Q${x + width} ${y} ${x + width} ${y + r} V${y + height} Z`;
}

/** Daily API spend for the last 30 days, with the daily budget as a reference line when there is one. */
export function dailyBars(summary: SpendSummary): HTMLElement {
  const series = summary.series;
  const currency = summary.source.currency;
  const W = 560;
  const H = 132;
  const left = 46;
  const right = 6;
  const top = 8;
  const bottom = 20;
  const plotW = W - left - right;
  const plotH = H - top - bottom;
  const budgetPerDay = summary.source.monthlyBudget ? summary.source.monthlyBudget / 30.44 : null;
  const peak = Math.max(...series.map((point) => point.amount), budgetPerDay ?? 0, 0.01);
  const max = niceCeil(peak);
  const slot = plotW / series.length;
  const bar = Math.min(12, slot - 2);
  const y = (value: number): number => top + (1 - value / max) * plotH;

  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Daily spend over the last ${series.length} days, ${formatMoney(summary.monthToDate, currency)} this month.` });
  for (const tick of [0, max / 2, max]) {
    svg.appendChild(s('line', { class: tick === 0 ? 'axis' : 'grid', x1: left, x2: W - right, y1: y(tick), y2: y(tick) }));
    svg.appendChild(s('text', { x: left - 6, y: y(tick) + 3.5, 'text-anchor': 'end' }, formatMoney(tick, currency)));
  }
  series.forEach((point, index) => {
    const cx = left + index * slot + (slot - bar) / 2;
    const height = point.amount > 0 ? Math.max(1.5, (point.amount / max) * plotH) : 0;
    if (height > 0) {
      svg.appendChild(
        s('path', { class: index === series.length - 1 ? 'col-today' : 'col-spend', d: roundedTop(cx, H - bottom - height, bar, height, 2.5) })
      );
    }
    const hit = s('rect', { class: 'hit', x: left + index * slot, y: top, width: slot, height: plotH, tabindex: -1 });
    withTip(hit, () => [h('b', null, formatMoney(point.amount, currency)), h('br'), h('span', null, dayLabel(point.date))]);
    svg.appendChild(hit);
  });
  if (budgetPerDay !== null) {
    svg.appendChild(s('line', { class: 'budget', x1: left, x2: W - right, y1: y(budgetPerDay), y2: y(budgetPerDay) }));
  }
  const firstPoint = series[0];
  const lastPoint = series[series.length - 1];
  if (firstPoint && lastPoint) {
    svg.appendChild(s('text', { x: left, y: H - 5, 'text-anchor': 'start' }, dayLabel(firstPoint.date)));
    svg.appendChild(s('text', { x: W - right, y: H - 5, 'text-anchor': 'end' }, 'today'));
  }
  return h(
    'div',
    { class: 'chart' },
    svg,
    h(
      'div',
      { class: 'legend', 'aria-hidden': 'true' },
      h('span', null, h('i', { class: 'l-used' }), 'Daily spend'),
      h('span', null, h('i', { class: 'l-today' }), 'Today so far'),
      budgetPerDay !== null ? h('span', null, h('i', { class: 'l-budget' }), 'Budget per day') : null
    )
  );
}

/** A calendar day ("2026-10-21") the way every other date on the page reads: "21 Oct". */
function dayLabel(date: string): string {
  const [, month, day] = date.split('-').map(Number);
  const name = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][(month ?? 1) - 1] ?? '';
  return day && name ? `${day} ${name}` : date;
}

/** Rounds a maximum up to a clean axis value: 1, 2, 2.5, 5 or 10 times a power of ten. */
export function niceCeil(value: number): number {
  const power = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 2.5, 5, 10]) {
    if (value <= step * power) return step * power;
  }
  return 10 * power;
}
