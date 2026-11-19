// Costs (optional API spend) and History (what actually expired). Both are records of fact, so nothing
// here is hatched: hatching is reserved for forecasts.

import { CATALOG } from '../core/catalog.js';
import { monogramFor } from '../core/catalog-types.js';
import { ledgerTotals, type Money } from '../core/forecast.js';
import { formatMoney, formatMoneyTotals, formatPercent } from '../core/format.js';
import { summariseSpend } from '../core/spend.js';
import { formatAge, formatMoment, toMs } from '../core/time.js';
import type { ClosedCycle } from '../core/types.js';
import { cycleColumns, dailyBars } from './charts.js';
import type { Ctx } from './ctx.js';
import { h, icon } from './dom.js';
import { copyText } from './ui.js';

/** Dollar credits that expired, shown beside the plan money and never added to it. */
function creditNote(credits: Money, currency: string): HTMLElement | null {
  const text = formatMoneyTotals(credits, currency);
  return text ? h('small', null, `+ ${text} in credits`) : null;
}

export function costsView(ctx: Ctx): HTMLElement {
  const { state, now } = ctx.app.model;
  if (state.spend.length === 0) {
    return h(
      'div',
      { class: 'empty' },
      h('h2', null, 'API costs are optional'),
      h(
        'p',
        null,
        'Subscriptions waste quota; pay-as-you-go APIs only cost money. If you also pay per token, add a source here to see month-to-date spend, a projection and a budget next to your subscriptions. Costs never count as waste.'
      ),
      h('div', { class: 'actions' }, h('button', { class: 'btn primary', type: 'button', onclick: () => ctx.actions.addSpend() }, icon('plus'), 'Add a spend source'))
    );
  }
  const summaries = state.spend.map((source) => summariseSpend(source, now));
  const month: Money = {};
  const projected: Money = {};
  for (const summary of summaries) {
    month[summary.source.currency] = (month[summary.source.currency] ?? 0) + summary.monthToDate;
    projected[summary.source.currency] = (projected[summary.source.currency] ?? 0) + summary.projected;
  }
  const root = h('div', null);
  root.appendChild(
    h(
      'section',
      { class: 'section' },
      h(
        'div',
        { class: 'section-head' },
        h('h2', null, 'API spend this month'),
        h('p', null, `${formatMoneyTotals(month, state.settings.currency, formatMoney(0, state.settings.currency))} so far, heading for ${formatMoneyTotals(projected, state.settings.currency, formatMoney(0, state.settings.currency))}.`),
        h('span', { class: 'sp' }),
        h('button', { class: 'btn small', type: 'button', onclick: () => ctx.actions.addSpend() }, icon('plus'), 'Add source')
      ),
      summaries.map((summary) => {
        const source = summary.source;
        const budget = source.monthlyBudget;
        return h(
          'article',
          { class: 'spend' },
          h(
            'div',
            null,
            h('h3', null, h('span', { class: 'mono', 'aria-hidden': 'true' }, monogramFor(CATALOG, source.providerId, source.label)), source.label),
            h('div', { class: 'big' }, formatMoney(summary.monthToDate, source.currency), h('small', null, 'this month')),
            budget
              ? h(
                  'div',
                  { class: 'budget-bar', role: 'img', 'aria-label': `${formatPercent(Math.min(1, summary.budgetFraction ?? 0))} of the ${formatMoney(budget, source.currency)} budget used` },
                  h('i', { class: summary.overBudget ? 'over' : '', style: { width: `${Math.min(100, (summary.budgetFraction ?? 0) * 100)}%` } }),
                  h('b', { style: { left: `${Math.min(100, (summary.projected / budget) * 100)}%` }, title: 'Projected month end' })
                )
              : null,
            h(
              'div',
              { class: 'meta' },
              `Projected ${formatMoney(summary.projected, source.currency)} by month end`,
              budget
                ? [
                    ` against a budget of ${formatMoney(budget, source.currency)}. `,
                    summary.overBudget ? h('span', { class: 'over' }, 'Over budget.') : summary.headingOver ? h('span', { class: 'over' }, 'Heading over budget.') : 'Within budget.'
                  ]
                : '.',
              summary.previousMonth > 0 ? ` Last month ${formatMoney(summary.previousMonth, source.currency)}.` : ''
            ),
            h('div', { class: 'meta' }, source.updatedAt ? `Updated ${formatAge(now - (toMs(source.updatedAt) ?? now))}` : 'No entries yet', source.source.kind === 'collector' ? ', automatic' : ''),
            h(
              'div',
              { class: 'ops' },
              h('button', { class: 'btn small', type: 'button', onclick: () => ctx.actions.logSpend(source.id) }, icon('plus'), 'Log spend'),
              h('button', { class: 'btn small quiet', type: 'button', onclick: () => ctx.actions.editSpend(source.id) }, 'Edit'),
              h('button', { class: 'btn small quiet', type: 'button', onclick: () => ctx.actions.removeSpend(source.id) }, 'Delete')
            )
          ),
          dailyBars(summary)
        );
      })
    )
  );
  return root;
}

function historyMarkdown(cycles: readonly ClosedCycle[], nowMs: number): string {
  const lines = ['| Ended | Subscription | Meter | Used | Expired | Value |', '| --- | --- | --- | ---: | ---: | ---: |'];
  for (const cycle of cycles.slice().reverse()) {
    const approx = cycle.confidence === 'estimated' ? '~' : '';
    lines.push(
      `| ${formatMoment(toMs(cycle.endedAt) ?? nowMs, nowMs)} | ${cycle.accountLabel} | ${cycle.meterLabel} | ${formatPercent(1 - cycle.wastedFraction)} | ${approx}${formatPercent(cycle.wastedFraction)} | ${cycle.wastedValue !== null && cycle.currency ? approx + formatMoney(cycle.wastedValue, cycle.currency) : ''} |`
    );
  }
  return lines.join('\n');
}

export function historyView(ctx: Ctx): HTMLElement {
  const { state, now } = ctx.app.model;
  if (state.cycles.length === 0) {
    return h(
      'div',
      { class: 'empty' },
      h('h2', null, 'Nothing has expired on record yet'),
      h(
        'p',
        null,
        'Every time a quota window closes, Tokengator records how much of it was used and what the unused part was worth. Come back after the first reset to see whether you are getting what you pay for.'
      )
    );
  }
  const totals30 = ledgerTotals(state.cycles, now, 30);
  const totals90 = ledgerTotals(state.cycles, now, 90);
  const currency = state.settings.currency;

  // One row per meter, newest activity first.
  const byMeter = new Map<string, ClosedCycle[]>();
  for (const cycle of state.cycles) {
    const list = byMeter.get(cycle.meterId) ?? [];
    list.push(cycle);
    byMeter.set(cycle.meterId, list);
  }
  const rows = [...byMeter.values()].sort((a, b) => {
    const lostA = a.reduce((sum, cycle) => sum + (cycle.wastedValue ?? cycle.wastedFraction), 0);
    const lostB = b.reduce((sum, cycle) => sum + (cycle.wastedValue ?? cycle.wastedFraction), 0);
    return lostB - lostA;
  });

  const approx = totals30.lostIsEstimate ? '~' : '';
  return h(
    'div',
    null,
    h(
      'section',
      { class: 'section' },
      h(
        'div',
        { class: 'section-head' },
        h('h2', null, 'What expired unused'),
        h('span', { class: 'sp' }),
        h('button', { class: 'btn small quiet', type: 'button', onclick: () => void copyText(historyMarkdown(state.cycles, now), 'History copied as Markdown') }, icon('copy'), 'Markdown')
      ),
      h(
        'dl',
        { class: 'stats' },
        h('div', { class: 'stat risk' }, h('dt', { class: 'label' }, 'Last 30 days'), h('dd', null, `${approx}${formatMoneyTotals(totals30.lost30, currency, formatMoney(0, currency))}`, creditNote(totals30.creditsLost30, currency))),
        h('div', { class: 'stat' }, h('dt', { class: 'label' }, 'Last 90 days'), h('dd', null, formatMoneyTotals(totals90.lost30, currency, formatMoney(0, currency)), creditNote(totals90.creditsLost30, currency))),
        h(
          'div',
          { class: 'stat' },
          h('dt', { class: 'label' }, 'Utilisation, 30 days'),
          h('dd', null, totals30.utilisation30 === null ? '—' : formatPercent(totals30.utilisation30), h('small', null, `${totals30.cycles30} window${totals30.cycles30 === 1 ? '' : 's'}`))
        )
      )
    ),
    h(
      'section',
      { class: 'section' },
      h(
        'div',
        { class: 'section-head' },
        h('h2', null, 'By quota'),
        h('p', null, 'One column per finished window, oldest on the left. A faded column is an estimate: nothing was read near that reset.'),
        h('span', { class: 'sp' }),
        h('div', { class: 'legend', 'aria-hidden': 'true' }, h('span', null, h('i', { class: 'l-used' }), 'Used'), h('span', null, h('i', { class: 'l-fact' }), 'Expired'), h('span', null, h('i', { class: 'l-ok' }), 'Fully used'))
      ),
      rows.map((cycles) => {
        const last = cycles[cycles.length - 1] as ClosedCycle;
        const recent = cycles.slice(-16);
        const lost = cycles.reduce((sum, cycle) => sum + (cycle.wastedValue ?? 0), 0);
        const mean = cycles.reduce((sum, cycle) => sum + (1 - cycle.wastedFraction), 0) / cycles.length;
        return h(
          'div',
          { class: 'hist-row' },
          h(
            'div',
            { class: 'who' },
            h('span', { class: 'mono', 'aria-hidden': 'true' }, monogramFor(CATALOG, last.providerId, last.accountLabel)),
            h('div', null, h('b', null, last.accountLabel), h('span', null, `${last.meterLabel}, ${cycles.length} window${cycles.length === 1 ? '' : 's'}`))
          ),
          cycleColumns(recent, now, 520),
          h(
            'div',
            { class: 'tot' },
            h('b', null, lost >= 0.005 && last.currency ? formatMoney(lost, last.currency) : formatPercent(1 - mean)),
            h('span', null, lost >= 0.005 && last.currency ? `expired, ${formatPercent(mean)} used on average` : 'used on average')
          )
        );
      })
    )
  );
}
