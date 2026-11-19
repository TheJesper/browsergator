// What views need from the shell: the app state and the actions that open dialogs or change data.

import type { MeterView } from '../core/forecast.js';
import type { App } from './app.js';

export interface Actions {
  /** Opens quick entry, optionally prefilled (for example with a meter's name). */
  quick(prefill?: string): void;
  add(): void;
  edit(accountId: string): void;
  removeAccount(view: MeterView): void;
  snooze(accountId: string, untilMs: number | null): void;
  connect(): void;
  sources(): void;
  reminders(): void;
  shortcuts(): void;
  addSpend(): void;
  editSpend(sourceId: string): void;
  logSpend(sourceId: string): void;
  removeSpend(sourceId: string): void;
  /** Switches between the local service and sample data. */
  sample(on: boolean): void;
  copyBrief(): void;
  /** Awaits a change, reloads, and reports failure as a toast. Resolves true on success. */
  run(work: Promise<unknown>, done?: string): Promise<boolean>;
}

export interface Ctx {
  app: App;
  actions: Actions;
}
