// The inspector: everything about one meter, and the fastest way to update it.

import { CATALOG, CATALOG_CHECKED } from '../core/catalog.js';
import { findProvider } from '../core/catalog-types.js';
import { cyclesOf, type MeterView } from '../core/forecast.js';
import { formatAmount, formatMoney, formatMultiple, formatPercent } from '../core/format.js';
import { parseQuick } from '../core/quick.js';
import { DAY, formatDuration, formatMoment } from '../core/time.js';
import { CREDIT_VALUE_NOTE, PLAN_VALUE_NOTE, expiredMoney, explain, headline } from '../core/wording.js';
import { burnUp, cycleColumns } from './charts.js';
import type { Ctx } from './ctx.js';
import { h, icon } from './dom.js';
import { ageText, barLegend, copyFormats, flags, forecastBar, monogram, resetText, riskText, sourceText, stateChip } from './parts.js';
import { copyText, showMenu } from './ui.js';
import { meterMenu } from './views.js';

function fact(label: string, value: string | Node, small?: string, risk = false): HTMLElement[] {
  return [h('dt', null, label), h('dd', { class: risk ? 'risk' : null }, value, small ? h('small', null, small) : null)];
}

/** The chip beside it already names the state, so the sentence starts with the numbers. */
function withoutStatePrefix(text: string): string {
  const rest = text.replace(/^[A-Z][a-z ]{2,18}: /, '');
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

function windowText(view: MeterView): string {
  const rule = view.meter.reset;
  switch (rule.kind) {
    case 'rolling':
      return `${rule.hours}h from first use`;
    case 'interval':
      return rule.hours % 24 === 0 ? `every ${rule.hours / 24} day${rule.hours === 24 ? '' : 's'}` : `every ${rule.hours}h`;
    case 'daily':
      return `daily at ${rule.time} ${rule.tz}`;
    case 'monthly':
      return `monthly on day ${rule.day}, ${rule.time} ${rule.tz}`;
    case 'once':
      return 'expires once';
    default:
      return 'no reset';
  }
}

export function inspector(ctx: Ctx, view: MeterView): HTMLElement {
  const { now, state } = ctx.app.model;
  const account = view.account;
  const siblings = ctx.app.allViews().filter((other) => other.account.id === account.id);
  const cycles = cyclesOf(state, view.meter.id, 12);
  const uses = findProvider(CATALOG, account.providerId)?.uses ?? [];
  const price = account.price ? `${formatMoney(account.price.amount, account.price.currency)} per ${account.price.period}` : null;

  // -- update form: the quick-entry grammar, scoped to this meter ---------------
  const input = h('input', {
    class: 'input num',
    id: 'insp-update',
    type: 'text',
    autocomplete: 'off',
    spellcheck: 'false',
    placeholder: view.meter.unit === 'percent' ? '62%, or 38% left, or 62% resets thu 09:00' : '1200 left, or 40%, or resets in 9d',
    'aria-label': `Update ${view.meter.label}`
  }) as HTMLInputElement;
  const preview = h('p', { class: 'preview', 'aria-live': 'polite' }, 'Type what the usage page says. Enter saves.');
  const line = (): string => `${view.meter.id} ${input.value.trim()}`;
  const refreshPreview = (): void => {
    if (!input.value.trim()) {
      preview.className = 'preview';
      preview.textContent = 'Type what the usage page says. Enter saves.';
      return;
    }
    const parsed = parseQuick(line(), ctx.app.model.state, Date.now());
    preview.className = parsed.ok ? 'preview ok' : 'preview err';
    preview.textContent = parsed.ok ? parsed.preview.replace(`${account.label}, ${view.meter.label}: `, '') : parsed.error;
  };
  const save = async (): Promise<void> => {
    if (!input.value.trim()) return;
    const parsed = parseQuick(line(), ctx.app.model.state, Date.now());
    if (!parsed.ok) {
      refreshPreview();
      return;
    }
    // Empty the field before the change lands: a rebuild is held back while it still has text in it.
    const typed = input.value;
    const text = line();
    input.value = '';
    const ok = await ctx.actions.run(ctx.app.model.backend.quick(text), 'Updated');
    if (!ok && input.isConnected) {
      input.value = typed;
      refreshPreview();
    }
  };
  input.addEventListener('input', refreshPreview);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void save();
    }
  });

  const moreButton = h(
    'button',
    { class: 'btn small', type: 'button', onclick: () => showMenu(moreButton, meterMenu(ctx, view)) },
    'More',
    icon('chevron')
  );
  const copyButton = h(
    'button',
    {
      class: 'btn small',
      type: 'button',
      onclick: () =>
        showMenu(
          copyButton,
          copyFormats(view, now).map((format) => ({ label: format.label, icon: 'copy', onSelect: () => void copyText(format.text(), format.toast) }))
        )
    },
    icon('copy'),
    'Copy',
    icon('chevron')
  );

  const facts: HTMLElement[] = [
    ...fact('Used', view.meter.unit === 'percent' ? formatPercent(view.usedFraction) : formatAmount(view.meter, view.used), view.meter.unit === 'percent' ? undefined : `of ${formatAmount(view.meter, view.limit)}`),
    ...fact('Left', view.meter.unit === 'percent' ? formatPercent(view.remainingFraction) : formatAmount(view.meter, view.remaining), view.meter.unit === 'percent' ? undefined : formatPercent(view.remainingFraction))
  ];
  if (view.resetsAtMs !== null && view.msLeft !== null && view.msLeft > 0) {
    facts.push(...fact('Resets', resetText(view.resetsAtMs, now, { times: 'countdown' }), formatMoment(view.resetsAtMs, now)));
  } else facts.push(...fact('Resets', view.needsReset ? 'not set' : 'no window', windowText(view)));
  if (view.tier !== null && view.projectedFraction !== null) {
    facts.push(...fact('Forecast at reset', `${formatPercent(view.projectedFraction)} used`, `${formatPercent(view.projectedUnused)} expires`));
  }
  if (view.requiredMultiple !== null && view.requiredMultiple > 1.05) {
    facts.push(...fact('Pace needed', formatMultiple(view.requiredMultiple), 'the pace so far'));
  }
  if (view.perDayToFinish !== null && view.msLeft !== null && view.msLeft > DAY) {
    facts.push(...fact('To finish it', `${formatAmount(view.meter, view.perDayToFinish)}`, 'per day'));
  }
  if (view.runsOutAtMs !== null) facts.push(...fact('Runs out', formatMoment(view.runsOutAtMs, now), 'at this pace'));
  if (view.windowValue !== null && view.currency !== null) {
    const risk = riskText(view);
    const basis = view.valueBasis === 'credit' ? `of ${formatMoney(view.windowValue, view.currency)} in credits` : `of ${formatMoney(view.windowValue, view.currency)} this window`;
    facts.push(...fact('At risk', risk || formatMoney(0, view.currency), basis, Boolean(risk) && (view.tier === 'use-now' || view.tier === 'behind')));
  }
  facts.push(...fact('Window', windowText(view), view.meter.rollover === 'carries' ? 'unused quota carries over' : undefined));
  facts.push(...fact('Source', sourceText(view), ageText(view)));

  const wasted = cycles.reduce((sum, cycle) => sum + (cycle.wastedValue ?? 0), 0);
  const meanUsed = cycles.length ? cycles.reduce((sum, cycle) => sum + (1 - cycle.wastedFraction), 0) / cycles.length : null;

  return h(
    'aside',
    { class: 'insp', 'aria-label': `${account.label}, ${view.meter.label}`, dataset: { meter: view.id } },
    h(
      'div',
      { class: 'insp-head' },
      monogram(view, true),
      h(
        'div',
        { class: 't' },
        h('div', { class: 'insp-title' }, account.label),
        h('div', { class: 'insp-sub' }, [account.plan, price].filter(Boolean).join(', ') || 'Custom subscription')
      ),
      h('button', { class: 'icon-btn insp-close', type: 'button', 'aria-label': 'Close details', onclick: () => ctx.app.select(null) }, icon('x'))
    ),
    siblings.length > 1
      ? h(
          'div',
          { class: 'meter-tabs', role: 'group', 'aria-label': 'Meters of this subscription' },
          siblings.map((other) =>
            h(
              'button',
              { class: 'chip-btn', type: 'button', 'aria-pressed': String(other.id === view.id), onclick: () => ctx.app.select(other.id) },
              other.meter.label
            )
          )
        )
      : null,
    h(
      'div',
      { class: 'insp-sec' },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginBottom: '8px' } }, stateChip(view), flags(view, now)),
      h('p', { class: 'insp-state' }, withoutStatePrefix(headline(view, now))),
      h('p', { class: 'insp-why' }, explain(view, now)),
      h('div', { style: { marginTop: '12px' } }, forecastBar(view, now, 'lg')),
      view.tier !== null ? h('div', { style: { marginTop: '6px' } }, barLegend()) : null
    ),
    h(
      'div',
      { class: 'insp-sec' },
      h('label', { class: 'label', for: 'insp-update' }, 'Update'),
      h('div', { class: 'quick-inline' }, input, h('button', { class: 'btn primary', type: 'button', onclick: () => void save() }, 'Save')),
      preview,
      h(
        'div',
        { class: 'insp-actions', style: { marginTop: '10px' } },
        account.usageUrl
          ? h('a', { class: 'btn small', href: account.usageUrl, target: '_blank', rel: 'noopener noreferrer' }, icon('external'), 'Usage page')
          : null,
        copyButton,
        h('button', { class: 'btn small', type: 'button', onclick: () => ctx.actions.edit(account.id) }, icon('edit'), 'Edit'),
        moreButton
      )
    ),
    h('div', { class: 'insp-sec' }, h('span', { class: 'label' }, 'This window'), burnUp(view, now)),
    h(
      'div',
      { class: 'insp-sec' },
      h('span', { class: 'label' }, 'Numbers'),
      h('dl', { class: 'facts' }, facts),
      view.valueBasis !== null ? h('p', { class: 'hint', style: { marginTop: '8px' } }, view.valueBasis === 'credit' ? CREDIT_VALUE_NOTE : PLAN_VALUE_NOTE) : null
    ),
    view.tier !== null
      ? h(
          'div',
          { class: 'insp-sec' },
          h('span', { class: 'label' }, 'Past windows'),
          cycleColumns(cycles, now),
          cycles.length > 0 && meanUsed !== null
            ? h(
                'p',
                { class: 'hint', style: { marginTop: '6px' } },
                `${formatPercent(meanUsed)} used on average over ${cycles.length} window${cycles.length === 1 ? '' : 's'}`,
                expiredMoney(wasted, cycles[0]?.currency ?? null, view.meter.unit) ? `, ${expiredMoney(wasted, cycles[0]?.currency ?? null, view.meter.unit)} expired.` : '.'
              )
            : null,
          cycles.length > 0
            ? h('div', { class: 'legend', style: { marginTop: '6px' }, 'aria-hidden': 'true' }, h('span', null, h('i', { class: 'l-used' }), 'Used'), h('span', null, h('i', { class: 'l-fact' }), 'Expired'))
            : null
        )
      : null,
    account.notes ? h('div', { class: 'insp-sec' }, h('span', { class: 'label' }, 'Notes'), h('p', { class: 'notes' }, account.notes)) : null,
    // A warning is only useful with something to do about it. These come from the provider's own pages.
    uses.length > 0 && (view.tier === 'use-now' || view.tier === 'behind')
      ? h(
          'div',
          { class: 'insp-sec' },
          h('span', { class: 'label' }, 'Ways to use it while you are away'),
          h(
            'ul',
            { class: 'uses' },
            uses.map((use) => h('li', null, h('a', { href: use.url, target: '_blank', rel: 'noopener noreferrer' }, use.title, icon('external')), h('span', null, use.note)))
          ),
          h('p', { class: 'hint', style: { marginTop: '6px' } }, `From the provider's documentation, checked ${CATALOG_CHECKED}.`)
        )
      : null,
    h(
      'div',
      { class: 'insp-sec' },
      h(
        'p',
        { class: 'hint' },
        'Agents can reach this meter as "',
        // The id is made from the account's name, so it hides with the names.
        h('span', { class: 'private' }, view.meter.id),
        '".',
        view.snoozed && account.snoozedUntil ? ` Snoozed for ${formatDuration(Date.parse(account.snoozedUntil) - now)}.` : ''
      )
    )
  );
}
