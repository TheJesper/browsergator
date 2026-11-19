// The shell: header, summary, toolbar, the active view and the inspector, plus routing, shortcuts, the
// one-second ticker and notifications.

import { briefMarkdown } from '../core/brief.js';
import { CATEGORY_LABEL, type ProviderCategory } from '../core/catalog-types.js';
import { SORT_ORDERS, type MeterView, type Money, type SortOrder } from '../core/forecast.js';
import { formatMoney, formatMoneyTotals, formatPercent } from '../core/format.js';
import { rememberReminders } from '../core/reminders.js';
import { formatAge, formatDuration } from '../core/time.js';
import { CREDIT_VALUE_NOTE, FIGURE_LABEL, PLAN_VALUE_NOTE, leftText, lostText, summaryLine } from '../core/wording.js';
import { App, OVERVIEW_TILES, VIEWS, type ViewId } from './app.js';
import { HttpBackend, MemoryBackend, type Backend } from './backend.js';
import type { Actions, Ctx } from './ctx.js';
import { addDialog, connectDialog, editDialog, logSpendDialog, quickDialog, remindersDialog, shortcutsDialog, sourcesDialog, spendDialog } from './dialogs.js';
import { brandMark, h, icon, mount } from './dom.js';
import { inspector } from './inspector.js';
import { costsView, historyView } from './ledger-views.js';
import { barLegend, refreshCountdowns } from './parts.js';
import {
  DIALOG_SCOPES,
  closeMenu,
  confirmDialog,
  copyText,
  dismissTip,
  focusFirst,
  hideTip,
  isDialogOpen,
  isMenuOpen,
  isShown,
  markFocus,
  onMenuClosed,
  restoreFocus,
  showMenu,
  toast,
  type FocusMark,
  type MenuEntry
} from './ui.js';
import { drawOverviewCharts, figuresInTiles, overviewView } from './overview.js';
import { boardView, queueView, tableTools, tableView, timelineView } from './views.js';

declare global {
  interface Window {
    /** Set by the single-file preview build: always run on sample data. */
    __TOKENGATOR_SAMPLE__?: boolean;
  }
}

const root = document.getElementById('app') as HTMLElement;

// ---------------------------------------------------------------------------
// Start-up: pick a data source
// ---------------------------------------------------------------------------

function wantsSample(): boolean {
  if (window.__TOKENGATOR_SAMPLE__) return true;
  try {
    return new URLSearchParams(location.search).has('demo') || location.protocol === 'file:';
  } catch {
    return false;
  }
}

async function chooseBackend(): Promise<{ backend: Backend; fellBack: boolean }> {
  if (wantsSample()) return { backend: new MemoryBackend(), fellBack: false };
  const http = new HttpBackend();
  // A token arrives in the fragment, which browsers never send to a server. Trade it for a cookie and drop it.
  const token = /(?:^|[#&])token=([^&]+)/.exec(location.hash)?.[1];
  if (token) {
    try {
      await http.signIn(decodeURIComponent(token));
    } catch {
      // the load below reports the problem
    }
    history.replaceState(null, '', `${location.pathname}${location.search}`);
  }
  try {
    await http.load();
    return { backend: http, fellBack: false };
  } catch (error) {
    if ((error as { code?: string }).code === 'unauthorized') throw error;
    // No service behind this page (opened as a file, or published as a preview): run on sample data.
    return { backend: new MemoryBackend(), fellBack: true };
  }
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

function start(app: App, fellBack: boolean): void {
  const header = h('header', { class: 'bar' });
  const banners = h('div', null);
  const summary = h('section', { class: 'summary', 'aria-label': 'Summary' });
  const toolbar = h('div', { class: 'toolbar' });
  const layout = h('div', { class: 'layout' });
  const pane = h('main', { class: 'pane', id: 'main' });
  layout.appendChild(pane);
  mount(root, header, banners, summary, toolbar, layout);

  const httpBackend: Backend | null = app.model.backend.kind === 'http' ? app.model.backend : null;

  const actions: Actions = {
    quick: (prefill) => quickDialog(ctx, prefill),
    add: () => addDialog(ctx),
    edit: (accountId) => {
      const account = app.model.state.accounts.find((candidate) => candidate.id === accountId);
      if (account) editDialog(ctx, account);
    },
    removeAccount: (view) => {
      // A dialog and a message are drawn outside the page, where a hidden name cannot be blurred.
      const named = app.model.prefs.privacy ? 'this subscription' : view.account.label;
      void confirmDialog({
        title: `Delete ${named}?`,
        message: `This removes ${named} and its ${view.account.meters.length} meter${view.account.meters.length === 1 ? '' : 's'} (${view.account.meters.map((meter) => meter.label).join(', ')}). Its finished windows stay in History.`,
        confirm: 'Delete'
      }).then((yes) => {
        if (!yes) return;
        if (app.model.selectedId && view.account.meters.some((meter) => meter.id === app.model.selectedId)) app.select(null);
        void actions.run(app.model.backend.removeAccount(view.account.id), app.model.prefs.privacy ? 'Subscription deleted' : `${view.account.label} deleted`).then(() => {
          // The row that had focus is gone. The next one shown takes it, or the Add button when none is left.
          if (document.activeElement && document.activeElement !== document.body) return;
          focusFirst([...pane.querySelectorAll<HTMLElement>('[data-nav="row"]'), header.querySelector<HTMLElement>('.btn.primary')]);
        });
      });
    },
    snooze: (accountId, untilMs) => {
      void actions.run(
        app.model.backend.updateAccount(accountId, { snoozedUntil: untilMs === null ? null : new Date(untilMs).toISOString() }),
        untilMs === null ? 'Snooze ended' : `Snoozed for ${formatDuration(untilMs - Date.now())}`
      );
    },
    connect: () => connectDialog(ctx),
    sources: () => sourcesDialog(ctx),
    reminders: () => remindersDialog(ctx, { on: () => app.model.prefs.notify, toggle: toggleNotifications }),
    shortcuts: () => shortcutsDialog(),
    addSpend: () => spendDialog(ctx, null),
    editSpend: (id) => {
      const source = app.model.state.spend.find((candidate) => candidate.id === id);
      if (source) spendDialog(ctx, source);
    },
    logSpend: (id) => {
      const source = app.model.state.spend.find((candidate) => candidate.id === id);
      if (source) logSpendDialog(ctx, source);
    },
    removeSpend: (id) => {
      const source = app.model.state.spend.find((candidate) => candidate.id === id);
      if (!source) return;
      void confirmDialog({ title: `Delete ${source.label}?`, message: `This removes ${source.label} and its ${source.entries.length} recorded day${source.entries.length === 1 ? '' : 's'} of spend.`, confirm: 'Delete' }).then((yes) => {
        if (yes) void actions.run(app.model.backend.removeSpend(id), `${source.label} deleted`);
      });
    },
    sample: (on) => {
      if (on) void app.use(new MemoryBackend());
      else if (httpBackend) void app.use(httpBackend).catch(() => toast('The local service is not reachable.', 'err'));
    },
    copyBrief: () => void copyText(briefMarkdown(app.model.state, app.model.now), 'Brief copied'),
    view: (id) => setView(id),
    run: async (work, done) => {
      try {
        await work;
        await app.reload();
        if (done) toast(done);
        return true;
      } catch (error) {
        toast((error as Error).message || 'That did not work.', 'err');
        return false;
      }
    }
  };
  const ctx: Ctx = { app, actions };

  // -- header (built once; only the tabs and counts are refreshed) -------------
  const tabs = h('nav', { class: 'tabs', 'aria-label': 'Views' });
  const filterInput = h('input', { id: 'filter', type: 'search', placeholder: 'Filter', 'aria-label': 'Filter subscriptions', autocomplete: 'off' }) as HTMLInputElement;
  filterInput.addEventListener('input', () => app.setFilter(filterInput.value));
  const moreButton = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Menu', title: 'Menu', onclick: () => showMenu(moreButton, mainMenu()) }, icon('more'));
  // On a phone the filter field is behind this button, on a row of its own, so the filter is never missing.
  const filterToggle = h('button', { class: 'icon-btn filter-toggle', type: 'button', 'aria-label': 'Filter', title: 'Filter (/)', 'aria-expanded': 'false', onclick: () => openFilter(!header.classList.contains('filter-open')) }, icon('search'));
  function openFilter(open: boolean): void {
    header.classList.toggle('filter-open', open);
    filterToggle.setAttribute('aria-expanded', String(open));
    if (open) {
      filterInput.focus();
      filterInput.select();
    } else if (filterInput.value !== '') {
      filterInput.value = '';
      app.setFilter('');
    }
  }
  // The header is sticky and wraps to two rows on a narrow screen. Its real height is what scrolling into
  // view, the inspector and the table header have to stay clear of.
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => document.documentElement.style.setProperty('--header-h', `${Math.round(header.getBoundingClientRect().height)}px`)).observe(header);
  }
  header.append(
    h('div', { class: 'brand' }, brandMark(), 'Tokengator'),
    tabs,
    h(
      'div',
      { class: 'bar-tools' },
      h('label', { class: 'filter' }, icon('search'), filterInput, h('kbd', { class: 'k' }, '/')),
      filterToggle,
      h('button', { class: 'btn', type: 'button', title: 'Update usage (U)', onclick: () => actions.quick() }, icon('edit'), h('span', { class: 'wide-only' }, 'Update'), h('kbd', null, 'U')),
      h('button', { class: 'btn', type: 'button', title: 'Copy a Markdown brief of what needs using (C)', onclick: () => actions.copyBrief() }, icon('copy'), h('span', { class: 'wide-only' }, 'Copy brief')),
      h('button', { class: 'btn primary', type: 'button', title: 'Add a subscription (A)', onclick: () => actions.add() }, icon('plus'), h('span', { class: 'wide-only' }, 'Add')),
      moreButton
    )
  );

  function mainMenu(): MenuEntry[] {
    const { prefs, demo } = app.model;
    return [
      { label: 'Connect agents…', icon: 'plug', onSelect: actions.connect },
      { label: 'Automatic sources…', icon: 'bolt', onSelect: actions.sources },
      { label: 'Reminders…', icon: 'bell', onSelect: actions.reminders },
      { kind: 'sep' },
      { kind: 'title', label: 'Theme' },
      { label: 'Match system', icon: 'sun', checked: prefs.theme === 'system', onSelect: () => app.setPrefs({ theme: 'system' }) },
      { label: 'Light', icon: 'sun', checked: prefs.theme === 'light', onSelect: () => app.setPrefs({ theme: 'light' }) },
      { label: 'Dark', icon: 'snooze', checked: prefs.theme === 'dark', onSelect: () => app.setPrefs({ theme: 'dark' }) },
      { kind: 'sep' },
      { label: 'Compact rows', icon: 'rows', check: true, checked: prefs.density === 'compact', onSelect: () => app.setPrefs({ density: prefs.density === 'compact' ? 'comfortable' : 'compact' }) },
      { label: 'Hide names (screen sharing)', icon: 'eye', check: true, checked: prefs.privacy, onSelect: () => app.setPrefs({ privacy: !prefs.privacy }) },
      { label: 'Single-key shortcuts', icon: 'keyboard', check: true, checked: prefs.shortcuts, onSelect: () => app.setPrefs({ shortcuts: !prefs.shortcuts }) },
      // What the two figures on every row show.
      { label: 'Show what is used, not what is left', icon: 'sort', check: true, checked: prefs.amounts === 'used', onSelect: () => app.setPrefs({ amounts: prefs.amounts === 'used' ? 'left' : 'used' }) },
      { label: 'Show reset times, not countdowns', icon: 'clock', check: true, checked: prefs.times === 'clock', onSelect: () => app.setPrefs({ times: prefs.times === 'clock' ? 'countdown' : 'clock' }) },
      { kind: 'sep' },
      { label: 'Copy everything as JSON', icon: 'copy', onSelect: () => void copyText(JSON.stringify(app.model.state, null, 2), 'State copied as JSON') },
      { label: 'Import from JSON…', icon: 'upload', onSelect: importState },
      demo && httpBackend
        ? { label: 'Back to my data', icon: 'sample', onSelect: () => actions.sample(false) }
        : { label: demo ? 'Reset sample data' : 'Try sample data', icon: 'sample', onSelect: () => actions.sample(true) },
      { kind: 'sep' },
      { label: 'Keyboard shortcuts', icon: 'keyboard', end: h('kbd', { class: 'k' }, '?'), onSelect: actions.shortcuts }
    ];
  }

  function importState(): void {
    const picker = h('input', { type: 'file', accept: 'application/json,.json' }) as HTMLInputElement;
    picker.addEventListener('change', () => {
      const file = picker.files?.[0];
      if (!file) return;
      void file.text().then(async (text) => {
        let document: unknown;
        try {
          document = JSON.parse(text);
        } catch {
          toast('That file is not valid JSON.', 'err');
          return;
        }
        const yes = await confirmDialog({
          title: 'Replace everything with this file?',
          message: `Importing ${file.name} replaces every subscription, spend source and history entry currently shown.`,
          confirm: 'Replace'
        });
        if (yes) void actions.run(app.model.backend.importState(document), 'Imported');
      });
    });
    picker.click();
  }

  async function toggleNotifications(): Promise<void> {
    if (app.model.prefs.notify) {
      app.setPrefs({ notify: false });
      return;
    }
    if (typeof Notification === 'undefined') {
      toast('This browser does not support notifications.', 'err');
      return;
    }
    // Permission is asked for only here, after an explicit choice.
    const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission().catch(() => 'denied');
    if (permission !== 'granted') {
      toast('Notifications are blocked for this page in the browser settings.', 'err');
      return;
    }
    app.setPrefs({ notify: true });
    toast('Notifications on');
  }

  // -- routing: the view lives in the address fragment ------------------------
  function viewFromHash(): ViewId | null {
    const id = location.hash.replace(/^#/, '');
    return VIEWS.some((view) => view.id === id) ? (id as ViewId) : null;
  }
  function setView(view: ViewId): void {
    if (viewFromHash() !== view) {
      try {
        history.replaceState(null, '', `#${view}`);
      } catch {
        location.hash = view;
      }
    }
    if (app.model.prefs.view !== view) app.setPrefs({ view });
    else render();
  }
  addEventListener('hashchange', () => {
    const view = viewFromHash();
    if (view && view !== app.model.prefs.view) app.setPrefs({ view });
  });
  const initial = viewFromHash();
  if (initial && initial !== app.model.prefs.view) app.model.prefs.view = initial;

  // -- render ------------------------------------------------------------------
  // "Match system" leaves the root element alone until the viewer has made an explicit choice, so a host
  // page that sets its own theme attribute keeps control.
  let lastTheme = 'system';
  /** True while the details pane covers the page instead of docking beside it. */
  const narrow = matchMedia('(max-width: 1039px)');

  // With seven tabs a phone cannot show them all. The current one is kept in view, and each edge fades
  // while a tab is cut off beyond it. Measured from the first and last tab rather than the scroll range,
  // which includes the strip's padding: scrolled to the end, the last tab is whole and must not fade.
  let tabsShown: ViewId | null = null;
  function tabEdges(): void {
    const strip = tabs.getBoundingClientRect();
    const first = tabs.firstElementChild?.getBoundingClientRect();
    const last = tabs.lastElementChild?.getBoundingClientRect();
    tabs.classList.toggle('more-right', last !== undefined && last.right > strip.right + 1);
    tabs.classList.toggle('more-left', first !== undefined && first.left < strip.left - 1);
  }
  tabs.addEventListener('scroll', tabEdges, { passive: true });
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(tabEdges).observe(tabs);

  function renderTabs(useNow: number): void {
    const current = app.model.prefs.view;
    mount(
      tabs,
      VIEWS.map((view) =>
        h(
          'button',
          { class: 'tab', type: 'button', 'aria-current': view.id === current ? 'page' : null, title: `${view.label} (${view.key})`, onclick: () => setView(view.id) },
          view.label,
          view.id === 'queue' && useNow > 0 ? h('span', { class: 'count', 'aria-label': `${useNow} to use now` }, useNow) : null
        )
      )
    );
    // Only when the view changes: the 30-second rebuild must not scroll a strip the viewer scrolled.
    if (tabsShown !== current) {
      tabsShown = current;
      tabs.querySelector<HTMLElement>('[aria-current="page"]')?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    }
    tabEdges();
  }

  function renderBanners(): void {
    const { demo, warnings, online, loaded } = app.model;
    const nodes: HTMLElement[] = [];
    if (demo) {
      nodes.push(
        h(
          'div',
          { class: 'banner', role: 'status' },
          h('strong', null, 'Sample data.'),
          fellBack && !httpBackend
            ? 'These figures are examples. Run the Tokengator service to track your own subscriptions; changes here are not saved.'
            : 'These figures are examples and changes here are not saved.',
          httpBackend ? h('button', { class: 'btn small', type: 'button', onclick: () => actions.sample(false) }, 'Back to my data') : null
        )
      );
    }
    if (!online && loaded && !demo) {
      nodes.push(h('div', { class: 'banner warn', role: 'status' }, h('strong', null, 'Offline.'), 'The local service is not answering. Showing the last data received; reconnecting automatically.'));
    }
    for (const warning of warnings) nodes.push(h('div', { class: 'banner warn', role: 'status' }, warning));
    mount(banners, nodes);
  }

  function renderSummary(): void {
    const { state, now, demo, online, lastSync } = app.model;
    const s = app.summary();
    const currency = state.settings.currency;
    if (state.accounts.length === 0) {
      mount(summary);
      summary.hidden = true;
      return;
    }
    summary.hidden = false;
    const next = s.nextReset;
    const line = summaryLine(s, currency);
    // Emphasise the money inside the sentence without restating it: the plan figure, or the credits when
    // credits are all that is at risk.
    const plan = formatMoneyTotals(s.useNow > 0 ? s.atRiskNow : s.atRisk, currency);
    const money = plan || formatMoneyTotals(s.useNow > 0 ? s.creditsAtRiskNow : s.creditsAtRisk, currency);
    const sentence = money && line.includes(money) ? [line.slice(0, line.indexOf(money)), h('span', { class: 'at-risk num' }, money), line.slice(line.indexOf(money) + money.length)] : [line];
    const credits = (amounts: Money): HTMLElement | null => {
      const text = formatMoneyTotals(amounts, currency);
      // Starts with a space, so the figure before it and this one are read and copied as two.
      return text ? h('small', { title: CREDIT_VALUE_NOTE }, ` + ${text} in credits`) : null;
    };
    // Money that expired is worded as the Finished windows tile, the brief, the command line and the MCP
    // server word it: "about" a whole amount where windows were estimated, plan money and credits never
    // added. The plan figure leads; the credits follow, quieter.
    const lost = lostText(s.lost30, s.creditsLost30, currency, s.lostIsEstimate, s.creditsLostIsEstimate);
    const split = lost.indexOf(', plus ');
    const lostLead = split >= 0 ? lost.slice(0, split) : lost;
    const lostCredits = split >= 0 ? lost.slice(split) : '';
    const onlyCredits = lostCredits === '' && lost.endsWith(' in credits');
    // On the Overview a figure that a tile states is not repeated here; hiding the tile brings it back.
    const overview = app.model.prefs.view === 'overview';
    const inTiles = overview ? figuresInTiles(app.model.prefs.overviewHidden, app) : { atRisk: false, lost: false, stale: false };
    const liveClass = demo ? 'live sample' : online ? 'live' : 'live off';
    const liveText = demo ? 'Sample data' : online ? `Live${lastSync ? `, synced ${formatAge(now - lastSync)}` : ''}` : 'Offline';
    mount(
      summary,
      h(
        'div',
        { class: 'summary-main' },
        h('h1', { class: 'summary-line' }, sentence),
        h(
          'p',
          { class: 'summary-sub' },
          h('span', { class: liveClass }, h('i'), liveText),
          next && next.resetsAtMs !== null
            ? h(
                'span',
                null,
                'Next reset: ',
                h('span', { class: 'private' }, next.account.label),
                `, ${next.meter.label.toLowerCase()} in `,
                h('span', { class: 'num', dataset: { until: next.resetsAtMs, mode: 'countdown' } }, formatDuration(next.msLeft ?? 0)),
                ` (${leftText(next)}).`
              )
            : null,
          s.stale > 0 && !inTiles.stale ? h('span', null, `${s.stale} reading${s.stale === 1 ? ' is' : 's are'} stale.`) : null
        )
      ),
      h(
        'dl',
        { class: 'stats' },
        // The money at risk now is in the sentence; on the Overview the lead tile gives it per quota.
        overview
          ? null
          : h(
              'div',
              { class: 'stat risk' },
              h('dt', { class: 'label' }, 'At risk now'),
              h('dd', { title: PLAN_VALUE_NOTE }, formatMoneyTotals(s.atRiskNow, currency, formatMoney(0, currency)), credits(s.creditsAtRiskNow))
            ),
        inTiles.atRisk
          ? null
          : h(
              'div',
              { class: 'stat' },
              h('dt', { class: 'label' }, 'At risk, all windows'),
              h('dd', { title: PLAN_VALUE_NOTE }, formatMoneyTotals(s.atRisk, currency, formatMoney(0, currency)), credits(s.creditsAtRisk))
            ),
        inTiles.lost
          ? null
          : h(
              'div',
              { class: 'stat' },
              h('dt', { class: 'label' }, FIGURE_LABEL.lost30),
              h(
                'dd',
                { title: onlyCredits ? CREDIT_VALUE_NOTE : PLAN_VALUE_NOTE },
                lostLead,
                lostCredits ? h('small', { title: CREDIT_VALUE_NOTE }, lostCredits) : null,
                // The space is text, so the two figures are read and copied as two.
                s.utilisation30 !== null ? [' ', h('small', null, `${formatPercent(s.utilisation30)} used`)] : null
              )
            )
      )
    );
  }

  function renderToolbar(queue: MeterView[]): void {
    const { prefs, state } = app.model;
    const view = prefs.view;
    const meterView = view === 'overview' || view === 'queue' || view === 'board' || view === 'timeline' || view === 'table';
    toolbar.hidden = !meterView || state.accounts.length === 0;
    if (toolbar.hidden) return;
    const categories = app.categoriesInUse();
    const sortButton = h(
      'button',
      {
        class: 'select-btn',
        // Its text changes with the order chosen, so it is found again by id after a redraw.
        id: 'sort-button',
        type: 'button',
        onclick: () =>
          showMenu(
            sortButton,
            SORT_ORDERS.map((order) => ({ label: order.label, checked: order.id === prefs.sort, onSelect: () => app.setPrefs({ sort: order.id }) }))
          )
      },
      icon('sort'),
      h('span', null, 'Sort'),
      SORT_ORDERS.find((order) => order.id === prefs.sort)?.label ?? '',
      icon('chevron')
    );
    // On the Overview every tile has its own order, which carries its meaning, so there is no Sort; the
    // Tiles menu takes its place.
    const hidden = prefs.overviewHidden;
    const tilesButton = h(
      'button',
      {
        class: 'select-btn',
        id: 'tiles-button',
        type: 'button',
        onclick: () =>
          showMenu(
            tilesButton,
            OVERVIEW_TILES.filter((entry) => entry.hideable).map((entry) => ({
              label: entry.title,
              check: true,
              checked: !hidden.includes(entry.id),
              onSelect: () => app.setPrefs({ overviewHidden: hidden.includes(entry.id) ? hidden.filter((id) => id !== entry.id) : [...hidden, entry.id] })
            }))
          )
      },
      icon('rows'),
      h('span', null, 'Tiles'),
      hidden.length > 0 ? `${hidden.length} hidden` : 'All shown',
      icon('chevron')
    );
    mount(
      toolbar,
      view === 'overview' ? tilesButton : sortButton,
      categories.length > 1
        ? h(
            'div',
            { class: 'chips', role: 'group', 'aria-label': 'Category' },
            (['all', ...categories] as (ProviderCategory | 'all')[]).map((id) =>
              h('button', { class: 'chip-btn', type: 'button', 'aria-pressed': String(prefs.category === id), onclick: () => app.setPrefs({ category: id }) }, id === 'all' ? 'All' : CATEGORY_LABEL[id])
            )
          )
        : null,
      h('label', { class: 'check' }, h('input', { type: 'checkbox', id: 'hide-spent', checked: prefs.hideSpent, onchange: (event: Event) => app.setPrefs({ hideSpent: (event.target as HTMLInputElement).checked }) }), 'Hide used up'),
      view === 'timeline'
        ? h(
            'div',
            { class: 'seg', role: 'group', 'aria-label': 'Horizon' },
            ([24, 168, 720] as const).map((hours) =>
              h('button', { type: 'button', 'aria-pressed': String(prefs.horizon === hours), onclick: () => app.setPrefs({ horizon: hours }) }, hours === 24 ? '24 hours' : hours === 168 ? '7 days' : '30 days')
            )
          )
        : null,
      h('span', { class: 'spacer' }),
      view === 'table' ? tableTools(ctx, queue) : null,
      view === 'overview' || view === 'queue' || view === 'board' || view === 'table' || view === 'timeline' ? barLegend(view === 'timeline') : null
    );
  }

  function emptyState(): HTMLElement {
    const detected = app.model.collectors.filter((collector) => collector.available && !collector.enabled);
    return h(
      'div',
      { class: 'empty' },
      h('h2', null, 'Nothing is tracked yet'),
      h(
        'p',
        null,
        'Add the AI subscriptions you pay for. Tokengator then tells you which quota is about to reset with something still left in it, what that is worth, and what to use first.'
      ),
      detected.length > 0
        ? h('p', null, `Found on this machine: ${detected.map((collector) => collector.title).join(', ')}. Switch them on under Automatic sources and those meters fill themselves.`)
        : null,
      h(
        'div',
        { class: 'actions' },
        h('button', { class: 'btn primary', type: 'button', onclick: () => actions.add() }, icon('plus'), 'Add a subscription'),
        detected.length > 0 ? h('button', { class: 'btn', type: 'button', onclick: () => actions.sources() }, icon('bolt'), 'Automatic sources') : null,
        h('button', { class: 'btn', type: 'button', onclick: () => actions.sample(true) }, icon('sample'), 'Try sample data'),
        h('button', { class: 'btn quiet', type: 'button', onclick: () => actions.connect() }, icon('plug'), 'Connect agents')
      )
    );
  }

  function render(): void {
    const { prefs, state, loaded } = app.model;
    if (!loaded) return;
    // A tooltip belongs to a mark this rebuild is about to replace.
    hideTip();

    const theme = prefs.theme;
    if (theme !== lastTheme) {
      if (theme === 'system') document.documentElement.removeAttribute('data-theme');
      else document.documentElement.setAttribute('data-theme', theme);
      lastTheme = theme;
    }
    document.documentElement.setAttribute('data-density', prefs.density);
    root.classList.toggle('privacy', prefs.privacy);

    const s = app.summary();
    const queue = app.queue();
    const viewChanged = viewShown !== null && viewShown !== prefs.view;
    viewShown = prefs.view;
    // What a rebuild would otherwise throw away: where the keyboard is, and how far two panes are scrolled.
    const focusMark = markFocus(root, DIALOG_SCOPES);
    const shownBefore = layout.querySelector<HTMLElement>('.insp')?.dataset['meter'] ?? null;
    const inspScroll = layout.querySelector<HTMLElement>('.insp')?.scrollTop ?? 0;
    const tableScroll = pane.querySelector<HTMLElement>('.table-wrap')?.scrollLeft ?? 0;
    renderTabs(s.useNow);
    renderBanners();
    renderSummary();
    renderToolbar(queue);
    document.title = s.useNow > 0 ? `(${s.useNow}) Tokengator` : 'Tokengator';

    const scrollY = window.scrollY;

    const view = prefs.view;
    let content: HTMLElement;
    if (view === 'costs') content = costsView(ctx);
    else if (view === 'history') content = historyView(ctx);
    else if (state.accounts.length === 0) content = emptyState();
    else if (view === 'overview' ? app.filtered().length === 0 && app.cycles().length === 0 : view === 'board' ? app.filtered().length === 0 : queue.length === 0) {
      content = h('div', { class: 'empty' }, h('h2', null, 'Nothing matches'), h('p', null, 'No quota matches the current filter. Clear the filter or the category to see everything.'));
    } else if (view === 'overview') content = overviewView(ctx);
    else if (view === 'board') content = boardView(ctx, queue, app.filtered());
    else if (view === 'timeline') content = timelineView(ctx, queue);
    else if (view === 'table') content = tableView(ctx, queue);
    else content = queueView(ctx, queue);
    mount(pane, content);

    // Inspector
    for (const old of layout.querySelectorAll('.insp, .scrim')) old.remove();
    const selected = view === 'costs' || view === 'history' ? null : app.selected();
    layout.classList.toggle('with-inspector', selected !== null);
    if (selected) {
      // The scrim is for the pointer. The pane has its own Close button for everything else.
      layout.append(h('button', { class: 'scrim', type: 'button', tabindex: -1, 'aria-hidden': 'true', onclick: () => app.select(null) }), inspector(ctx, selected));
    }
    // Below the width at which the pane docks, it covers the page. Then it is a dialog: what is behind it
    // cannot take focus or be operated, and focus starts inside it.
    const overlay = selected !== null && narrow.matches;
    for (const region of [header, banners, summary, toolbar, pane]) region.inert = overlay;

    // The Overview's charts are drawn now that the inspector has taken its share of the width.
    if (view === 'overview') drawOverviewCharts(pane, true);
    if (shownBefore === null && selected !== null) openedFrom = focusMark;

    const insp = layout.querySelector<HTMLElement>('.insp');
    if (insp && overlay) {
      insp.setAttribute('role', 'dialog');
      insp.setAttribute('aria-modal', 'true');
    }
    if (insp && insp.dataset['meter'] === shownBefore && inspScroll > 0) insp.scrollTop = inspScroll;
    const table = pane.querySelector<HTMLElement>('.table-wrap');
    if (table && tableScroll > 0) table.scrollLeft = tableScroll;
    // When the pane closes, focus goes back to the row it was showing, whichever of its controls had it.
    // Looking for "the same control elsewhere" would pick some other row's button.
    const paneClosed = insp === null && shownBefore !== null && (focusMark === null || focusMark.scope === '.insp');
    // The quota's rows, of which the first shown takes focus: a chart and the table standing in for it both
    // have one, and only one of the two is drawn.
    const rows = shownBefore ? [...pane.querySelectorAll<HTMLElement>(`[data-nav="row"][data-id="${CSS.escape(shownBefore)}"]`)] : [];
    // Back to the control that opened the pane (a mark on a chart, a row in a tile), if it was opened for
    // the quota it is closing on; otherwise to that quota's first row.
    const opener = paneClosed && openedFrom?.within === shownBefore ? openedFrom : null;
    if (paneClosed) openedFrom = null;
    const restored =
      (paneClosed && opener !== null && restoreFocus(root, opener)) ||
      (paneClosed && focusFirst(rows)) ||
      restoreFocus(root, focusMark) ||
      (focusMark?.scope === '.insp' && focusFirst(rows));
    if (insp && overlay && !insp.contains(document.activeElement)) insp.querySelector<HTMLElement>('.insp-close')?.focus({ preventScroll: true });
    if (window.scrollY !== scrollY) window.scrollTo({ top: scrollY });
    // Focus that was in the page and has nowhere to go back to: its control went with the view it was in
    // (a tile's "5 more in the Queue" opens the Queue). It goes to the new view's first row, or to the tab
    // of the view shown, rather than to nothing, from where the next Tab would start at the top.
    if (!restored && focusMark !== null && !overlay) {
      const first = viewChanged ? [...pane.querySelectorAll<HTMLElement>('[data-nav="row"]')].find(isShown) : undefined;
      if (first && focusFirst([first])) first.scrollIntoView({ block: 'nearest' });
      else focusFirst([tabs.querySelector<HTMLElement>('[aria-current="page"]')]);
    }
    notify();
  }

  /** What had focus when the inspector opened, so closing it can return there. */
  let openedFrom: FocusMark | null = null;
  /** The view the last rebuild drew, to tell a switch of view from a redraw of the same one. */
  let viewShown: ViewId | null = null;
  // A tile's width changes without a rebuild (the window is resized, a scrollbar comes or goes); only the
  // charts are drawn again.
  if (typeof ResizeObserver !== 'undefined') {
    let queued = false;
    new ResizeObserver(() => {
      if (queued || app.model.prefs.view !== 'overview') return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        drawOverviewCharts(pane);
      });
    }).observe(pane);
  }

  // The pane docks or covers depending on the width, so crossing that width redraws it.
  narrow.addEventListener('change', () => render());

  // Rebuilding while the viewer is typing in the inspector would drop what they typed.
  function isEditingInPlace(): boolean {
    const active = document.activeElement as HTMLElement | null;
    return active !== null && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA') && layout.contains(active) && (active as HTMLInputElement).value !== '';
  }

  let pending = false;
  app.onChange(() => {
    if (isEditingInPlace() || isMenuOpen()) {
      pending = true;
      return;
    }
    render();
  });
  // What was held back is drawn as soon as the reason is gone: the field was left, or the menu closed.
  const flush = (): void => {
    if (!pending) return;
    setTimeout(() => {
      if (!pending || isEditingInPlace() || isMenuOpen()) return;
      pending = false;
      render();
    }, 0);
  };
  layout.addEventListener('focusout', flush);
  onMenuClosed(flush);

  // -- notifications -----------------------------------------------------------
  function notify(): void {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    const reminder = app.tabReminder();
    if (!reminder) return;
    try {
      new Notification(reminder.title, { body: reminder.body, tag: reminder.tag });
    } catch {
      // some platforms only allow notifications from a service worker; the title badge still shows
    }
    app.setPrefs({ notified: rememberReminders(app.model.prefs.notified, reminder.keys, app.model.now) });
  }

  // -- ticker ------------------------------------------------------------------
  let lastFull = Date.now();
  setInterval(() => {
    const now = Date.now();
    refreshCountdowns(document, now);
    // A full rebuild twice a minute keeps bars, tiers and "synced" honest without flicker.
    if (now - lastFull >= 30_000 && !isDialogOpen() && !isMenuOpen() && !isEditingInPlace()) {
      lastFull = now;
      app.tick();
    }
  }, 1000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      lastFull = Date.now();
      void app.reload();
    }
  });

  // -- keyboard ----------------------------------------------------------------
  function moveSelection(delta: number): void {
    // A quota can appear in several places (the Overview's tiles); J and K visit it once, where it is first
    // shown. Only what is drawn counts: a chart's table is in the page while the chart is shown, and a quota
    // first met there would otherwise be skipped everywhere. From a later place (a mark on a chart), the
    // next quota is the one after it in that same order.
    const seen = new Set<string>();
    const rows = [...pane.querySelectorAll<HTMLElement>('[data-nav="row"]')].filter(isShown).filter((row) => {
      const id = row.dataset['id'] ?? '';
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    if (rows.length === 0) return;
    const active = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('[data-nav="row"]');
    const activeId = active?.dataset['id'];
    const index = activeId ? rows.findIndex((row) => row.dataset['id'] === activeId) : rows.findIndex((row) => row.dataset['id'] === app.model.selectedId);
    const next = rows[Math.min(rows.length - 1, Math.max(0, index + delta))] ?? rows[0];
    next?.focus();
    next?.scrollIntoView({ block: 'nearest' });
    if (app.model.selectedId !== null && next?.dataset['id']) app.select(next.dataset['id']);
  }

  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target as HTMLElement | null;
    const typing = target !== null && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable);
    if (event.key === 'Escape') {
      if (isDialogOpen() || isMenuOpen()) return; // they handle Escape themselves
      // A tooltip goes first: it can cover the marks around it, and Escape puts it away without moving the
      // pointer or focus. A second Escape does what Escape otherwise does.
      if (dismissTip()) return;
      if (typing && target === filterInput) {
        filterInput.value = '';
        app.setFilter('');
        // On a phone the field goes away again, and focus returns to the button that opened it.
        if (header.classList.contains('filter-open')) {
          openFilter(false);
          filterToggle.focus();
        } else filterInput.blur();
      } else if (typing && target !== null && layout.querySelector('.insp')?.contains(target)) {
        // Esc in the details pane closes the pane, from a field as from anywhere else in it. Blurring the
        // field instead would drop focus on nothing, and the next Tab would leave the page.
        if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) target.value = '';
        app.select(null);
      } else if (typing) target?.blur();
      else if (app.model.selectedId) app.select(null);
      return;
    }
    // An open menu owns the keyboard: a shortcut pressed over it would change a view that cannot be redrawn.
    if (typing || isDialogOpen() || isMenuOpen()) return;
    // Arrow keys move through the rows whatever the setting. Every other shortcut is a single character,
    // which someone who dictates or uses voice control needs to be able to switch off.
    if (!app.model.prefs.shortcuts && event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const view = VIEWS.find((candidate) => candidate.key === event.key);
    if (view) {
      event.preventDefault();
      setView(view.id);
      return;
    }
    switch (event.key) {
      case '/':
        event.preventDefault();
        // Where the field is behind its button, the key opens it.
        if (getComputedStyle(filterToggle).display !== 'none') openFilter(true);
        else {
          filterInput.focus();
          filterInput.select();
        }
        break;
      case 'u':
      case 'U': {
        event.preventDefault();
        const selected = app.selected();
        actions.quick(selected ? `${selected.meter.id} ` : '');
        break;
      }
      case 'a':
      case 'A':
        event.preventDefault();
        actions.add();
        break;
      case 'c':
      case 'C':
        event.preventDefault();
        actions.copyBrief();
        break;
      case 'j':
      case 'ArrowDown':
        event.preventDefault();
        moveSelection(1);
        break;
      case 'k':
      case 'ArrowUp':
        event.preventDefault();
        moveSelection(-1);
        break;
      case 's':
      case 'S': {
        event.preventDefault();
        const index = SORT_ORDERS.findIndex((order) => order.id === app.model.prefs.sort);
        const next = SORT_ORDERS[(index + 1) % SORT_ORDERS.length];
        if (next) {
          app.setPrefs({ sort: next.id as SortOrder });
          toast(`Sorted by: ${next.label.toLowerCase()}`);
        }
        break;
      }
      case 't':
      case 'T': {
        event.preventDefault();
        const order = ['system', 'light', 'dark'] as const;
        const next = order[(order.indexOf(app.model.prefs.theme) + 1) % order.length] ?? 'system';
        app.setPrefs({ theme: next });
        toast(`Theme: ${next === 'system' ? 'match system' : next}`);
        break;
      }
      case '?':
        event.preventDefault();
        closeMenu();
        actions.shortcuts();
        break;
      default:
        break;
    }
  });

  render();
}

// ---------------------------------------------------------------------------

async function boot(): Promise<void> {
  try {
    const { backend, fellBack } = await chooseBackend();
    const app = new App(backend);
    await app.use(backend);
    start(app, fellBack);
  } catch (error) {
    const unauthorized = (error as { code?: string }).code === 'unauthorized';
    mount(
      root,
      h(
        'div',
        { class: 'empty' },
        h('h2', null, unauthorized ? 'This dashboard needs its access token' : 'The dashboard could not start'),
        h(
          'p',
          null,
          unauthorized
            ? 'Open it once with the token after a # in the address, for example http://127.0.0.1:4777/#token=YOUR_TOKEN. The token is exchanged for a session cookie and removed from the address.'
            : (error as Error).message
        )
      )
    );
  }
}

void boot();
