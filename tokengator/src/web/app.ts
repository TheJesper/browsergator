// Application state for the dashboard: what was loaded, what the viewer prefers, what is selected, and the
// one ordered and filtered list of meters that every view is a projection of.

import { CATALOG } from '../core/catalog.js';
import { categoryFor, type ProviderCategory } from '../core/catalog-types.js';
import { compareViews, summarise, viewState, type MeterView, type SortOrder, type Summary } from '../core/forecast.js';
import { digestReminders, dueReminders } from '../core/reminders.js';
import { rollState } from '../core/reset.js';
import { emptyState, type State } from '../core/types.js';
import { REMINDERS_OFF, type Backend, type CollectorInfo, type Loaded, type ReminderInfo } from './backend.js';

export type ViewId = 'queue' | 'board' | 'timeline' | 'table' | 'costs' | 'history';

export const VIEWS: readonly { id: ViewId; label: string; key: string }[] = [
  { id: 'queue', label: 'Queue', key: '1' },
  { id: 'board', label: 'Board', key: '2' },
  { id: 'timeline', label: 'Timeline', key: '3' },
  { id: 'table', label: 'Table', key: '4' },
  { id: 'costs', label: 'Costs', key: '5' },
  { id: 'history', label: 'History', key: '6' }
];

export interface Prefs {
  view: ViewId;
  sort: SortOrder;
  category: ProviderCategory | 'all';
  hideSpent: boolean;
  theme: 'system' | 'light' | 'dark';
  density: 'comfortable' | 'compact';
  /** Show amounts as what is left or what is used. */
  amounts: 'left' | 'used';
  /** Show resets as a countdown or a clock time. */
  times: 'countdown' | 'clock';
  privacy: boolean;
  horizon: 24 | 168 | 720;
  notify: boolean;
  /** Meter windows already announced, so a notification fires once per window. */
  notified: string[];
}

const DEFAULT_PREFS: Prefs = {
  view: 'queue',
  sort: 'use-first',
  category: 'all',
  hideSpent: false,
  theme: 'system',
  density: 'comfortable',
  amounts: 'left',
  times: 'countdown',
  privacy: false,
  horizon: 168,
  notify: false,
  notified: []
};

const PREFS_KEY = 'tokengator.prefs.v1';

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    const parsed = JSON.parse(raw) as Partial<Prefs>;
    const prefs = { ...DEFAULT_PREFS, ...parsed };
    if (!VIEWS.some((view) => view.id === prefs.view)) prefs.view = 'queue';
    if (![24, 168, 720].includes(prefs.horizon)) prefs.horizon = 168;
    if (!Array.isArray(prefs.notified)) prefs.notified = [];
    return prefs;
  } catch {
    // Storage can be blocked (private windows, embedded previews); the dashboard works without it.
    return { ...DEFAULT_PREFS };
  }
}

function savePrefs(prefs: Prefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // see loadPrefs
  }
}

export interface AppModel {
  backend: Backend;
  loaded: boolean;
  online: boolean;
  error: string | null;
  state: State;
  collectors: CollectorInfo[];
  reminders: ReminderInfo;
  warnings: string[];
  demo: boolean;
  meta: Pick<Loaded, 'cli' | 'origin' | 'tokenRequired' | 'version'>;
  prefs: Prefs;
  filterText: string;
  selectedId: string | null;
  now: number;
  lastSync: number | null;
}

type Listener = () => void;

export class App {
  model: AppModel;
  private readonly listeners = new Set<Listener>();
  private unsubscribe: (() => void) | null = null;
  private loading: Promise<void> | null = null;
  private again = false;

  constructor(backend: Backend) {
    this.model = {
      backend,
      loaded: false,
      online: true,
      error: null,
      state: emptyState(),
      collectors: [],
      reminders: REMINDERS_OFF,
      warnings: [],
      demo: backend.kind === 'memory',
      meta: { cli: 'tokengator', origin: '', tokenRequired: false, version: '' },
      prefs: loadPrefs(),
      filterText: '',
      selectedId: null,
      now: Date.now(),
      lastSync: null
    };
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }

  /** Switches data source (the local service, or sample data) and reloads. */
  async use(backend: Backend): Promise<void> {
    this.unsubscribe?.();
    this.model.backend = backend;
    this.model.selectedId = null;
    this.unsubscribe = backend.subscribe(
      () => void this.reload(),
      (online) => {
        if (this.model.online === online) return;
        this.model.online = online;
        this.emit();
        if (online) void this.reload();
      }
    );
    await this.reload();
  }

  /** Fetches the state. Calls that arrive while one is running are coalesced into a single follow-up. */
  reload(): Promise<void> {
    if (this.loading) {
      this.again = true;
      return this.loading;
    }
    this.loading = this.fetchOnce().finally(() => {
      this.loading = null;
      if (this.again) {
        this.again = false;
        void this.reload();
      }
    });
    return this.loading;
  }

  private async fetchOnce(): Promise<void> {
    try {
      const loaded = await this.model.backend.load();
      this.model.state = loaded.state;
      this.model.collectors = loaded.collectors;
      this.model.reminders = loaded.reminders;
      this.model.warnings = loaded.warnings;
      this.model.demo = loaded.demo || this.model.backend.kind === 'memory';
      this.model.meta = { cli: loaded.cli, origin: loaded.origin, tokenRequired: loaded.tokenRequired, version: loaded.version };
      this.model.loaded = true;
      this.model.error = null;
      this.model.online = true;
      this.model.lastSync = Date.now();
      // A category nothing belongs to any more would hide every quota, with no chip left to clear it.
      const { category } = this.model.prefs;
      if (category !== 'all' && !this.categoriesInUse().includes(category)) {
        this.model.prefs = { ...this.model.prefs, category: 'all' };
        savePrefs(this.model.prefs);
      }
    } catch (error) {
      this.model.error = (error as Error).message;
      if (!this.model.loaded) throw error;
      this.model.online = false;
    }
    this.tick(false);
    this.emit();
  }

  /** Advances the clock and rolls windows locally so a reset shows up the second it happens. */
  tick(emit = true): void {
    this.model.now = Date.now();
    this.model.state = rollState(this.model.state, this.model.now);
    if (emit) this.emit();
  }

  setPrefs(patch: Partial<Prefs>): void {
    this.model.prefs = { ...this.model.prefs, ...patch };
    savePrefs(this.model.prefs);
    this.emit();
  }

  setFilter(text: string): void {
    this.model.filterText = text;
    this.emit();
  }

  select(id: string | null): void {
    if (this.model.selectedId === id) return;
    this.model.selectedId = id;
    this.emit();
  }

  // -- derived -------------------------------------------------------------

  allViews(): MeterView[] {
    return viewState(this.model.state, this.model.now);
  }

  summary(): Summary {
    return summarise(this.model.state, this.model.now);
  }

  private matches(view: MeterView): boolean {
    const { prefs, filterText } = this.model;
    if (prefs.category !== 'all' && categoryFor(CATALOG, view.account.providerId) !== prefs.category) return false;
    if (prefs.hideSpent && (view.tier === 'spent' || view.tier === 'expired')) return false;
    const needle = filterText.trim().toLowerCase();
    if (!needle) return true;
    const haystack = [view.account.label, view.account.providerId, view.account.plan ?? '', view.meter.label, view.meter.key]
      .join(' ')
      .toLowerCase();
    return needle.split(/\s+/).every((word) => haystack.includes(word));
  }

  /** Allowance meters after filters, in the chosen order. Queue, Timeline and Table are built from this. */
  queue(): MeterView[] {
    return this.allViews()
      .filter((view) => view.tier !== null && this.matches(view))
      .sort(compareViews(this.model.prefs.sort));
  }

  /** Every meter after filters (allowances and throttles), for the Board and the inspector. */
  filtered(): MeterView[] {
    return this.allViews().filter((view) => this.matches(view));
  }

  selected(): MeterView | null {
    const id = this.model.selectedId;
    if (!id) return null;
    return this.allViews().find((view) => view.id === id) ?? null;
  }

  /**
   * The one browser notification to raise now, or null. Several quotas due together make one message, as
   * on every other route. Sample data never raises one: its quotas are invented.
   */
  tabReminder(): { title: string; body: string; tag: string; keys: string[] } | null {
    const { prefs, now, state, reminders, demo } = this.model;
    if (!prefs.notify || demo) return null;
    // The service raises the same reminders on this computer when that is switched on. One is enough.
    if (reminders.desktop.enabled) return null;
    const due = dueReminders(state, now, prefs.notified);
    const digest = digestReminders(due);
    const first = due[0];
    if (!digest || !first) return null;
    return { ...digest, tag: first.key, keys: due.map((reminder) => reminder.key) };
  }

  categoriesInUse(): ProviderCategory[] {
    const seen = new Set<ProviderCategory>();
    for (const account of this.model.state.accounts) seen.add(categoryFor(CATALOG, account.providerId));
    return [...seen];
  }
}
