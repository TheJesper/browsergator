// The four meter views. Each is a projection of the same ordered, filtered list, so sorting and filtering
// behave identically everywhere.

import { TIER_ORDER, type MeterView, type Money, type SortOrder, type Tier } from '../core/forecast.js';
import { formatAmount, formatMoney, formatPercent } from '../core/format.js';
import { nextBoundary } from '../core/reset.js';
import { DAY, HOUR, formatDuration, formatMoment, zonedParts, localZone, weekdayNames, monthNames } from '../core/time.js';
import { CREDIT_VALUE_NOTE, PLAN_VALUE_NOTE, TIER_HINT, TIER_LABEL, leftText, moneyPair, riskMoney } from '../core/wording.js';
import { SORT_ORDERS } from '../core/forecast.js';
import type { Ctx } from './ctx.js';
import { h, icon, isolated, type Child } from './dom.js';
import {
  ageText,
  amountFigure,
  barCaption,
  copyFormats,
  flags,
  forecastBar,
  monogram,
  resetText,
  riskText,
  sourceText,
  stateChip,
  stateKey,
  stateMark
} from './parts.js';
import { copyMenuButton, copyText, showMenu, type MenuEntry } from './ui.js';

/** The row and card menu: everything that can be done to a meter and its account. */
export function meterMenu(ctx: Ctx, view: MeterView): MenuEntry[] {
  const now = ctx.app.model.now;
  const account = view.account;
  const entries: MenuEntry[] = [
    { label: 'Update usage…', icon: 'edit', end: h('kbd', { class: 'k' }, 'U'), onSelect: () => ctx.actions.quick(`${view.meter.id} `) },
    { label: 'Edit subscription…', icon: 'rows', onSelect: () => ctx.actions.edit(account.id) }
  ];
  if (account.usageUrl) {
    entries.push({ label: 'Open usage page', icon: 'external', onSelect: () => openExternal(account.usageUrl as string) });
  }
  entries.push({ kind: 'sep' }, { kind: 'title', label: 'Snooze' });
  if (view.snoozed) entries.push({ label: 'Stop snoozing', icon: 'snooze', onSelect: () => ctx.actions.snooze(account.id, null) });
  else {
    entries.push(
      { label: 'For a day', icon: 'snooze', onSelect: () => ctx.actions.snooze(account.id, now + DAY) },
      { label: 'For a week', icon: 'snooze', onSelect: () => ctx.actions.snooze(account.id, now + 7 * DAY) }
    );
    if (view.resetsAtMs !== null && view.resetsAtMs > now) {
      entries.push({ label: 'Until this window resets', icon: 'snooze', onSelect: () => ctx.actions.snooze(account.id, view.resetsAtMs) });
    }
  }
  // A menu is drawn outside the page it belongs to, so with names hidden it does not print one.
  const named = ctx.app.model.prefs.privacy ? 'this subscription' : account.label;
  entries.push({ kind: 'sep' }, { label: `Delete ${named}…`, icon: 'trash', danger: true, onSelect: () => ctx.actions.removeAccount(view) });
  return entries;
}

/** Opens a link in a new tab through a real anchor, which works where scripted window.open is refused. */
function openExternal(url: string): void {
  const link = h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' });
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function moreButton(ctx: Ctx, view: MeterView): HTMLButtonElement {
  const button = h(
    'button',
    {
      class: 'icon-btn',
      type: 'button',
      title: 'More',
      'aria-label': `More actions for ${view.account.label}`,
      onclick: (event: Event) => {
        event.stopPropagation();
        showMenu(button, meterMenu(ctx, view));
      }
    },
    icon('more')
  );
  return button;
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

function queueRow(ctx: Ctx, view: MeterView): HTMLElement {
  const { now, prefs, selectedId } = ctx.app.model;
  const figure = amountFigure(view, prefs);
  const risk = riskText(view);
  const caption = barCaption(view, now);
  const select = (): void => ctx.app.select(selectedId === view.id ? null : view.id);
  // Urgency is drawn on the row itself, so it is there whichever way the list is sorted or grouped.
  const classes = ['row', view.tier === 'use-now' && !view.snoozed ? 'r-use-now' : 'r-quiet'];
  if (selectedId === view.id) classes.push('selected');
  if (view.snoozed) classes.push('snoozed');
  // Under the tier headings the heading names the state. In any other order each row has to.
  return h(
    'li',
    // The whole row is a click target for the mouse; the name inside it is the real control.
    { class: classes.join(' '), dataset: { id: view.id }, onclick: select },
    monogram(view),
    h(
      'button',
      {
        class: 'row-name',
        type: 'button',
        'aria-expanded': String(selectedId === view.id),
        'aria-label': `${view.account.label}, ${view.meter.label}: ${barCaption(view, now).text}. Show details.`,
        dataset: { id: view.id, nav: 'row' },
        onclick: isolated(select)
      },
      h('span', { class: 'a' }, h('span', null, view.account.label), flags(view, now)),
      h('span', { class: 'm' }, prefs.sort !== 'use-first' ? stateChip(view) : null, view.meter.label)
    ),
    h('div', { class: 'row-bar' }, forecastBar(view, now), h('div', { class: 'fcap' }, caption.nodes)),
    // A click on a figure opens the row like a click anywhere else on it. What the figures show (left or
    // used, countdown or clock) is chosen in the menu, where it is visible as a choice.
    h(
      'div',
      { class: 'row-left' },
      h('div', { class: 'v' }, figure.value),
      h('div', { class: 'u' }, figure.unit)
    ),
    h(
      'div',
      { class: 'row-reset' },
      h('div', { class: 'v' }, resetText(view.msLeft === null ? null : view.resetsAtMs, now, prefs)),
      h('div', { class: 'u' }, view.msLeft === null ? 'no reset' : prefs.times === 'countdown' ? 'to reset' : 'resets')
    ),
    h(
      'div',
      { class: 'row-value', title: view.valueBasis === 'credit' ? CREDIT_VALUE_NOTE : view.valueBasis === 'plan' ? PLAN_VALUE_NOTE : null },
      h('div', { class: risk && (view.tier === 'use-now' || view.tier === 'behind') ? 'v risk' : 'v' }, risk || '—'),
      h('div', { class: 'u' }, risk ? (view.valueBasis === 'credit' ? 'credits at risk' : 'at risk') : view.windowValue !== null ? '' : view.account.price ? 'not valued' : 'no price')
    ),
    h('div', { class: 'row-act' }, copyMenuButton(copyFormats(view, now), `Copy ${view.account.label}`), moreButton(ctx, view))
  );
}

function group(title: Child, count: number, hint: string, rows: HTMLElement[]): HTMLElement {
  return h(
    'section',
    { class: 'group' },
    h('div', { class: 'group-head' }, h('h2', null, title), h('span', { class: 'n' }, count), hint ? h('p', null, hint) : null),
    h('ul', { class: 'rows' }, rows)
  );
}

export function queueView(ctx: Ctx, queue: MeterView[]): HTMLElement {
  const { prefs } = ctx.app.model;
  const root = h('div', { class: 'queue' });
  if (prefs.sort !== 'use-first') {
    const label = SORT_ORDERS.find((order) => order.id === prefs.sort)?.label ?? 'Sorted';
    root.appendChild(group(label, queue.length, 'Each row shows its state. Sort by "Use first" to group by urgency.', queue.map((view) => queueRow(ctx, view))));
    return root;
  }
  const active = queue.filter((view) => !view.snoozed);
  for (const tier of TIER_ORDER) {
    const members = active.filter((view) => view.tier === tier);
    if (members.length === 0) continue;
    root.appendChild(
      group(
        h('span', { class: `state t-${tier}`, style: { fontSize: 'inherit', fontWeight: 'inherit' } }, stateMark(tier), TIER_LABEL[tier as Tier]),
        members.length,
        TIER_HINT[tier as Tier],
        members.map((view) => queueRow(ctx, view))
      )
    );
  }
  const snoozed = queue.filter((view) => view.snoozed);
  if (snoozed.length > 0) {
    root.appendChild(group('Snoozed', snoozed.length, 'Left out of alerts and totals until the snooze ends.', snoozed.map((view) => queueRow(ctx, view))));
  }
  return root;
}

// ---------------------------------------------------------------------------
// Board
// ---------------------------------------------------------------------------

export function boardView(ctx: Ctx, queue: MeterView[], all: MeterView[]): HTMLElement {
  const { now, prefs, selectedId } = ctx.app.model;
  // Cards follow the queue's order: an account sits where its most urgent meter sits.
  const order: string[] = [];
  for (const view of queue) if (!order.includes(view.account.id)) order.push(view.account.id);
  for (const view of all) if (!order.includes(view.account.id)) order.push(view.account.id);

  const cards = order.map((accountId) => {
    const meters = all.filter((view) => view.account.id === accountId);
    const lead = queue.find((view) => view.account.id === accountId) ?? meters[0];
    if (!lead) return null;
    const account = lead.account;
    // Plan money and dollar credits are different things and are never added together.
    const planRisk: Money = {};
    const creditRisk: Money = {};
    for (const view of meters) {
      if (view.valueAtRisk === null || view.currency === null || view.valueAtRisk < 0.005) continue;
      const target = view.valueBasis === 'credit' ? creditRisk : planRisk;
      target[view.currency] = (target[view.currency] ?? 0) + view.valueAtRisk;
    }
    const risk = moneyPair(planRisk, creditRisk, ctx.app.model.state.settings.currency, 'at risk');
    const price = account.price ? `${formatMoney(account.price.amount, account.price.currency)}/${account.price.period === 'year' ? 'yr' : 'mo'}` : null;
    return h(
      'article',
      { class: meters.some((view) => view.id === selectedId) ? 'card selected' : 'card', dataset: { nav: 'card' } },
      h(
        'div',
        { class: 'card-head' },
        monogram(lead, true),
        h('div', { class: 't' }, h('div', { class: 'card-title' }, account.label), h('div', { class: 'card-sub' }, [account.plan, price].filter(Boolean).join(', ') || 'Custom')),
        stateChip(lead)
      ),
      meters.map((view) => {
        const figure = amountFigure(view, prefs);
        const expiring = view.tier !== null && view.projectedUnused >= 0.005 && view.tier !== 'spent' && view.tier !== 'fresh';
        return h(
          'button',
          {
            class: 'card-meter',
            type: 'button',
            'aria-expanded': String(view.id === selectedId),
            dataset: { id: view.id, nav: 'row' },
            onclick: () => ctx.app.select(view.id === selectedId ? null : view.id)
          },
          h('span', { class: 'n' }, h('span', null, view.meter.label), flags(view, now)),
          h('span', { class: 'v' }, `${figure.value} ${prefs.amounts}`),
          forecastBar(view, now, view.tier === null ? 'thin' : 'sm'),
          h(
            'span',
            { class: 'c' },
            h('span', null, view.msLeft === null ? (view.tier === null ? 'rate limit' : 'no reset') : ['resets in ', resetText(view.resetsAtMs, now, { times: 'countdown' })]),
            expiring ? h('span', { class: 'exp' }, `${formatPercent(view.projectedUnused)} expires`) : view.tier === null ? h('span', null, 'rate limit') : null
          )
        );
      }),
      h(
        'div',
        { class: 'card-foot' },
        h('span', { class: 'sp' }, risk ? h('span', null, risk) : null, h('span', null, ageText(lead))),
        h('button', { class: 'icon-btn', type: 'button', title: 'Update usage', 'aria-label': `Update ${account.label}`, onclick: () => ctx.actions.quick(`${lead.meter.id} `) }, icon('edit')),
        copyMenuButton(copyFormats(lead, now), `Copy ${account.label}`),
        moreButton(ctx, lead)
      )
    );
  });
  return h('div', { class: 'cards' }, cards);
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

function ticksFor(horizonHours: number, nowMs: number): { at: number; label: string }[] {
  const zone = localZone();
  const ticks: { at: number; label: string }[] = [{ at: 0, label: 'now' }];
  const horizonMs = horizonHours * HOUR;
  if (horizonHours <= 24) {
    // Whole hours, every three.
    const first = Math.ceil(nowMs / (3 * HOUR)) * 3 * HOUR;
    for (let t = first; t - nowMs <= horizonMs; t += 3 * HOUR) {
      const p = zonedParts(t, zone);
      if ((t - nowMs) / horizonMs > 0.06) ticks.push({ at: (t - nowMs) / horizonMs, label: `${String(p.hour).padStart(2, '0')}:00` });
    }
    return ticks;
  }
  const stepDays = horizonHours <= 168 ? 1 : 5;
  const today = zonedParts(nowMs, zone);
  for (let day = 1; day <= horizonHours / 24; day += 1) {
    if (day % stepDays !== 0) continue;
    const midnight = new Date(today.year, today.month - 1, today.day + day).getTime();
    const fraction = (midnight - nowMs) / horizonMs;
    if (fraction <= 0.05 || fraction > 1) continue;
    const date = new Date(midnight);
    ticks.push({
      at: fraction,
      label: stepDays === 1 ? `${weekdayNames[date.getDay()] ?? ''} ${date.getDate()}` : `${date.getDate()} ${monthNames[date.getMonth()] ?? ''}`
    });
  }
  return ticks;
}

/** Later resets of a recurring window inside the horizon, so cadence is visible at a glance. */
function laterResets(view: MeterView, nowMs: number, horizonMs: number): number[] {
  const out: number[] = [];
  let at = view.resetsAtMs;
  if (at === null) return out;
  const rule = view.meter.reset;
  for (let guard = 0; guard < 60; guard += 1) {
    if (rule.kind === 'interval') at += rule.hours * HOUR;
    else if (rule.kind === 'daily' || rule.kind === 'monthly') {
      const next = nextBoundary(rule, at);
      if (next === null) break;
      at = next;
    } else break;
    if (at - nowMs > horizonMs) break;
    out.push((at - nowMs) / horizonMs);
  }
  return out;
}

export function timelineView(ctx: Ctx, queue: MeterView[]): HTMLElement {
  const { now, prefs, selectedId } = ctx.app.model;
  const horizonMs = prefs.horizon * HOUR;
  // Rows keep the order chosen in the toolbar, like every other view. The axis is what shows time.
  const timed = queue.filter((view) => view.msLeft !== null && view.msLeft > 0);
  const within = timed.filter((view) => (view.msLeft ?? 0) <= horizonMs);
  const later = timed.filter((view) => (view.msLeft ?? 0) > horizonMs);
  const unscheduled = queue.filter((view) => view.msLeft === null);
  const ticks = ticksFor(prefs.horizon, now);
  const grid = h('div', { class: 'tl-grid' });
  grid.appendChild(
    h(
      'div',
      { class: 'tl-axis', 'aria-hidden': 'true' },
      // A mark close to the start is flagged, so a narrow screen can drop it instead of printing it over "now".
      ticks.map((tick, index) => h('span', { class: index === 0 ? 'tl-tick first' : tick.at < 0.14 ? 'tl-tick near' : 'tl-tick', style: { left: `${tick.at * 100}%` } }, tick.label))
    )
  );

  for (const view of within) {
    const fraction = Math.min(1, (view.msLeft ?? 0) / horizonMs);
    const risk = riskText(view);
    const expiring = view.projectedUnused >= 0.05 && view.tier !== 'spent' && view.tier !== 'fresh';
    // Only two things are worth a colour on a deadline: quota that will expire, and quota already used up.
    const spanClass = view.tier === 'spent' ? 'tl-span ok' : expiring ? 'tl-span exp' : 'tl-span';
    const flip = fraction > 0.66;
    const select = (): void => ctx.app.select(selectedId === view.id ? null : view.id);
    const end = h(
      'div',
      { class: flip ? 'tl-end flip' : 'tl-end', style: { left: `${fraction * 100}%` } },
      h('b', null, leftText(view)),
      expiring ? h('span', { class: 'exp' }, risk ? `${riskMoney(view)} expires` : `${formatPercent(view.projectedUnused)} expires`) : null,
      h('span', null, formatMoment(view.resetsAtMs as number, now))
    );
    grid.appendChild(
      h(
        'div',
        { class: selectedId === view.id ? 'tl-row selected' : 'tl-row', onclick: select },
        h(
          'button',
          {
            class: 'tl-label',
            type: 'button',
            'aria-expanded': String(selectedId === view.id),
            'aria-label': `${view.account.label}, ${view.meter.label}: ${leftText(view)}, resets in ${formatDuration(view.msLeft ?? 0)}. Show details.`,
            dataset: { id: view.id, nav: 'row' },
            onclick: isolated(select)
          },
          h('span', { class: `state t-${stateKey(view)}` }, stateMark(stateKey(view))),
          h('span', { class: 'tl-name' }, h('b', null, view.account.label), h('span', null, view.meter.label))
        ),
        h(
          'div',
          { class: 'tl-lane' },
          ticks.slice(1).map((tick) => h('i', { class: 'tl-gridline', style: { left: `${tick.at * 100}%` } })),
          laterResets(view, now, horizonMs).map((at) => h('i', { class: 'tl-next', style: { left: `${at * 100}%` } })),
          h('div', { class: spanClass, style: { width: `${fraction * 100}%` } }),
          end
        )
      )
    );
  }

  const root = h('div', { class: 'tl' });
  if (within.length === 0) {
    root.appendChild(h('p', { class: 'hint', style: { padding: '18px 0' } }, `Nothing resets in the next ${prefs.horizon === 24 ? '24 hours' : prefs.horizon === 168 ? '7 days' : '30 days'}.`));
  } else root.appendChild(grid);

  const list = (title: string, views: MeterView[], tail: (view: MeterView) => string): HTMLElement | null =>
    views.length === 0
      ? null
      : h(
          'div',
          { class: 'tl-later' },
          h('h3', null, title),
          h(
            'ul',
            null,
            views.map((view) =>
              h(
                'li',
                { onclick: () => ctx.app.select(view.id) },
                h('span', { class: `state t-${stateKey(view)}` }, stateMark(stateKey(view))),
                h(
                  'button',
                  { class: 'tl-later-name', type: 'button', dataset: { id: view.id, nav: 'row' }, onclick: isolated(() => ctx.app.select(view.id)) },
                  h('b', null, view.account.label),
                  ' ',
                  view.meter.label
                ),
                h('span', { class: 'num' }, tail(view))
              )
            )
          )
        );
  const laterList = list('Later', later, (view) => `${leftText(view)}, resets ${formatMoment(view.resetsAtMs as number, now)}`);
  const idleList = list('No reset scheduled', unscheduled, (view) => leftText(view));
  if (laterList) root.appendChild(laterList);
  if (idleList) root.appendChild(idleList);
  return root;
}

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

/** A window has a forecast once it has a clock and is past its first few percent. */
function hasForecast(view: MeterView): boolean {
  return view.projectedFraction !== null && view.tier !== 'fresh' && view.tier !== 'idle' && view.tier !== 'expired';
}

interface Column {
  id: string;
  label: string;
  right?: boolean;
  sort?: SortOrder;
  cell: (view: MeterView) => Child;
  text: (view: MeterView) => string;
}

function tableColumns(ctx: Ctx): Column[] {
  const { now, prefs } = ctx.app.model;
  return [
    { id: 'state', label: 'State', sort: 'use-first', cell: (view) => stateChip(view), text: (view) => TIER_LABEL[view.tier as Tier] ?? '' },
    {
      id: 'name',
      label: 'Subscription',
      sort: 'name',
      cell: (view) =>
        h(
          'button',
          {
            class: 'c-name',
            type: 'button',
            'aria-expanded': String(ctx.app.model.selectedId === view.id),
            dataset: { id: view.id, nav: 'row' },
            onclick: isolated(() => ctx.app.select(ctx.app.model.selectedId === view.id ? null : view.id))
          },
          view.account.label
        ),
      text: (view) => view.account.label
    },
    { id: 'meter', label: 'Meter', cell: (view) => [view.meter.label, ' ', flags(view, now)], text: (view) => view.meter.label },
    { id: 'bar', label: 'Forecast', cell: (view) => h('div', { class: 'c-bar' }, forecastBar(view, now)), text: (view) => barCaption(view, now).text },
    {
      id: 'used',
      label: 'Used',
      right: true,
      // One unit down the whole column, so it can be scanned and compared. The amount is a hover away, and
      // in the copied table.
      cell: (view) => h('span', { title: view.meter.unit === 'percent' ? null : `${formatAmount(view.meter, view.used)} of ${formatAmount(view.meter, view.limit)}` }, formatPercent(view.usedFraction)),
      text: (view) => (view.meter.unit === 'percent' ? formatPercent(view.usedFraction) : `${formatPercent(view.usedFraction)} (${formatAmount(view.meter, view.used)})`)
    },
    { id: 'left', label: 'Left', right: true, sort: 'left', cell: (view) => formatPercent(view.remainingFraction), text: (view) => formatPercent(view.remainingFraction) },
    {
      id: 'reset',
      label: 'Resets',
      right: true,
      sort: 'reset',
      cell: (view) => resetText(view.msLeft === null ? null : view.resetsAtMs, now, prefs),
      text: (view) => (view.resetsAtMs === null ? '' : `${formatDuration(view.msLeft ?? 0)} (${formatMoment(view.resetsAtMs, now)})`)
    },
    {
      id: 'expires',
      label: 'Will expire',
      right: true,
      cell: (view) => (hasForecast(view) ? formatPercent(view.projectedUnused) : '—'),
      text: (view) => (hasForecast(view) ? formatPercent(view.projectedUnused) : '')
    },
    {
      id: 'risk',
      label: 'At risk',
      right: true,
      sort: 'value',
      cell: (view) => (riskMoney(view) ? h('span', { class: view.tier === 'use-now' || view.tier === 'behind' ? 'risk' : '' }, riskMoney(view)) : '—'),
      text: (view) => riskMoney(view)
    },
    { id: 'updated', label: 'Updated', sort: 'updated', cell: (view) => ageText(view).replace('updated ', ''), text: (view) => ageText(view).replace('updated ', '') },
    { id: 'source', label: 'Source', cell: (view) => sourceText(view), text: (view) => sourceText(view) }
  ];
}

export function tableMarkdown(ctx: Ctx, queue: MeterView[]): string {
  const columns = tableColumns(ctx).filter((column) => column.id !== 'bar');
  const escape = (text: string): string => text.replace(/\|/g, '\\|');
  const lines = [`| ${columns.map((column) => column.label).join(' | ')} |`, `| ${columns.map((column) => (column.right ? '---:' : '---')).join(' | ')} |`];
  for (const view of queue) lines.push(`| ${columns.map((column) => escape(column.text(view))).join(' | ')} |`);
  return lines.join('\n');
}

export function tableCsv(ctx: Ctx, queue: MeterView[]): string {
  const columns = tableColumns(ctx).filter((column) => column.id !== 'bar');
  const quote = (text: string): string => (/[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text);
  return [columns.map((column) => quote(column.label)).join(','), ...queue.map((view) => columns.map((column) => quote(column.text(view))).join(','))].join('\n');
}

export function tableView(ctx: Ctx, queue: MeterView[]): HTMLElement {
  const { prefs, selectedId } = ctx.app.model;
  const columns = tableColumns(ctx);
  return h(
    'div',
    { class: 'table-wrap' },
    h(
      'table',
      { class: 'tbl' },
      h(
        'thead',
        null,
        h(
          'tr',
          null,
          columns.map((column) =>
            h(
              'th',
              { class: column.right ? 'r' : null, scope: 'col', 'aria-sort': column.sort && column.sort === prefs.sort ? 'ascending' : null },
              column.sort
                ? h(
                    'button',
                    { type: 'button', title: `Sort by ${column.label.toLowerCase()}`, onclick: () => ctx.app.setPrefs({ sort: column.sort as SortOrder }) },
                    column.label,
                    column.sort === prefs.sort ? icon('chevron') : null
                  )
                : column.label
            )
          )
        )
      ),
      h(
        'tbody',
        null,
        queue.map((view) =>
          h(
            'tr',
            { class: selectedId === view.id ? 'selected' : null, onclick: () => ctx.app.select(selectedId === view.id ? null : view.id) },
            columns.map((column) => h('td', { class: column.right ? 'r' : null }, column.cell(view)))
          )
        )
      )
    )
  );
}

export function tableTools(ctx: Ctx, queue: MeterView[]): HTMLElement[] {
  return [
    h('button', { class: 'btn small quiet', type: 'button', onclick: () => void copyText(tableMarkdown(ctx, queue), 'Table copied as Markdown') }, icon('copy'), 'Markdown'),
    h('button', { class: 'btn small quiet', type: 'button', onclick: () => void copyText(tableCsv(ctx, queue), 'Table copied as CSV') }, icon('copy'), 'CSV')
  ];
}
