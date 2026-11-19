// The Overview: one screen of tiles that cut across subscriptions. Each answers one question about not
// letting quota expire unused. Tiles are built first; their charts are drawn afterwards at the width the
// tile actually has (see drawOverviewCharts), so labels keep their size on every screen.

import { agentPrompt, weeksMarkdown } from '../core/brief.js';
import { compareViews, ledgerTotals, type MeterView, type Money } from '../core/forecast.js';
import { formatMoney, formatMoneyTotals, formatPercent } from '../core/format.js';
import { blockedLimits, countTiers, expiryOutlook, ledgerWeeks, nextUseNow, plottable, refreshList, wasteBy, type ExpiryOutlook } from '../core/insights.js';
import { summariseSpend } from '../core/spend.js';
import { DAY, formatMoment, localZone } from '../core/time.js';
import {
  FIGURE_LABEL,
  TIER_LABEL,
  finishLine,
  lostMoney,
  lostText,
  moneyPair,
  nextUseNowLine,
  paceCaption,
  readingAge,
  stateLabel,
  trendText,
  utilisationText,
  expiryCaption
} from '../core/wording.js';
import { OVERVIEW_TILES, type OverviewTileId } from './app.js';
import type { Ctx } from './ctx.js';
import { h, icon, type Child } from './dom.js';
import { expiryColumns, paceMap, weeklyPanels, willExpire } from './overview-charts.js';
import { barCaption, barLegend, resetText, stateKey, stateMark } from './parts.js';
import { copyMenuButton, copyText, markFocus, restoreFocus } from './ui.js';
import { queueRow } from './views.js';

/** Tiles whose table is shown instead of their chart. Kept here so a redraw keeps the choice. */
const openTables = new Set<OverviewTileId>();
/** How each chart slot draws itself at a given width. Set when the tiles are built. */
const drawers = new WeakMap<HTMLElement, (width: number) => Element>();

/** Below this many pixels of chart width, or above this many quotas, the even-pace chart gives way to its table. */
const PACE_MIN_WIDTH = 360;
const PACE_MAX_MARKS = 60;

function addMoney(target: Money, currency: string | null, amount: number | null): void {
  if (!currency || amount === null || !(amount > 0)) return;
  target[currency] = (target[currency] ?? 0) + amount;
}

const hasMoney = (money: Money): boolean => Object.values(money).some((amount) => amount > 0.004);

/**
 * A quota's name for places CSS cannot hide (tooltips live outside the page): account and meter, or only the
 * meter while names are hidden. Meter names such as "Weekly limit" are not account names.
 */
export function nameOf(ctx: Ctx, view: MeterView | undefined, fallback = ''): string {
  if (!view) return fallback;
  return ctx.app.model.prefs.privacy ? view.meter.label : `${view.account.label}, ${view.meter.label}`;
}

/** The name as page content: the account part hidden with the others on a shared screen. */
function nameNodes(view: MeterView): Child[] {
  return [h('span', { class: 'private' }, view.account.label), `, ${view.meter.label}`];
}

function quotaButton(ctx: Ctx, view: MeterView, tile: string, extra: Child[] = []): HTMLButtonElement {
  const { selectedId } = ctx.app.model;
  return h(
    'button',
    {
      class: 'ov-quota',
      type: 'button',
      id: `ov-${tile}-q-${view.id}`,
      'aria-expanded': String(selectedId === view.id),
      dataset: { id: view.id, nav: 'row' },
      onclick: () => ctx.app.select(selectedId === view.id ? null : view.id)
    },
    h('span', { class: 'ov-name' }, ...nameNodes(view)),
    ...extra
  ) as HTMLButtonElement;
}

function dataTable(head: string[], rows: Child[][], right: number[] = []): HTMLElement {
  return h(
    'div',
    { class: 'table-wrap ov-table' },
    h(
      'table',
      { class: 'tbl' },
      h('thead', null, h('tr', null, head.map((label, i) => h('th', { class: right.includes(i) ? 'r' : null, scope: 'col' }, label)))),
      h('tbody', null, rows.map((cells) => h('tr', null, cells.map((cell, i) => h('td', { class: right.includes(i) ? 'r' : null }, cell)))))
    )
  );
}

interface TileParts {
  id: OverviewTileId;
  /** A figure or count beside the title. */
  aside?: Child;
  tools?: Child[];
  body: Child[];
  /** The chart and its table, when the tile has both: the toggle switches between them. */
  chart?: { slot: HTMLElement; table: HTMLElement; caption?: string; legend?: Child; forceTable?: boolean };
}

function tile(ctx: Ctx, parts: TileParts): HTMLElement {
  const title = OVERVIEW_TILES.find((entry) => entry.id === parts.id)?.title ?? parts.id;
  const tools: Child[] = [...(parts.tools ?? [])];
  const chart = parts.chart;
  let figure: HTMLElement | null = null;
  if (chart) {
    const showTable = (open: boolean): void => {
      chart.slot.hidden = open || chart.forceTable === true;
      chart.table.hidden = !open && chart.forceTable !== true;
      toggle.setAttribute('aria-pressed', String(open));
      toggle.lastChild!.textContent = open ? 'Chart' : 'Table';
      if (!chart.slot.hidden) drawSlot(chart.slot, true);
    };
    const toggle = h(
      'button',
      {
        class: 'btn small quiet',
        type: 'button',
        id: `ov-tbl-${parts.id}`,
        'aria-pressed': String(openTables.has(parts.id)),
        hidden: chart.forceTable === true,
        onclick: () => {
          if (openTables.has(parts.id)) openTables.delete(parts.id);
          else openTables.add(parts.id);
          showTable(openTables.has(parts.id));
        }
      },
      icon('rows'),
      h('span', null, openTables.has(parts.id) ? 'Chart' : 'Table')
    );
    tools.unshift(toggle);
    chart.slot.hidden = openTables.has(parts.id) || chart.forceTable === true;
    chart.table.hidden = !openTables.has(parts.id) && chart.forceTable !== true;
    figure = h('figure', { class: 'ov-figure', 'aria-labelledby': `ov-h-${parts.id}` }, chart.slot, chart.table, chart.legend ?? null, chart.caption ? h('figcaption', null, chart.caption) : null);
  }
  return h(
    'section',
    { class: 'tile', 'aria-labelledby': `ov-h-${parts.id}`, dataset: { tile: parts.id } },
    h('div', { class: 'tile-head' }, h('h2', { id: `ov-h-${parts.id}` }, title), parts.aside ? h('span', { class: 'tile-aside' }, parts.aside) : null, h('span', { class: 'tile-tools' }, tools)),
    ...parts.body,
    figure
  );
}

function link(label: string, onclick: () => void): HTMLElement {
  return h('button', { class: 'link ov-more', type: 'button', onclick }, label, icon('chevron'));
}

// ---------------------------------------------------------------------------
// The tiles
// ---------------------------------------------------------------------------

function leadTile(ctx: Ctx, allowances: MeterView[]): HTMLElement {
  const { now } = ctx.app.model;
  const tz = localZone();
  const awake = allowances.filter((view) => !view.snoozed).sort(compareViews('use-first'));
  const useNow = awake.filter((view) => view.tier === 'use-now');
  const behind = awake.filter((view) => view.tier === 'behind');
  const body: Child[] = [];
  let shown: MeterView[] = [];
  if (useNow.length > 0) {
    shown = useNow.slice(0, 4);
    body.push(h('ul', { class: 'rows' }, shown.map((view) => queueRow(ctx, view))));
    const first = shown[0] as MeterView;
    const finish = finishLine(first, now, tz);
    if (finish) {
      body.push(
        h(
          'p',
          { class: 'ov-finish' },
          h('span', null, ...nameNodes(first), ': ', finish),
          h('button', { class: 'btn small quiet', type: 'button', id: 'ov-lead-prompt', onclick: () => void copyText(agentPrompt(first, now), 'Agent prompt copied') }, icon('copy'), 'Copy agent prompt')
        )
      );
    }
  } else if (behind.length > 0) {
    shown = behind.slice(0, 3);
    body.push(h('p', { class: 'ov-note' }, 'Nothing needs using now. Behind pace:'));
    body.push(h('ul', { class: 'rows' }, shown.map((view) => queueRow(ctx, view))));
    const next = nextUseNow(awake, now);
    if (next) body.push(h('p', { class: 'ov-finish' }, h('span', null, ...nameNodes(next.view), ' ', nextUseNowLine(next.atMs, now, tz), '.')));
  } else {
    body.push(h('p', { class: 'ov-empty' }, allowances.length > 0 && awake.length === 0 ? 'Every quota is snoozed.' : 'Nothing is going to waste right now.'));
  }
  const more = useNow.length + behind.length - shown.length;
  if (more > 0) body.push(link(`${more} more in the Queue`, () => ctx.actions.view('queue')));
  return tile(ctx, { id: 'lead', body });
}

function expiryTile(ctx: Ctx, filtered: MeterView[], allowances: MeterView[]): HTMLElement {
  const { now, state } = ctx.app.model;
  const currency = state.settings.currency;
  const tz = localZone();
  const awake = allowances.filter((view) => !view.snoozed);
  const atRisk: Money = {};
  const credits: Money = {};
  for (const view of awake) addMoney(view.valueBasis === 'credit' ? credits : atRisk, view.currency, view.valueAtRisk);
  const noPrices = awake.length > 0 && !awake.some((view) => view.windowValue !== null);
  const outlook = expiryOutlook(filtered, now, 30, tz);
  const figure = moneyPair(atRisk, credits, currency);
  const stat = `${FIGURE_LABEL.atRisk}: ${figure || 'nothing is expected to expire'}`;
  const anyReset = outlook.days.some((day) => day.entries.length > 0) || outlook.later.firstMs !== null;
  const views = new Map(filtered.map((view) => [view.id, view]));
  const body: Child[] = [h('p', { class: 'ov-stat' }, h('span', { class: 'label' }, `${FIGURE_LABEL.atRisk}`), h('span', { class: 'big' }, figure || formatMoney(0, currency)))];
  const tools: Child[] = [
    copyMenuButton(
      [
        { label: 'Copy figure', text: () => `${stat}.`, toast: 'Figure copied' },
        { label: 'Copy as Markdown', text: () => expiryMarkdown(ctx, outlook, views, currency), toast: 'Table copied as Markdown' }
      ],
      'Copy what expires'
    )
  ];
  if (!anyReset) {
    body.push(h('p', { class: 'ov-empty' }, awake.length === 0 && allowances.length > 0 ? 'Every quota is snoozed.' : 'No quota resets in the next 30 days.'));
    return tile(ctx, { id: 'expiry', tools, body });
  }
  const slot = h('div', { class: 'tile-chart', dataset: { chart: 'expiry' } });
  drawers.set(slot, (width) =>
    expiryColumns(outlook, width, {
      currency,
      noPrices,
      nameOf: (id) => nameOf(ctx, views.get(id), 'A quota'),
      onSelect: (id) => ctx.app.select(ctx.app.model.selectedId === id ? null : id),
      nowMs: now,
      tz
    })
  );
  return tile(ctx, { id: 'expiry', tools, body, chart: { slot, table: expiryTable(ctx, outlook, views, currency), caption: expiryCaption(outlook, currency, now, tz, noPrices) } });
}

function expiryRows(outlook: ExpiryOutlook): { day: string; entry: ExpiryOutlook['days'][number]['entries'][number] }[] {
  return outlook.days.flatMap((day) => day.entries.filter((entry) => entry.current).map((entry) => ({ day: day.date, entry })));
}

function expiryTable(ctx: Ctx, outlook: ExpiryOutlook, views: Map<string, MeterView>, currency: string): HTMLElement {
  const { now } = ctx.app.model;
  const rows = expiryRows(outlook).flatMap(({ entry }) => {
    const view = views.get(entry.id);
    if (!view) return [];
    const money = entry.valueAtRisk !== null && entry.valueAtRisk > 0.004 && entry.currency ? formatMoney(entry.valueAtRisk, entry.currency) : '';
    return [[formatMoment(entry.atMs, now).replace(/ \d\d:\d\d$/, ''), quotaButton(ctx, view, 'expiry'), formatMoment(entry.atMs, now), entry.tier === 'spent' ? 'used up' : formatPercent(entry.projectedUnused), entry.basis === 'credit' ? '' : money, entry.basis === 'credit' ? money : ''] as Child[]];
  });
  if (rows.length === 0) rows.push(['', 'No current window resets in the next 30 days.', '', '', '', '']);
  const later = moneyPair(outlook.later.plan, outlook.later.credits, currency);
  if (later) rows.push(['After 30 days', `${outlook.later.count === 1 ? '1 quota' : `${outlook.later.count} quotas`}`, outlook.later.firstMs ? `from ${formatMoment(outlook.later.firstMs, now)}` : '', '', formatMoneyTotals(outlook.later.plan, currency), formatMoneyTotals(outlook.later.credits, currency)]);
  return dataTable(['Day', 'Quota', 'Resets', 'Will expire', 'Plan money', 'Credits'], rows, [3, 4, 5]);
}

function expiryMarkdown(ctx: Ctx, outlook: ExpiryOutlook, views: Map<string, MeterView>, currency: string): string {
  const { now } = ctx.app.model;
  const lines = ['| Resets | Quota | Will expire | Plan money | Credits |', '| --- | --- | --- | --- | --- |'];
  for (const { entry } of expiryRows(outlook)) {
    const view = views.get(entry.id);
    if (!view) continue;
    const money = entry.valueAtRisk !== null && entry.valueAtRisk > 0.004 && entry.currency ? formatMoney(entry.valueAtRisk, entry.currency) : '';
    lines.push(`| ${formatMoment(entry.atMs, now)} | ${nameOf(ctx, view).replace(/\|/g, '\\|')} | ${entry.tier === 'spent' ? 'used up' : formatPercent(entry.projectedUnused)} | ${entry.basis === 'credit' ? '' : money} | ${entry.basis === 'credit' ? money : ''} |`);
  }
  const later = moneyPair(outlook.later.plan, outlook.later.credits, currency);
  if (later) lines.push(`| after 30 days | ${outlook.later.count} more | | ${formatMoneyTotals(outlook.later.plan, currency)} | ${formatMoneyTotals(outlook.later.credits, currency)} |`);
  return lines.join('\n');
}

function windowsTile(ctx: Ctx): HTMLElement {
  const { now, state } = ctx.app.model;
  const currency = state.settings.currency;
  const tz = localZone();
  const cycles = ctx.app.cycles();
  if (cycles.length === 0) {
    return tile(ctx, { id: 'windows', body: [h('p', { class: 'ov-empty' }, 'Nothing has expired on record yet. Each window that closes is recorded here.')] });
  }
  const t30 = ledgerTotals(cycles, now, 30);
  const before = ledgerTotals(cycles, now - 30 * DAY, 30);
  const lost = t30.cycles30 > 0 ? lostText(t30.lost30, t30.creditsLost30, currency, t30.lostIsEstimate, t30.creditsLostIsEstimate) : 'no window closed';
  // The plan figure leads; the credits follow on a quieter line, still never added to it.
  const [lostLead, lostAlso] = lost.includes(', plus ') ? [lost.slice(0, lost.indexOf(', plus ')), lost.slice(lost.indexOf(', plus ') + 2)] : [lost, ''];
  const trend = t30.cycles30 > 0 ? trendText(t30.lost30, before.lost30, currency, t30.lostIsEstimate || before.lostIsEstimate, before.cycles30) : null;
  const used = utilisationText(t30.utilisation30, t30.cycles30);
  const weeks = ledgerWeeks(cycles, now, 12, tz);
  const recorded = weeks.filter((week) => week.windows > 0).length;
  const glyph = trend?.trend === 'up' ? '▲' : trend?.trend === 'down' ? '▼' : trend?.trend === 'flat' ? '=' : '';
  const body: Child[] = [
    h(
      'div',
      { class: 'ov-pair' },
      h(
        'p',
        { class: 'ov-stat' },
        h('span', { class: 'label' }, FIGURE_LABEL.lost30),
        h('span', { class: 'big risk' }, lostLead, lostAlso ? h('span', { class: 'also' }, ` ${lostAlso}`) : null),
        trend ? h('span', { class: `ov-trend ${trend.trend ?? ''}` }, glyph ? h('span', { 'aria-hidden': 'true' }, `${glyph} `) : null, trend.text) : null
      ),
      h(
        'p',
        { class: 'ov-stat' },
        h('span', { class: 'label' }, FIGURE_LABEL.used30),
        h('span', { class: 'big' }, t30.utilisation30 === null ? '—' : formatPercent(t30.utilisation30)),
        h('span', { class: 'ov-sub' }, t30.utilisation30 === null ? used : used.replace(/^\d+% used /, ''))
      )
    )
  ];
  const tools: Child[] = [
    copyMenuButton(
      [
        { label: 'Copy figures', text: () => `${FIGURE_LABEL.lost30}: ${lost}${trend ? ` (${trend.text.replace(/\.$/, '').toLowerCase()})` : ''}. ${FIGURE_LABEL.used30}: ${used}.`, toast: 'Figures copied' },
        { label: 'Copy as Markdown', text: () => weeksMarkdown(weeks, currency, tz), toast: 'Table copied as Markdown' }
      ],
      'Copy finished windows'
    )
  ];
  if (recorded < 4) {
    body.push(h('p', { class: 'ov-note' }, 'The weekly charts appear once four weeks hold finished windows.'));
    return tile(ctx, { id: 'windows', tools, body });
  }
  const slot = h('div', { class: 'tile-chart', dataset: { chart: 'windows' } });
  drawers.set(slot, (width) => weeklyPanels(weeks, width, currency, now));
  const rows = weeks.map((week) => [
    formatMoment(week.startMs, now).replace(/ \d\d:\d\d$/, ''),
    String(week.windows),
    week.windows === 0 ? 'no window closed' : formatMoneyTotals(week.lost, currency, formatMoney(0, currency)),
    formatMoneyTotals(week.lostEstimated, currency),
    formatMoneyTotals(week.creditsLost, currency),
    week.trailingUtilisation === null ? '' : formatPercent(week.trailingUtilisation)
  ]);
  return tile(ctx, {
    id: 'windows',
    tools,
    body,
    chart: {
      slot,
      table: dataTable(['Week of', 'Windows', 'Expired', 'Of which estimated', 'Credits expired', 'Used, 30 days'], rows, [1, 2, 3, 4, 5]),
      caption: 'Expired money is solid; the part from windows nobody read near their reset is outlined. A week with no column had no window close. The line is the share used over the 30 days ending each week.'
    }
  });
}

function attentionTile(ctx: Ctx, filtered: MeterView[]): HTMLElement {
  const { now, collectors, backend } = ctx.app.model;
  const stale = refreshList(filtered);
  const blocked = blockedLimits(filtered, now);
  const enabled = new Set(collectors.filter((collector) => collector.enabled).map((collector) => collector.id));
  const items: HTMLElement[] = [];
  for (const view of stale) {
    const automatic = view.meter.source.kind === 'collector' && view.meter.source.id !== undefined && enabled.has(view.meter.source.id);
    items.push(
      h(
        'li',
        { class: 'ov-item' },
        quotaButton(ctx, view, 'attention', [h('span', { class: 'ov-sub' }, view.needsReset && view.ageMs !== null ? 'reset time unknown' : readingAge(view))]),
        automatic
          ? h('button', { class: 'btn small', type: 'button', onclick: () => void ctx.actions.run(backend.refresh(), 'Refreshed') }, icon('refresh'), 'Refresh')
          : h('button', { class: 'btn small', type: 'button', onclick: () => ctx.actions.quick(`${view.meter.id} `) }, icon('edit'), 'Update')
      )
    );
  }
  for (const view of blocked) {
    items.push(
      h(
        'li',
        { class: 'ov-item' },
        quotaButton(ctx, view, 'attention', [h('span', { class: 'ov-sub' }, 'closed, reopens in ', resetText(view.resetsAtMs, now, { times: 'countdown' }))]),
        h('span', { class: 'state t-blocked' }, stateMark('blocked'), 'Blocked')
      )
    );
  }
  const body: Child[] = [];
  if (items.length === 0) body.push(h('p', { class: 'ov-empty' }, 'Every reading is recent, and no limit is closed.'));
  else {
    body.push(h('ul', { class: 'ov-list' }, items.slice(0, 5)));
    if (items.length > 5) {
      body.push(
        link(`${items.length - 5} more in the Queue`, () => {
          ctx.app.setPrefs({ sort: 'updated' });
          ctx.actions.view('queue');
        })
      );
    }
  }
  const aside = stale.length > 0 ? `${stale.length === 1 ? '1 reading' : `${stale.length} readings`} to refresh` : null;
  return tile(ctx, { id: 'attention', aside, body });
}

function paceTile(ctx: Ctx, filtered: MeterView[]): HTMLElement | null {
  const { now, selectedId } = ctx.app.model;
  const plotted = filtered.filter(plottable).sort(compareViews('use-first'));
  if (plotted.length === 0) return null;
  const rank = new Map(plotted.map((view, i) => [view.id, i + 1]));
  const views = new Map(filtered.map((view) => [view.id, view]));
  const tiers = [...new Set(plotted.map((view) => view.tier))];
  const legend = h(
    'div',
    { class: 'legend ov-legend', 'aria-hidden': 'true' },
    tiers.map((tier) => h('span', null, h('span', { class: 'pm-key' }, stateMark(tier ?? 'idle')), TIER_LABEL[tier ?? 'idle'])),
    h('span', null, h('i', { class: 'l-risk' }), 'part expected to expire'),
    h('span', null, h('i', { class: 'l-quiet' }), 'nothing expected to expire')
  );
  const slot = h('div', { class: 'tile-chart', dataset: { chart: 'pace' } });
  const table = paceTable(ctx, plotted, rank);
  drawers.set(slot, (width) =>
    width < PACE_MIN_WIDTH || plotted.length > PACE_MAX_MARKS
      ? paceTable(ctx, plotted, rank, 'pace-narrow')
      : paceMap(plotted, width, {
          rankOf: (id) => rank.get(id) ?? 0,
          selected: plotted.find((view) => view.id === selectedId) ?? null,
          nowMs: now,
          nameOf: (id) => nameOf(ctx, views.get(id), 'A quota'),
          onSelect: (id) => ctx.app.select(ctx.app.model.selectedId === id ? null : id)
        })
  );
  const throttles = filtered.filter((view) => view.tier === null).length;
  return tile(ctx, {
    id: 'pace',
    body: [],
    chart: { slot, table, legend, caption: paceCaption(countTiers(filtered), throttles), forceTable: plotted.length > PACE_MAX_MARKS }
  });
}

/** `where` keeps element ids unique when the table is drawn in the chart's place as well as kept beside it. */
function paceTable(ctx: Ctx, plotted: MeterView[], rank: Map<string, number>, where = 'pace'): HTMLElement {
  const { now } = ctx.app.model;
  return dataTable(
    ['#', 'Quota', 'State', 'Window gone', 'Used', 'On pace for', 'Will expire', 'Resets'],
    plotted.map((view) => [
      String(rank.get(view.id) ?? ''),
      quotaButton(ctx, view, where),
      h('span', { class: `state t-${stateKey(view)}` }, stateMark(stateKey(view)), stateLabel(view)),
      formatPercent(view.elapsedFraction ?? 0),
      formatPercent(view.usedFraction),
      view.projectedFraction === null || view.tier === 'fresh' ? '' : formatPercent(view.projectedFraction),
      willExpire(view) ? formatPercent(view.projectedUnused) : '',
      view.resetsAtMs === null ? '' : formatMoment(view.resetsAtMs, now)
    ]),
    [0, 3, 4, 5, 6]
  );
}

function fitTile(ctx: Ctx, filtered: MeterView[]): HTMLElement | null {
  const { now, state, selectedId } = ctx.app.model;
  const currency = state.settings.currency;
  const rows = wasteBy(ctx.app.cycles(), now, 90, currency);
  if (rows.length === 0) return null;
  const live = new Set(filtered.map((view) => view.id));
  const shown = rows.slice(0, 6);
  const items = shown.map((row) => {
    const planLost = hasMoney(row.lost) ? lostMoney(row.lost, currency, row.lostIsEstimate) : '';
    const creditLost = hasMoney(row.creditsLost) ? `${lostMoney(row.creditsLost, currency, row.creditsIsEstimate)} in credits` : '';
    const money = planLost && creditLost ? `${planLost} left unused, plus ${creditLost}` : planLost ? `${planLost} left unused` : creditLost ? `${creditLost} left unused` : 'nothing expired';
    const sub = `${money}, ${row.windows === 1 ? '1 window' : `${row.windows} windows`}`;
    const content: Child[] = [
      h('span', { class: 'fit-name private' }, row.accountLabel),
      h('span', { class: 'fit-track', 'aria-hidden': 'true' }, h('i', { class: 'fit-used', style: { width: `${Math.round(row.utilisation * 100)}%` } }), h('i', { class: 'fit-lost', style: { width: `${100 - Math.round(row.utilisation * 100)}%` } })),
      h('span', { class: 'fit-fig' }, `${formatPercent(row.utilisation)} used`),
      h('span', { class: 'fit-sub' }, sub)
    ];
    const open = live.has(row.topMeterId);
    return h(
      'li',
      null,
      open
        ? h(
            'button',
            {
              class: 'fit-row',
              type: 'button',
              id: `ov-fit-${row.accountId}`,
              'aria-expanded': String(selectedId === row.topMeterId),
              dataset: { id: row.topMeterId, nav: 'row' },
              onclick: () => ctx.app.select(ctx.app.model.selectedId === row.topMeterId ? null : row.topMeterId)
            },
            ...content
          )
        : h('div', { class: 'fit-row' }, ...content)
    );
  });
  const body: Child[] = [h('p', { class: 'ov-note' }, 'The share of each finished window used, on average. Most money left unused first.'), h('ul', { class: 'fit-list' }, items)];
  if (rows.length > shown.length) body.push(link(`${rows.length - shown.length} more in History`, () => ctx.actions.view('history')));
  return tile(ctx, { id: 'fit', body });
}

function spendTile(ctx: Ctx): HTMLElement | null {
  const { now, state } = ctx.app.model;
  if (state.spend.length === 0 || ctx.app.filtering()) return null;
  const tz = localZone();
  const items = state.spend.map((source) => {
    const summary = summariseSpend(source, now, tz);
    const budget = source.monthlyBudget;
    const status = budget === null ? 'No budget set.' : summary.overBudget ? 'Over budget.' : summary.headingOver ? 'Heading over budget.' : 'Within budget.';
    return h(
      'li',
      { class: 'spend-row' },
      h('span', { class: 'fit-name private' }, source.label),
      h('span', { class: 'fit-fig' }, formatMoney(summary.monthToDate, source.currency), h('span', { class: 'ov-sub' }, ' this month')),
      budget !== null
        ? h(
            'span',
            { class: 'budget-bar', role: 'img', 'aria-label': `${formatPercent(Math.min(1, summary.budgetFraction ?? 0))} of the ${formatMoney(budget, source.currency)} budget used` },
            h('i', { class: summary.overBudget ? 'over' : summary.headingOver ? 'heading' : '', style: { width: `${Math.min(100, (summary.budgetFraction ?? 0) * 100)}%` } }),
            h('b', { style: { left: `min(calc(100% - 2px), ${Math.min(100, (summary.projected / budget) * 100)}%)` }, title: 'Projected month end' })
          )
        : null,
      h(
        'span',
        { class: 'fit-sub' },
        `Projected ${formatMoney(summary.projected, source.currency)}${budget !== null ? ` of ${formatMoney(budget, source.currency)}` : ''}. `,
        h('span', { class: summary.overBudget || summary.headingOver ? 'heading' : null }, summary.headingOver && !summary.overBudget ? [h('span', { 'aria-hidden': 'true' }, '▲ '), status] : status)
      )
    );
  });
  return tile(ctx, { id: 'spend', body: [h('ul', { class: 'fit-list' }, items), link('Open Costs', () => ctx.actions.view('costs'))] });
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

/** Which tiles the viewer has not hidden, in their order. */
export function visibleTiles(hidden: readonly OverviewTileId[]): OverviewTileId[] {
  return OVERVIEW_TILES.filter((entry) => !entry.hideable || !hidden.includes(entry.id)).map((entry) => entry.id);
}

export function overviewView(ctx: Ctx): HTMLElement {
  const { prefs, filterText } = ctx.app.model;
  const filtered = ctx.app.filtered();
  const allowances = filtered.filter((view) => view.tier !== null);
  const build: Record<OverviewTileId, () => HTMLElement | null> = {
    lead: () => leadTile(ctx, allowances),
    expiry: () => expiryTile(ctx, filtered, allowances),
    windows: () => windowsTile(ctx),
    attention: () => attentionTile(ctx, filtered),
    pace: () => paceTile(ctx, filtered),
    fit: () => fitTile(ctx, filtered),
    spend: () => spendTile(ctx)
  };
  const tiles = visibleTiles(prefs.overviewHidden)
    .map((id) => build[id]())
    .filter((el): el is HTMLElement => el !== null);
  const scope = ctx.app.filtering()
    ? h(
        'p',
        { class: 'ov-scope', role: 'status' },
        prefs.category !== 'all' && filterText.trim()
          ? `Showing matches for "${filterText.trim()}" in one category.`
          : prefs.category !== 'all'
            ? 'Showing one category only.'
            : `Showing matches for "${filterText.trim()}".`,
        ' The sentence above counts everything.'
      )
    : null;
  return h('div', { class: 'ov' }, scope, h('div', { class: 'ov-grid', dataset: { count: tiles.length } }, tiles));
}

/** Draws one chart slot at its width, keeping focus on the same control when it was inside. */
function drawSlot(slot: HTMLElement, force = false): void {
  const draw = drawers.get(slot);
  if (!draw || slot.hidden) return;
  const width = Math.floor(slot.clientWidth);
  if (width < 40) return;
  const drawn = Number(slot.dataset['drawn'] ?? '0');
  if (!force && slot.firstChild && Math.abs(width - drawn) < 8) return;
  const mark = slot.contains(document.activeElement) ? markFocus(slot, []) : null;
  // A drawing gets the chart styles; a table drawn in its place keeps the table's own.
  const drawn_ = draw(width);
  slot.replaceChildren(drawn_.classList.contains('table-wrap') ? drawn_ : h('div', { class: 'chart' }, drawn_));
  slot.dataset['drawn'] = String(width);
  if (mark) restoreFocus(slot, mark);
}

/** The second pass: every visible chart drawn at the width its tile has now. */
export function drawOverviewCharts(pane: HTMLElement, force = false): void {
  for (const slot of pane.querySelectorAll<HTMLElement>('.tile-chart[data-chart]')) drawSlot(slot, force);
}

/** The caption that goes with a row the lead tile shows, for tests and copy. */
export function leadCaption(view: MeterView, nowMs: number): string {
  return barCaption(view, nowMs).text;
}

/** Figures the summary strip leaves out on the Overview while the tile that states them is shown. */
export function figuresInTiles(hidden: readonly OverviewTileId[]): { atRisk: boolean; lost: boolean; stale: boolean } {
  const visible = new Set(visibleTiles(hidden));
  return { atRisk: visible.has('expiry'), lost: visible.has('windows'), stale: visible.has('attention') };
}

export { barLegend };
