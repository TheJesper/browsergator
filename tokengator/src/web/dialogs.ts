// Dialogs: quick entry, adding and editing subscriptions, spend sources, connecting agents, automatic
// sources and the shortcut list.

import type { AccountInput, MeterInput, MeterPatch } from '../core/accounts.js';
import { CATALOG, CATALOG_CHECKED } from '../core/catalog.js';
import { CATEGORY_LABEL, planNeedsBillingDay, type PresetPlan, type ProviderCategory, type ProviderPreset } from '../core/catalog-types.js';
import { CONNECT_GROUP_LABEL, connectSnippets } from '../core/connect.js';
import { UNITS, formatAmount, formatMoney } from '../core/format.js';
import { parseQuick } from '../core/quick.js';
import { calendarFeed } from '../core/reminders.js';
import { dateKey, formatAge, localZone, toMs } from '../core/time.js';
import type { Account, Meter, Price, ResetRule, SpendSource, Unit } from '../core/types.js';
import { BackendError, type ReminderDelivery } from './backend.js';
import type { Ctx } from './ctx.js';
import { h, icon, type Child } from './dom.js';
import { confirmDialog, copyText, openDialog } from './ui.js';

// ---------------------------------------------------------------------------
// Small form helpers
// ---------------------------------------------------------------------------

function field(label: string, control: HTMLElement, help?: string, full = false): HTMLElement {
  return h('label', { class: full ? 'field full' : 'field' }, h('span', null, label), control, help ? h('small', null, help) : null);
}

function textInput(id: string, value: string, placeholder = '', type = 'text'): HTMLInputElement {
  return h('input', { class: type === 'number' ? 'input num' : 'input', id, type, value, placeholder, autocomplete: 'off', step: type === 'number' ? 'any' : null, min: type === 'number' ? '0' : null }) as HTMLInputElement;
}

function selectInput<T extends string>(id: string, options: readonly { id: T; label: string }[], value: T): HTMLSelectElement {
  return h(
    'select',
    { class: 'select', id },
    options.map((option) => h('option', { value: option.id, selected: option.id === value }, option.label))
  ) as HTMLSelectElement;
}

function toLocalInput(isoText: string | null): string {
  const ms = toMs(isoText);
  if (ms === null) return '';
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInput(value: string): string | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function numberOf(input: HTMLInputElement): number | undefined {
  const raw = input.value.trim().replace(/,/g, '');
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : Number.NaN;
}

function describeError(error: unknown): string {
  if (error instanceof BackendError) return error.message;
  return (error as Error).message || 'Something went wrong.';
}

// ---------------------------------------------------------------------------
// Meter form
// ---------------------------------------------------------------------------

const RESET_KINDS: readonly { id: ResetRule['kind']; label: string }[] = [
  { id: 'interval', label: 'Every N hours or days (weekly cap)' },
  { id: 'monthly', label: 'Monthly, on a day' },
  { id: 'daily', label: 'Daily, at a time' },
  { id: 'rolling', label: 'N hours after first use (session)' },
  { id: 'once', label: 'Expires once, on a date' },
  { id: 'none', label: 'Never resets (balance)' }
];

interface MeterForm {
  el: HTMLElement;
  read(): MeterInput;
  original: Meter | null;
  removed: boolean;
}

let formSeq = 0;

function meterForm(meter: Meter | null, onRemove: ((form: MeterForm) => void) | null, othersValued = false): MeterForm {
  const n = (formSeq += 1);
  const rule: ResetRule = meter?.reset ?? { kind: 'interval', hours: 168 };
  const hours = rule.kind === 'rolling' || rule.kind === 'interval' ? rule.hours : 168;
  const inDays = hours % 24 === 0 && hours >= 24;

  const label = textInput(`m${n}-label`, meter?.label ?? '', 'Weekly limit');
  const role = selectInput(`m${n}-role`, [{ id: 'allowance', label: 'Allowance: lost when it resets' }, { id: 'throttle', label: 'Rate limit: only blocks use' }], meter?.role ?? 'allowance');
  const unit = selectInput<Unit>(`m${n}-unit`, UNITS, meter?.unit ?? 'percent');
  const limit = textInput(`m${n}-limit`, meter && meter.unit !== 'percent' ? String(meter.limit) : '', '2500', 'number');
  const noun = textInput(`m${n}-noun`, meter?.unitLabel ?? '', 'songs');
  const used = textInput(`m${n}-used`, meter ? String(Math.round(meter.used * 100) / 100) : '', '0', 'number');
  const kind = selectInput(`m${n}-kind`, RESET_KINDS, rule.kind);
  const every = textInput(`m${n}-every`, String(inDays ? hours / 24 : hours), '7', 'number');
  const everyUnit = selectInput(`m${n}-everyunit`, [{ id: 'hours', label: 'hours' }, { id: 'days', label: 'days' }], inDays ? 'days' : 'hours');
  const day = textInput(`m${n}-day`, rule.kind === 'monthly' ? String(rule.day) : '1', '1', 'number');
  const time = textInput(`m${n}-time`, rule.kind === 'daily' || rule.kind === 'monthly' ? rule.time : '00:00', '00:00', 'time');
  const zone = textInput(`m${n}-tz`, rule.kind === 'daily' || rule.kind === 'monthly' ? rule.tz : localZone(), 'Europe/Stockholm');
  const resetsAt = textInput(`m${n}-resets`, toLocalInput(meter?.resetsAt ?? null), '', 'datetime-local');
  const carries = h('input', { type: 'checkbox', id: `m${n}-carries`, checked: meter?.rollover === 'carries' }) as HTMLInputElement;
  // A new meter counts as money only when nothing else on the subscription does yet: one fee is split
  // between the quotas that are ticked, so ticking a second one by default would quietly halve the first.
  const valued = h('input', { type: 'checkbox', id: `m${n}-valued`, checked: meter ? meter.valueShare > 0 : !othersValued }) as HTMLInputElement;
  const partial = h('input', { type: 'checkbox', id: `m${n}-partial`, checked: meter?.partial === true }) as HTMLInputElement;

  const limitField = field('Limit', limit);
  const nounField = field('Called', noun, 'What one unit is called.');
  const everyField = field('Length', h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' } }, every, everyUnit));
  const dayField = field('Day of month', day);
  const timeField = field('Time', time);
  const zoneField = field('Time zone', zone, 'An IANA name, for example America/Los_Angeles.');
  const resetsField = field('Current window resets', resetsAt, 'Leave empty if you do not know yet.');
  const valueRow = h('label', { class: 'check full' }, valued, 'Count unused quota of this meter as money lost (the plan fee is split between the quotas that are ticked)');
  const carryRow = h('label', { class: 'check full' }, carries, 'Unused quota carries over to the next window');
  const partialRow = h('label', { class: 'check full' }, partial, 'Covers only part of the plan (one model family): reaching it does not block the rest');

  const sync = (): void => {
    const k = kind.value as ResetRule['kind'];
    limitField.hidden = unit.value === 'percent';
    nounField.hidden = unit.value !== 'count';
    everyField.hidden = !(k === 'interval' || k === 'rolling');
    dayField.hidden = k !== 'monthly';
    timeField.hidden = !(k === 'daily' || k === 'monthly');
    zoneField.hidden = !(k === 'daily' || k === 'monthly');
    resetsField.hidden = !(k === 'interval' || k === 'rolling' || k === 'once');
    const throttle = role.value === 'throttle';
    valueRow.hidden = throttle;
    carryRow.hidden = throttle;
    partialRow.hidden = !throttle;
  };
  for (const control of [kind, unit, role]) control.addEventListener('change', sync);

  const form: MeterForm = {
    original: meter,
    removed: false,
    el: h(
      'fieldset',
      { class: 'meter-form', style: { margin: '0' } },
      h(
        'div',
        { class: 'meter-form-head' },
        h('b', null, meter ? meter.label : 'New meter'),
        onRemove ? h('button', { class: 'btn small quiet', type: 'button', onclick: () => onRemove(form) }, icon('trash'), 'Remove') : null
      ),
      h('div', { class: 'form-grid' }, field('Name', label), field('Kind', role), field('Counted in', unit), limitField, nounField, field('Used so far', used)),
      h('div', { class: 'form-grid' }, field('Resets', kind, undefined, true), everyField, dayField, timeField, zoneField, resetsField, valueRow, carryRow, partialRow)
    ),
    read(): MeterInput {
      const k = kind.value as ResetRule['kind'];
      const length = (numberOf(every) ?? 0) * (everyUnit.value === 'days' ? 24 : 1);
      let reset: ResetRule;
      if (k === 'interval' || k === 'rolling') reset = { kind: k, hours: length };
      else if (k === 'daily') reset = { kind: 'daily', time: time.value || '00:00', tz: zone.value.trim() || 'UTC' };
      else if (k === 'monthly') reset = { kind: 'monthly', day: numberOf(day) ?? 1, time: time.value || '00:00', tz: zone.value.trim() || 'UTC' };
      else reset = { kind: k };
      const input: MeterInput = {
        label: label.value,
        role: role.value === 'throttle' ? 'throttle' : 'allowance',
        unit: unit.value as Unit,
        reset,
        rollover: carries.checked ? 'carries' : 'none',
        valueShare: valued.checked && role.value !== 'throttle' ? 1 : 0
      };
      if (meter) input.key = meter.key;
      if (role.value === 'throttle') input.partial = partial.checked;
      if (unit.value !== 'percent') {
        const value = numberOf(limit);
        if (value !== undefined) input.limit = value;
      }
      if (unit.value === 'count' && noun.value.trim()) input.unitLabel = noun.value.trim();
      const usedValue = numberOf(used);
      if (usedValue !== undefined) input.used = usedValue;
      if (!resetsField.hidden) input.resetsAt = fromLocalInput(resetsAt.value);
      return input;
    }
  };
  sync();
  return form;
}

function priceFields(price: Price | null, currencyDefault: string): { nodes: HTMLElement[]; read: () => Price | null } {
  const amount = textInput('acc-price', price ? String(price.amount) : '', '20', 'number');
  const currency = textInput('acc-currency', price?.currency ?? currencyDefault, 'USD');
  currency.maxLength = 3;
  const period = selectInput('acc-period', [{ id: 'month', label: 'per month' }, { id: 'year', label: 'per year' }], price?.period ?? 'month');
  return {
    nodes: [field('Price', amount, 'Used to put a money value on unused quota.'), field('Currency', currency), field('Billed', period)],
    read: () => {
      const value = numberOf(amount);
      if (value === undefined || value === 0) return null;
      return { amount: value, currency: (currency.value.trim() || 'USD').toUpperCase(), period: period.value === 'year' ? 'year' : 'month' };
    }
  };
}

// ---------------------------------------------------------------------------
// Quick entry
// ---------------------------------------------------------------------------

export function quickDialog(ctx: Ctx, prefill = ''): void {
  const { state } = ctx.app.model;
  const dialog = openDialog({ title: 'Update usage', class: 'top', head: false });
  const input = h('input', {
    class: 'palette-input',
    id: 'quick-input',
    type: 'text',
    value: prefill,
    autocomplete: 'off',
    spellcheck: 'false',
    placeholder: 'claude weekly 62%, or suno 1200 left resets in 9d',
    'aria-label': 'Quick update'
  }) as HTMLInputElement;
  const preview = h('p', { class: 'palette-preview', 'aria-live': 'polite' });
  const cands = h('div', { class: 'cands' });
  const examples = state.accounts.slice(0, 3).map((account, index) => {
    const word = account.label.toLowerCase().split(/\s+/)[0] ?? 'name';
    return [`${word} 62%`, `${word} 38% left`, `${word} 45% resets in 3d 4h`][index] ?? `${word} 50%`;
  });
  dialog.el.insertBefore(input, dialog.body);
  dialog.body.className = 'palette-body';
  dialog.body.append(
    preview,
    cands,
    h(
      'div',
      { class: 'examples' },
      h('span', null, 'Name, then an amount, then optionally when it resets:'),
      (examples.length ? examples : ['claude 62%', 'suno 1200 left', 'copilot 140/300 resets nov 30']).map((example) => h('code', null, example)),
      h('span', { style: { marginTop: '4px' } }, 'A bare amount means used. Enter saves, Esc closes.')
    )
  );
  dialog.foot.hidden = true;

  const refresh = (): void => {
    const text = input.value.trim();
    cands.replaceChildren();
    if (!text) {
      preview.className = 'palette-preview';
      preview.textContent = 'Type an account and what its usage page says.';
      return;
    }
    const parsed = parseQuick(text, ctx.app.model.state, Date.now());
    if (parsed.ok) {
      preview.className = 'palette-preview ok';
      preview.replaceChildren(icon('check'), ' ', parsed.preview);
      return;
    }
    preview.className = 'palette-preview err';
    preview.textContent = parsed.error;
    for (const candidate of parsed.candidates) {
      cands.appendChild(
        h(
          'button',
          {
            class: 'chip-btn',
            type: 'button',
            onclick: () => {
              // Replace the name part with the candidate's exact id and keep whatever amount was typed.
              const rest = text.match(/\s(\$?\d[\d,.]*[kKmM]?%?(\/\S+)?(\s.*)?)$/)?.[1] ?? '';
              input.value = `${candidate.meterId ?? candidate.accountId} ${rest}`.trimEnd() + (rest ? '' : ' ');
              input.focus();
              refresh();
            }
          },
          candidate.label
        )
      );
    }
  };
  input.addEventListener('input', refresh);
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    const parsed = parseQuick(text, ctx.app.model.state, Date.now());
    if (!parsed.ok) {
      refresh();
      return;
    }
    void ctx.actions.run(ctx.app.model.backend.quick(text), 'Updated').then((ok) => {
      if (ok) {
        ctx.app.select(parsed.meter.id);
        dialog.close();
      }
    });
  });
  refresh();
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

// ---------------------------------------------------------------------------
// Add a subscription
// ---------------------------------------------------------------------------

/** A plan's meters in one line, each as the catalog names it, with its size the way every other view writes it. */
function planSummary(plan: PresetPlan): string {
  return plan.meters
    .map((meter) => (meter.unit === 'percent' || meter.limit === undefined ? meter.label : `${meter.label} (${formatAmount(meter, meter.limit)})`))
    .join(' · ');
}

export function addDialog(ctx: Ctx): void {
  const dialog = openDialog({ title: 'Add a subscription', class: 'wide' });
  const currency = ctx.app.model.state.settings.currency;
  let provider: ProviderPreset | null = null;
  let custom = false;
  let category: ProviderCategory | 'all' = 'all';
  let search = '';

  const searchInput = h('input', { class: 'input', id: 'add-search', type: 'search', placeholder: 'Search providers', 'aria-label': 'Search providers' }) as HTMLInputElement;
  const chipRow = h('div', { class: 'chips' });
  const grid = h('div', { class: 'providers' });
  const detail = h('div', { class: 'stack' });
  const addButton = h('button', { class: 'btn primary', type: 'button', disabled: true }, 'Add') as HTMLButtonElement;
  let submit: (() => Promise<void>) | null = null;

  const categories = [...new Set(CATALOG.map((entry) => entry.category))];
  const drawChips = (): void => {
    chipRow.replaceChildren(
      ...(['all', ...categories] as (ProviderCategory | 'all')[]).map((id) =>
        h(
          'button',
          {
            class: 'chip-btn',
            type: 'button',
            'aria-pressed': String(category === id),
            onclick: () => {
              category = id;
              drawChips();
              drawGrid();
            }
          },
          id === 'all' ? 'All' : CATEGORY_LABEL[id]
        )
      )
    );
  };

  const drawGrid = (): void => {
    const needle = search.trim().toLowerCase();
    const shown = CATALOG.filter(
      (entry) => (category === 'all' || entry.category === category) && (!needle || `${entry.name} ${entry.vendor} ${entry.id}`.toLowerCase().includes(needle))
    );
    grid.replaceChildren(
      ...shown.map((entry) =>
        h(
          'button',
          {
            class: 'provider',
            type: 'button',
            'aria-pressed': String(provider?.id === entry.id && !custom),
            onclick: () => {
              provider = entry;
              custom = false;
              drawGrid();
              drawDetail();
            }
          },
          h('span', { class: 'mono', 'aria-hidden': 'true' }, entry.monogram),
          h('div', null, h('b', null, entry.name), h('span', null, CATEGORY_LABEL[entry.category]))
        )
      ),
      h(
        'button',
        {
          class: 'provider',
          type: 'button',
          'aria-pressed': String(custom),
          onclick: () => {
            custom = true;
            provider = null;
            drawGrid();
            drawDetail();
          }
        },
        h('span', { class: 'mono', 'aria-hidden': 'true' }, '+'),
        h('div', null, h('b', null, 'Something else'), h('span', null, 'Define it yourself'))
      )
    );
  };

  const drawDetail = (): void => {
    detail.replaceChildren();
    dialog.setError(null);
    submit = null;
    addButton.disabled = true;
    if (custom) {
      const label = textInput('add-label', '', 'Midjourney Standard');
      const price = priceFields(null, currency);
      const form = meterForm(null, null);
      detail.append(h('div', { class: 'form-grid three' }, field('Name', label, undefined, true), ...price.nodes), form.el);
      addButton.disabled = false;
      submit = () => {
        const input: AccountInput = { providerId: 'custom', label: label.value, price: price.read(), meters: [form.read()] };
        return ctx.app.model.backend.addAccount(input);
      };
      label.focus();
      return;
    }
    if (!provider) return;
    const chosen = provider;
    const name = textInput('add-label', '', chosen.name);
    const price = priceFields(chosen.plans[0]?.price ?? null, currency);
    let planId = chosen.plans[0]?.id ?? '';
    const billingDay = textInput('add-billing-day', '', String(new Date().getDate()), 'number');
    billingDay.min = '1';
    billingDay.max = '31';
    const billingField = field('Renews on day', billingDay, 'Day of the month your subscription renews. Leave empty to set it later.');
    const syncBilling = (): void => {
      const current = chosen.plans.find((entry) => entry.id === planId);
      billingField.hidden = !current || !planNeedsBillingDay(current);
    };
    const plans = h(
      'div',
      { class: 'plans', role: 'radiogroup', 'aria-label': 'Plan' },
      chosen.plans.map((plan, index) => {
        const radio = h('input', { type: 'radio', name: 'add-plan', id: `add-plan-${index}`, value: plan.id, checked: index === 0 }) as HTMLInputElement;
        radio.addEventListener('change', () => {
          planId = plan.id;
          // Follow the plan's list price until the user types their own.
          const amountInput = price.nodes[0]?.querySelector('input');
          if (amountInput && !amountInput.dataset['touched']) amountInput.value = plan.price ? String(plan.price.amount) : '';
          syncBilling();
        });
        return h(
          'label',
          { class: 'plan' },
          radio,
          h('b', null, plan.name),
          h('span', { class: 'p' }, plan.price ? `${formatMoney(plan.price.amount, plan.price.currency)}/${plan.price.period === 'year' ? 'yr' : 'mo'}` : ''),
          h('span', { class: 'd' }, planSummary(plan), plan.note ? ` — ${plan.note}` : '')
        );
      })
    );
    price.nodes[0]?.querySelector('input')?.addEventListener('input', (event) => {
      (event.target as HTMLInputElement).dataset['touched'] = '1';
    });
    detail.append(
      h('div', null, h('p', { class: 'group-title' }, `${chosen.name} plans`), plans),
      h('div', { class: 'form-grid three' }, field('Name (optional)', name, undefined, true), ...price.nodes, billingField),
      h('p', { class: 'hint' }, `Where to read usage: ${chosen.howToRead} Presets were checked ${CATALOG_CHECKED}; every number can be edited afterwards.`)
    );
    syncBilling();
    addButton.disabled = false;
    submit = () => {
      const preset: { provider: string; plan: string; label?: string; price?: Price | null; billingDay?: number } = { provider: chosen.id, plan: planId, price: price.read() };
      if (name.value.trim()) preset.label = name.value.trim();
      const day = numberOf(billingDay);
      if (!billingField.hidden && day !== undefined && Number.isInteger(day) && day >= 1 && day <= 31) preset.billingDay = day;
      return ctx.app.model.backend.addPreset(preset);
    };
  };

  searchInput.addEventListener('input', () => {
    search = searchInput.value;
    drawGrid();
  });
  addButton.addEventListener('click', () => {
    if (!submit) return;
    const before = new Set(ctx.app.model.state.accounts.map((account) => account.id));
    addButton.disabled = true;
    submit()
      .then(async () => {
        await ctx.app.reload();
        const created = ctx.app.model.state.accounts.find((account) => !before.has(account.id));
        const main = created?.meters.find((meter) => meter.role === 'allowance') ?? created?.meters[0];
        if (main) ctx.app.select(main.id);
        dialog.close();
      })
      .catch((error: unknown) => {
        dialog.setError(describeError(error));
        addButton.disabled = false;
      });
  });

  dialog.body.append(h('div', { class: 'stack' }, searchInput, chipRow, grid, detail));
  dialog.foot.append(h('span', { class: 'sp' }), h('button', { class: 'btn', type: 'button', onclick: dialog.close }, 'Cancel'), addButton);
  drawChips();
  drawGrid();
  searchInput.focus();
}

// ---------------------------------------------------------------------------
// Edit a subscription
// ---------------------------------------------------------------------------

export function editDialog(ctx: Ctx, account: Account): void {
  const dialog = openDialog({ title: `Edit ${account.label}`, class: 'wide' });
  const backend = ctx.app.model.backend;
  const label = textInput('acc-label', account.label);
  const plan = textInput('acc-plan', account.plan ?? '', 'Pro');
  const price = priceFields(account.price, ctx.app.model.state.settings.currency);
  const url = textInput('acc-url', account.usageUrl ?? '', 'https://…', 'url');
  const notes = h('textarea', { class: 'input', id: 'acc-notes', placeholder: 'Ideas for using this quota when it is about to expire, account details, anything.' }) as HTMLTextAreaElement;
  notes.value = account.notes ?? '';

  const forms: MeterForm[] = [];
  const list = h('div', null);
  const remove = (form: MeterForm): void => {
    if (forms.filter((entry) => !entry.removed).length <= 1) {
      dialog.setError('A subscription needs at least one meter. Delete the subscription instead.');
      return;
    }
    form.removed = true;
    form.el.remove();
  };
  for (const meter of account.meters) {
    const form = meterForm(meter, remove);
    forms.push(form);
    list.appendChild(form.el);
  }
  const addMeterButton = h(
    'button',
    {
      class: 'btn small',
      type: 'button',
      onclick: () => {
        const othersValued = account.meters.some((existing) => existing.role === 'allowance' && existing.unit !== 'usd' && existing.valueShare > 0);
        const form = meterForm(null, remove, othersValued);
        forms.push(form);
        list.appendChild(form.el);
      }
    },
    icon('plus'),
    'Add a meter'
  );

  const save = h('button', { class: 'btn primary', type: 'button' }, 'Save') as HTMLButtonElement;
  save.addEventListener('click', () => {
    void (async () => {
      // Removing a meter discards its readings, so it gets its own confirmation that names it.
      const removed = forms.filter((form) => form.original && form.removed).map((form) => (form.original as Meter).label);
      if (removed.length > 0) {
        const yes = await confirmDialog({
          title: removed.length === 1 ? `Remove ${removed[0]}?` : `Remove ${removed.length} meters?`,
          message: `This removes ${removed.join(', ')} from ${account.label}, with the readings of the current window. Finished windows stay in History.`,
          confirm: 'Remove'
        });
        if (!yes) return;
      }
      applyChanges();
    })();
  });
  /** What differs between a saved meter and what its form now says. */
  const patchFor = (o: Meter, next: MeterInput): MeterPatch => {
    const patch: MeterPatch = {};
    if (next.label !== o.label) patch.label = next.label;
    if (next.role !== o.role && next.role) patch.role = next.role;
    if (next.unit !== o.unit && next.unit) patch.unit = next.unit;
    if ((next.unitLabel ?? '') !== (o.unitLabel ?? '')) patch.unitLabel = next.unitLabel ?? '';
    // A percent meter has an implicit limit of 100, so a new unit always takes its limit along: a
    // typed 100 is a real limit, not "unchanged".
    if (next.limit !== undefined && (next.limit !== o.limit || patch.unit !== undefined)) patch.limit = next.limit;
    if (next.used !== undefined && Math.abs(next.used - o.used) > 0.005) patch.used = next.used;
    if (JSON.stringify(next.reset) !== JSON.stringify(o.reset)) patch.reset = next.reset;
    // A new rule clears the reset time unless one comes with it, so the time shown in the form always
    // goes along. Otherwise it is sent only when it was moved: the field shows minutes, not seconds.
    const moved = Math.abs((toMs(next.resetsAt ?? null) ?? 0) - (toMs(o.resetsAt) ?? 0)) > 60_000;
    if (next.resetsAt !== undefined && (moved || patch.reset !== undefined)) patch.resetsAt = next.resetsAt;
    if ((next.rollover ?? 'none') !== o.rollover && next.rollover) patch.rollover = next.rollover;
    if ((next.valueShare ?? 0) > 0 !== o.valueShare > 0 && next.valueShare !== undefined) patch.valueShare = next.valueShare;
    if ((next.partial === true) !== (o.partial === true)) patch.partial = next.partial === true;
    return patch;
  };
  const applyChanges = (): void => {
    // The one mistake a form can be checked for without asking the service, caught before anything is sent.
    const unlimited = forms.find((form) => !form.removed && form.read().unit !== 'percent' && form.read().limit === undefined);
    if (unlimited) {
      dialog.setError(`Give ${unlimited.read().label.trim() || 'the new meter'} a limit, or count it in percent.`);
      return;
    }
    save.disabled = true;
    dialog.setError(null);
    const work = async (): Promise<void> => {
      await backend.updateAccount(account.id, { label: label.value, plan: plan.value || null, price: price.read(), usageUrl: url.value || null, notes: notes.value || null });
      // Every step is a request of its own, so a refusal part-way leaves the earlier ones saved. Each form
      // records what it has done, and a second Save sends only what is still outstanding.
      for (const form of [...forms]) {
        if (form.original && form.removed) {
          await backend.removeMeter(form.original.id);
          forms.splice(forms.indexOf(form), 1);
        } else if (form.original) {
          const patch = patchFor(form.original, form.read());
          if (Object.keys(patch).length > 0) form.original = await backend.updateMeter(form.original.id, patch);
        } else if (!form.removed) form.original = await backend.addMeter(account.id, form.read());
      }
    };
    work()
      .then(async () => {
        await ctx.app.reload();
        dialog.close();
      })
      .catch(async (error: unknown) => {
        // Earlier steps may have applied; show the real state behind the dialog.
        await ctx.app.reload().catch(() => undefined);
        dialog.setError(describeError(error));
        save.disabled = false;
      });
  };

  dialog.body.append(
    h(
      'div',
      { class: 'stack' },
      h('div', { class: 'form-grid' }, field('Name', label), field('Plan', plan)),
      h('div', { class: 'form-grid three' }, ...price.nodes),
      h('div', { class: 'form-grid' }, field('Usage page', url, 'Opened by the "Usage page" button and named to agents.', true), field('Notes', notes, undefined, true)),
      h('div', null, h('p', { class: 'group-title' }, 'Meters'), list, h('div', { style: { marginTop: '10px' } }, addMeterButton))
    )
  );
  dialog.foot.append(h('span', { class: 'sp' }), h('button', { class: 'btn', type: 'button', onclick: dialog.close }, 'Cancel'), save);
}

// ---------------------------------------------------------------------------
// Spend
// ---------------------------------------------------------------------------

export function spendDialog(ctx: Ctx, source: SpendSource | null): void {
  const dialog = openDialog({ title: source ? `Edit ${source.label}` : 'Add a spend source' });
  const apiProviders = CATALOG.filter((entry) => entry.category === 'api' || entry.category === 'coding' || entry.category === 'assistant' || entry.category === 'voice');
  const label = textInput('sp-label', source?.label ?? '', 'OpenAI API');
  const provider = selectInput('sp-provider', [{ id: 'custom', label: 'Other' }, ...apiProviders.map((entry) => ({ id: entry.id, label: entry.name }))], source?.providerId ?? 'custom');
  const currency = textInput('sp-currency', source?.currency ?? ctx.app.model.state.settings.currency, 'USD');
  currency.maxLength = 3;
  const budget = textInput('sp-budget', source?.monthlyBudget ? String(source.monthlyBudget) : '', '50', 'number');
  const save = h('button', { class: 'btn primary', type: 'button' }, source ? 'Save' : 'Add') as HTMLButtonElement;
  save.addEventListener('click', () => {
    const backend = ctx.app.model.backend;
    const budgetValue = numberOf(budget) ?? null;
    const work = source
      ? backend.updateSpend(source.id, { label: label.value, currency: currency.value, monthlyBudget: budgetValue })
      : backend.addSpend({ label: label.value, providerId: provider.value, currency: currency.value, monthlyBudget: budgetValue });
    save.disabled = true;
    work
      .then(async () => {
        await ctx.app.reload();
        dialog.close();
      })
      .catch((error: unknown) => {
        dialog.setError(describeError(error));
        save.disabled = false;
      });
  });
  dialog.body.append(
    h(
      'div',
      { class: 'form-grid' },
      field('Name', label, undefined, true),
      source ? null : field('Provider', provider),
      field('Currency', currency),
      field('Monthly budget', budget, 'Optional. Leave empty for none.')
    )
  );
  dialog.foot.append(h('span', { class: 'sp' }), h('button', { class: 'btn', type: 'button', onclick: dialog.close }, 'Cancel'), save);
  label.focus();
}

export function logSpendDialog(ctx: Ctx, source: SpendSource): void {
  const dialog = openDialog({ title: `Log spend for ${source.label}` });
  const amount = textInput('ls-amount', '', '3.40', 'number');
  const date = textInput('ls-date', dateKey(Date.now()), '', 'date');
  const mode = selectInput('ls-mode', [{ id: 'add', label: 'Add to that day' }, { id: 'set', label: "Replace that day's total" }], 'add');
  const save = h('button', { class: 'btn primary', type: 'button' }, 'Log') as HTMLButtonElement;
  const submit = (): void => {
    const value = numberOf(amount);
    if (value === undefined || Number.isNaN(value)) {
      dialog.setError('Enter an amount.');
      return;
    }
    save.disabled = true;
    ctx.app.model.backend
      .recordSpend(source.id, { amount: value, date: date.value || dateKey(Date.now()), mode: mode.value === 'set' ? 'set' : 'add' })
      .then(async () => {
        await ctx.app.reload();
        dialog.close();
      })
      .catch((error: unknown) => {
        dialog.setError(describeError(error));
        save.disabled = false;
      });
  };
  save.addEventListener('click', submit);
  amount.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') submit();
  });
  dialog.body.append(h('div', { class: 'form-grid three' }, field(`Amount (${source.currency})`, amount), field('Day', date), field('How', mode)));
  dialog.foot.append(h('span', { class: 'sp' }), h('button', { class: 'btn', type: 'button', onclick: dialog.close }, 'Cancel'), save);
  amount.focus();
}

// ---------------------------------------------------------------------------
// Connect
// ---------------------------------------------------------------------------

function snippet(title: string, description: string, code: string): HTMLElement {
  return h(
    'div',
    { class: 'snip' },
    h(
      'div',
      { class: 'snip-head' },
      h('div', null, h('b', null, title), h('p', null, description)),
      h('button', { class: 'btn small', type: 'button', onclick: () => void copyText(code, `${title} copied`) }, icon('copy'), 'Copy')
    ),
    h('pre', { tabindex: 0 }, code)
  );
}

export function connectDialog(ctx: Ctx): void {
  const { meta, demo } = ctx.app.model;
  const dialog = openDialog({ title: 'Connect agents', class: 'wide' });
  const snippets = connectSnippets({ origin: meta.origin || 'http://127.0.0.1:4777', cli: meta.cli, tokenRequired: meta.tokenRequired });
  const groups = [...new Set(snippets.map((entry) => entry.group))];
  const nodes: Child[] = [
    h(
      'p',
      { class: 'hint', style: { marginBottom: '14px' } },
      'Tokengator speaks MCP. Once connected, an agent can ask which subscription to spend first (what_to_use) and report fresh numbers after reading a usage page (report_usage).',
      demo ? ' These snippets use the default address because this page is showing sample data.' : ''
    )
  ];
  for (const group of groups) {
    nodes.push(h('p', { class: 'group-title' }, CONNECT_GROUP_LABEL[group]));
    for (const entry of snippets.filter((candidate) => candidate.group === group)) nodes.push(snippet(entry.title, entry.description, entry.code));
  }
  if (meta.tokenRequired) {
    nodes.push(h('p', { class: 'hint', style: { marginTop: '14px' } }, 'This instance requires an access token. The snippets read it from the TOKENGATOR_TOKEN environment variable; the value is never shown here.'));
  }
  dialog.body.append(h('div', null, nodes));
  dialog.foot.append(h('span', { class: 'sp' }), h('button', { class: 'btn primary', type: 'button', onclick: dialog.close }, 'Done'));
}

// ---------------------------------------------------------------------------
// Automatic sources
// ---------------------------------------------------------------------------

const SOURCE_KIND: Record<string, string> = {
  'local-file': 'reads a local file',
  'documented-api': 'documented API',
  'undocumented-api': 'undocumented endpoint',
  push: 'pushed by the tool itself'
};

export function sourcesDialog(ctx: Ctx): void {
  const dialog = openDialog({ title: 'Automatic sources', class: 'wide' });
  const draw = (): void => {
    const { collectors, demo, now } = ctx.app.model;
    dialog.body.replaceChildren();
    dialog.body.appendChild(
      h(
        'p',
        { class: 'hint', style: { marginBottom: '14px' } },
        'Sources fill meters without typing. Each one is off until you switch it on. Credentials are read from environment variables when a source runs and are never stored or shown.'
      )
    );
    if (demo || collectors.length === 0) {
      dialog.body.appendChild(
        h('p', null, demo ? 'Automatic sources run in the local service. They are not available while this page is showing sample data.' : 'This instance has no automatic sources available.')
      );
      return;
    }
    dialog.body.appendChild(
      h(
        'div',
        null,
        collectors.map((collector) => {
          const toggle = h(
            'button',
            {
              class: collector.enabled ? 'btn small' : 'btn small primary',
              type: 'button',
              disabled: !collector.enabled && !collector.available,
              onclick: () => {
                void ctx.actions.run(ctx.app.model.backend.setCollector(collector.id, !collector.enabled), collector.enabled ? 'Source switched off' : 'Source switched on').then(draw);
              }
            },
            collector.enabled ? 'Switch off' : 'Switch on'
          );
          const outcome =
            collector.lastOutcome === null
              ? 'not run yet'
              : `${collector.lastOutcome === 'ok' ? 'worked' : collector.lastOutcome === 'auth' ? 'credential rejected' : collector.lastOutcome === 'unavailable' ? 'nothing to read' : 'failed'} ${collector.lastRunAt ? formatAge(now - (toMs(collector.lastRunAt) ?? now)) : ''}`;
          return h(
            'div',
            { class: 'collector' },
            h('div', null, h('b', null, collector.title), h('p', null, collector.description)),
            toggle,
            h(
              'div',
              { class: 'st' },
              h('span', { class: collector.sourceKind === 'undocumented-api' ? 'tag warn' : 'tag' }, SOURCE_KIND[collector.sourceKind] ?? collector.sourceKind),
              collector.env.map((name) => h('span', { class: 'tag' }, name)),
              h('span', null, collector.available ? outcome : (collector.reason ?? 'not available')),
              collector.lastMessage && collector.lastOutcome !== 'ok' ? h('span', null, `· ${collector.lastMessage}`) : null
            )
          );
        })
      )
    );
  };
  draw();
  const unsubscribe = ctx.app.onChange(draw);
  dialog.el.addEventListener('close', unsubscribe);
  dialog.foot.append(
    h('button', { class: 'btn', type: 'button', onclick: () => void ctx.actions.run(ctx.app.model.backend.refresh(), 'Sources refreshed') }, icon('refresh'), 'Run now'),
    h('span', { class: 'sp' }),
    h('button', { class: 'btn primary', type: 'button', onclick: dialog.close }, 'Done')
  );
}

// ---------------------------------------------------------------------------
// Reminders
// ---------------------------------------------------------------------------

export interface TabNotifications {
  /** Whether notifications in this browser tab are on. */
  on(): boolean;
  /** Asks for permission if needed and flips the setting. */
  toggle(): Promise<void>;
}

const CHANNEL_NAME: Record<ReminderDelivery['channel'], string> = { desktop: 'This computer', webhook: 'Your address' };

export function remindersDialog(ctx: Ctx, tab: TabNotifications): void {
  const dialog = openDialog({ title: 'Reminders', class: 'wide' });
  let testResult: string | null = null;

  const row = (title: string, description: string, action: Child, status: Child[]): HTMLElement =>
    h('div', { class: 'collector' }, h('div', null, h('b', null, title), h('p', null, description)), action, h('div', { class: 'st' }, status));
  const switchButton = (on: boolean, disabled: boolean, onclick: () => void): HTMLElement =>
    h('button', { class: on ? 'btn small' : 'btn small primary', type: 'button', disabled, 'aria-pressed': String(on), onclick }, on ? 'Switch off' : 'Switch on');
  const tag = (text: string, warn = false): HTMLElement => h('span', { class: warn ? 'tag warn' : text === 'on' ? 'tag on' : 'tag' }, text);

  const draw = (): void => {
    const { reminders, demo, meta, state, backend } = ctx.app.model;
    const live = !demo && backend.kind === 'http';
    const desktopOn = live && reminders.desktop.enabled;

    const sendTest = async (): Promise<void> => {
      try {
        const deliveries = await backend.testReminders();
        testResult =
          deliveries.length === 0
            ? 'Nothing is switched on to test.'
            : deliveries.map((delivery) => `${CHANNEL_NAME[delivery.channel]}: ${delivery.ok ? 'test sent' : (delivery.error ?? 'it did not work')}`).join(' ');
      } catch (error) {
        testResult = (error as Error).message;
      }
      draw();
    };
    const toggleDesktop = async (): Promise<void> => {
      const turnOn = !desktopOn;
      const ok = await ctx.actions.run(backend.updateSettings({ desktopReminders: turnOn }), turnOn ? 'Reminders on this computer are on' : 'Reminders on this computer are off');
      // Switching on is the moment to find out whether a notification can be shown at all.
      if (ok && turnOn) await sendTest();
      else draw();
    };

    const feedUrl = `${meta.origin || 'http://127.0.0.1:4777'}/api/calendar.ics`;
    const calendarAction = live
      ? h(
          'div',
          { style: { display: 'flex', gap: '6px' } },
          h('button', { class: 'btn small', type: 'button', onclick: () => void copyText(feedUrl, 'Calendar address copied') }, icon('copy'), 'Copy address'),
          h('a', { class: 'btn small', href: '/api/calendar.ics', target: '_blank', rel: 'noopener noreferrer' }, icon('external'), 'Open')
        )
      : h('button', { class: 'btn small', type: 'button', onclick: () => void copyText(calendarFeed(state, Date.now()), 'Calendar copied as iCalendar text') }, icon('copy'), 'Copy as .ics');

    dialog.body.replaceChildren(
      h(
        'p',
        { class: 'hint', style: { marginBottom: '14px' } },
        'Quota expires when nobody is looking. Each quota is raised once per window, at the moment it becomes “use now”, and snoozed subscriptions stay quiet.'
      ),
      h(
        'div',
        null,
        row(
          'In this browser tab',
          'A browser notification while a Tokengator tab is open.',
          switchButton(tab.on(), false, () => void tab.toggle().then(draw)),
          [tag(tab.on() ? 'on' : 'off'), demo ? h('span', null, 'Quiet while this page shows sample data.') : null]
        ),
        row(
          'On this computer',
          'A notification from the local service, also when the browser is closed.',
          h(
            'div',
            { style: { display: 'flex', gap: '6px' } },
            live && (desktopOn || reminders.webhook.configured) ? h('button', { class: 'btn small', type: 'button', onclick: () => void sendTest() }, 'Send a test') : null,
            switchButton(desktopOn, !live || (!desktopOn && !reminders.desktop.supported), () => void toggleDesktop())
          ),
          !live
            ? [h('span', null, 'Needs the local service. Not available while this page shows sample data.')]
            : [
                tag(desktopOn ? 'on' : 'off'),
                !reminders.desktop.supported ? h('span', null, 'This system has no standard notification command.') : null,
                testResult ? h('span', { role: 'status' }, testResult) : null
              ]
        ),
        row(
          'On your phone or in a chat',
          'The same line, posted to an address of your own: an ntfy topic, a Slack or a Discord webhook.',
          null,
          !live
            ? [h('span', null, 'Needs the local service.')]
            : reminders.webhook.configured
              ? [tag('on'), h('span', null, `Posting to ${reminders.webhook.host ?? 'your address'}. The address itself is never shown.`)]
              : [
                  tag(reminders.webhook.error ? 'not usable' : 'off', reminders.webhook.error !== null),
                  h('span', null, reminders.webhook.error ?? 'Add a line such as TOKENGATOR_NOTIFY_URL=https://ntfy.sh/a-name-only-you-know to ~/.tokengator/.env.')
                ]
        ),
        row(
          'In your calendar',
          'Every coming reset as an entry that covers the last stretch before it, with an alert when that stretch begins.',
          calendarAction,
          live
            ? [
                h(
                  'span',
                  null,
                  meta.tokenRequired
                    ? 'Calendar apps cannot send the access token, so open the file here and import it.'
                    : 'Subscribe to the address in a calendar app on this computer, or open the file and import it anywhere.'
                )
              ]
            : [h('span', null, 'Built from the sample data on this page.')]
        )
      ),
      h(
        'p',
        { class: 'hint', style: { marginTop: '14px' } },
        'Agents see the same thing where the quota gets spent: the status line names the most urgent quota. ',
        h('button', { class: 'link', type: 'button', onclick: () => { dialog.close(); ctx.actions.connect(); } }, 'Connect agents…')
      )
    );
  };
  draw();
  const unsubscribe = ctx.app.onChange(draw);
  dialog.el.addEventListener('close', unsubscribe);
  dialog.foot.append(h('span', { class: 'sp' }), h('button', { class: 'btn primary', type: 'button', onclick: dialog.close }, 'Done'));
}

// ---------------------------------------------------------------------------
// Shortcuts
// ---------------------------------------------------------------------------

export const SHORTCUTS: readonly { keys: string[]; what: string }[] = [
  { keys: ['1', '…', '6'], what: 'Switch view: Queue, Board, Timeline, Table, Costs, History' },
  { keys: ['U'], what: 'Update usage (quick entry)' },
  { keys: ['A'], what: 'Add a subscription' },
  { keys: ['C'], what: 'Copy the brief' },
  { keys: ['/'], what: 'Filter' },
  { keys: ['J', 'K'], what: 'Next and previous row' },
  { keys: ['Enter'], what: 'Open or close the selected row' },
  { keys: ['Esc'], what: 'Close details, menus and dialogs' },
  { keys: ['S'], what: 'Cycle the sort order' },
  { keys: ['T'], what: 'Switch theme' },
  { keys: ['?'], what: 'This list' }
];

export function shortcutsDialog(): void {
  const dialog = openDialog({ title: 'Keyboard shortcuts' });
  dialog.body.appendChild(
    h(
      'dl',
      { class: 'keys' },
      SHORTCUTS.flatMap((entry) => [h('dt', null, entry.keys.map((key) => h('kbd', { class: 'k' }, key))), h('dd', null, entry.what)])
    )
  );
  dialog.foot.append(h('span', { class: 'sp' }), h('button', { class: 'btn primary', type: 'button', onclick: dialog.close }, 'Done'));
}
