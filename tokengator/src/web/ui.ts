// Shared interface pieces: toasts, popover menus, dialogs, tooltips and copy-to-clipboard.

import { h, icon, type Child } from './dom.js';

// ---------------------------------------------------------------------------
// Focus across rebuilds
// ---------------------------------------------------------------------------
// The page is redrawn from its model, which replaces the element that had focus with an identical new one.
// A mark records enough about a control to find that replacement, so the keyboard stays where it was.

export interface FocusMark {
  id: string;
  tag: string;
  label: string;
  /** Selector of the region the control was in (tabs, toolbar, list, inspector), or '' for anywhere. */
  scope: string;
  /** The meter the control belonged to, when it sat inside a row or a card. */
  within: string | null;
  /** Which of several identical controls it was. */
  nth: number;
  /** Its place among all controls of its kind in that region, for a control whose own text changes. */
  order: number;
}

const controlLabel = (el: Element): string => el.getAttribute('aria-label') ?? el.getAttribute('title') ?? (el.textContent ?? '').trim();
const meterOf = (el: Element): string | null => el.closest<HTMLElement>('[data-id]')?.dataset['id'] ?? null;

function lookalikes(root: HTMLElement, mark: Pick<FocusMark, 'tag' | 'label' | 'scope'>, within: string | null | undefined): HTMLElement[] {
  const base = mark.scope ? root.querySelector<HTMLElement>(mark.scope) : root;
  if (!base) return [];
  return [...base.querySelectorAll<HTMLElement>(mark.tag)].filter((el) => controlLabel(el) === mark.label && (within === undefined || meterOf(el) === within));
}

/** Notes which control inside `root` has focus. `scopes` are the selectors of the regions that get rebuilt. */
export function markFocus(root: HTMLElement, scopes: readonly string[]): FocusMark | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || active === document.body || !root.contains(active)) return null;
  const mark = { id: active.id, tag: active.tagName, label: controlLabel(active), scope: scopes.find((selector) => active.closest(selector) !== null) ?? '', within: meterOf(active) };
  const region = mark.scope ? root.querySelector<HTMLElement>(mark.scope) : root;
  const order = region ? [...region.querySelectorAll<HTMLElement>(mark.tag)].indexOf(active) : -1;
  return { ...mark, nth: Math.max(0, lookalikes(root, mark, mark.within).indexOf(active)), order };
}

/**
 * Puts focus back on the control a mark describes, if the rebuild dropped it. True when focus is on a
 * control. `byPlace` also accepts the control now standing where the marked one stood: right for a panel
 * that is redrawn with the same controls in the same order, where a switch changes its own wording.
 */
export function restoreFocus(root: HTMLElement, mark: FocusMark | null, byPlace = false): boolean {
  const current = document.activeElement;
  if (current instanceof HTMLElement && current !== document.body && current.isConnected) return true;
  if (!mark) return false;
  const exact = lookalikes(root, mark, mark.within);
  const target =
    (mark.id ? root.querySelector<HTMLElement>(`#${CSS.escape(mark.id)}`) : null) ??
    exact[mark.nth] ??
    exact[0] ??
    // The same control for another meter: the inspector's buttons after the selection moved.
    lookalikes(root, mark, undefined)[0] ??
    // Or the row the control belonged to.
    (mark.within ? root.querySelector<HTMLElement>(`[data-nav="row"][data-id="${CSS.escape(mark.within)}"]`) : null) ??
    (byPlace && mark.order >= 0 ? ((mark.scope ? root.querySelector<HTMLElement>(mark.scope) : root)?.querySelectorAll<HTMLElement>(mark.tag)[mark.order] ?? null) : null);
  target?.focus({ preventScroll: true });
  return target !== null && target !== undefined;
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

let toastHost: HTMLElement | null = null;

/**
 * Where messages are announced from. A modal dialog makes everything outside it inert and draws it under the
 * backdrop, so while one is open the region lives inside it: a message raised from a dialog would otherwise
 * be neither read out nor readable.
 */
function toastRegion(): HTMLElement {
  if (!toastHost) toastHost = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
  const dialogs = document.querySelectorAll<HTMLElement>('dialog[open]');
  const home = dialogs[dialogs.length - 1] ?? document.body;
  if (toastHost.parentElement !== home) home.appendChild(toastHost);
  return toastHost;
}

export function toast(message: string, kind: 'ok' | 'err' = 'ok'): void {
  // An error interrupts and stays long enough to be read; a click dismisses it.
  const el = h('div', { class: kind === 'err' ? 'toast err' : 'toast', role: kind === 'err' ? 'alert' : null }, kind === 'ok' ? icon('check') : null, message);
  if (kind === 'err') el.addEventListener('click', () => el.remove());
  toastRegion().appendChild(el);
  setTimeout(() => el.remove(), kind === 'err' ? 9000 : 2200);
}

// ---------------------------------------------------------------------------
// Popover menus
// ---------------------------------------------------------------------------

export type MenuEntry =
  /** `check` makes a checked item a checkbox (each on or off) rather than one choice among several. */
  | { kind?: 'item'; label: string; icon?: string; end?: Child; checked?: boolean; check?: boolean; danger?: boolean; onSelect: () => void }
  | { kind: 'sep' }
  | { kind: 'title'; label: string };

let openMenu: { el: HTMLElement; anchor: HTMLElement; close: () => void } | null = null;

export function closeMenu(): void {
  openMenu?.close();
}

export function isMenuOpen(): boolean {
  return openMenu !== null;
}

const menuClosed = new Set<() => void>();
/** Calls `listener` whenever a menu has closed, however it was closed. */
export function onMenuClosed(listener: () => void): void {
  menuClosed.add(listener);
}

/** Opens a menu under `anchor`. Clicking the same anchor again closes it. */
export function showMenu(anchor: HTMLElement, entries: MenuEntry[]): void {
  if (openMenu && openMenu.anchor === anchor) {
    closeMenu();
    return;
  }
  closeMenu();
  const el = h('div', { class: 'menu', role: 'menu' });
  for (const entry of entries) {
    if (entry.kind === 'sep') el.appendChild(h('div', { class: 'menu-sep', role: 'separator' }));
    else if (entry.kind === 'title') el.appendChild(h('div', { class: 'menu-title' }, entry.label));
    else {
      const checkable = entry.checked !== undefined;
      el.appendChild(
        h(
          'button',
          {
            class: entry.danger ? 'menu-item danger' : 'menu-item',
            type: 'button',
            role: checkable ? (entry.check ? 'menuitemcheckbox' : 'menuitemradio') : 'menuitem',
            'aria-checked': checkable ? String(entry.checked) : null,
            onclick: () => {
              // Focus goes back to what opened the menu before the choice acts, so a dialog the choice
              // opens returns there when it closes, and a redraw finds something to keep focus on.
              if (anchor.isConnected) anchor.focus({ preventScroll: true });
              closeMenu();
              entry.onSelect();
            }
          },
          entry.icon ? icon(entry.icon) : null,
          h('span', null, entry.label),
          entry.end !== undefined || entry.checked ? h('span', { class: 'end' }, entry.checked ? icon('check') : entry.end) : null
        )
      );
    }
  }
  document.body.appendChild(el);

  // Place under the anchor, flipped or shifted to stay on screen.
  const a = anchor.getBoundingClientRect();
  const m = el.getBoundingClientRect();
  let left = a.left;
  if (left + m.width > innerWidth - 8) left = Math.max(8, a.right - m.width);
  let top = a.bottom + 4;
  if (top + m.height > innerHeight - 8) top = Math.max(8, a.top - m.height - 4);
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;

  const items = (): HTMLButtonElement[] => [...el.querySelectorAll<HTMLButtonElement>('.menu-item')];
  const onKey = (event: KeyboardEvent): void => {
    const list = items();
    const index = list.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      anchor.focus();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      list[(index + 1) % list.length]?.focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      list[(index - 1 + list.length) % list.length]?.focus();
    } else if (event.key === 'Tab') {
      // The menu sits at the end of the page. Closing it from there would send Tab to the top, so focus
      // goes back to what opened it first and Tab carries on from that place.
      close();
      anchor.focus({ preventScroll: true });
    }
  };
  const onPointer = (event: Event): void => {
    const target = event.target as Node;
    if (!el.contains(target) && !anchor.contains(target)) close();
  };
  // A menu follows nothing: when the page moves under it, it closes. Scrolling inside the menu itself, or a
  // scroll that leaves the anchor where it was, is not that.
  const onScroll = (): void => {
    const moved = anchor.getBoundingClientRect();
    if (Math.abs(moved.top - a.top) > 1 || Math.abs(moved.left - a.left) > 1) close();
  };
  function close(): void {
    el.remove();
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('pointerdown', onPointer, true);
    removeEventListener('resize', close);
    removeEventListener('scroll', onScroll, true);
    anchor.setAttribute('aria-expanded', 'false');
    if (openMenu?.el === el) openMenu = null;
    for (const listener of [...menuClosed]) listener();
  }
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('pointerdown', onPointer, true);
  addEventListener('resize', close);
  addEventListener('scroll', onScroll, true);
  anchor.setAttribute('aria-haspopup', 'menu');
  anchor.setAttribute('aria-expanded', 'true');
  openMenu = { el, anchor, close };
  items()[0]?.focus();
}

// ---------------------------------------------------------------------------
// Dialogs (native <dialog>: focus trapping and Escape come with the platform)
// ---------------------------------------------------------------------------

export interface DialogHandle {
  el: HTMLDialogElement;
  body: HTMLElement;
  foot: HTMLElement;
  close: () => void;
  /** Shows an error line in the footer, or clears it. */
  setError: (message: string | null) => void;
}

/** The regions of the page that are rebuilt, for finding a dialog's opener again. */
export const DIALOG_SCOPES: readonly string[] = ['.insp', '.tabs', '.toolbar', '.pane', '.bar'];

/** Asked of the document rather than counted, so it is right the instant a dialog closes. */
export function isDialogOpen(): boolean {
  return document.querySelector('dialog[open]') !== null;
}

export function openDialog(options: { title: string; class?: string; onClose?: () => void; head?: boolean }): DialogHandle {
  closeMenu();
  // The platform returns focus to whatever opened the dialog. If the page was redrawn meanwhile, that
  // element is gone, so its replacement is found the same way a redraw finds it.
  const opener = markFocus(document.body, DIALOG_SCOPES);
  const body = h('div', { class: 'dlg-body' });
  const errorLine = h('p', { class: 'err', role: 'alert', hidden: true });
  const foot = h('div', { class: 'dlg-foot' }, errorLine);
  const el = h('dialog', { class: `dialog ${options.class ?? ''}`.trim(), 'aria-label': options.title });
  // The platform reports a close a task later. Until then the closed dialog would still be in the page
  // holding focus, and a shortcut pressed straight after Esc would be taken for typing. So tidy up at once.
  let finished = false;
  const finish = (): void => {
    if (finished) return;
    finished = true;
    // Messages still showing move out with the region instead of vanishing with the dialog.
    if (toastHost && el.contains(toastHost)) document.body.appendChild(toastHost);
    el.remove();
    options.onClose?.();
    if (!isDialogOpen()) restoreFocus(document.body, opener);
  };
  const close = (): void => {
    if (el.open) el.close();
    finish();
  };
  if (options.head !== false) {
    el.appendChild(
      h(
        'div',
        { class: 'dlg-head' },
        h('h2', null, options.title),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onclick: close }, icon('x'))
      )
    );
  }
  el.append(body, foot);
  el.addEventListener('cancel', (event) => {
    event.preventDefault();
    close();
  });
  el.addEventListener('close', finish);
  // A click on the backdrop lands on the dialog element itself.
  el.addEventListener('mousedown', (event) => {
    if (event.target === el) close();
  });
  document.body.appendChild(el);
  el.showModal();
  return {
    el,
    body,
    foot,
    close,
    setError(message) {
      errorLine.hidden = !message;
      errorLine.textContent = message ?? '';
    }
  };
}

/** An in-page confirmation that names what will be removed. Resolves true when confirmed. */
export function confirmDialog(options: { title: string; message: string; confirm: string }): Promise<boolean> {
  return new Promise((resolve) => {
    let answer = false;
    const dialog = openDialog({ title: options.title, onClose: () => resolve(answer) });
    dialog.body.appendChild(h('p', null, options.message));
    dialog.foot.append(
      h('span', { class: 'sp' }),
      h('button', { class: 'btn', type: 'button', onclick: dialog.close }, 'Cancel'),
      h(
        'button',
        {
          class: 'btn danger',
          type: 'button',
          onclick: () => {
            answer = true;
            dialog.close();
          }
        },
        options.confirm
      )
    );
  });
}

// ---------------------------------------------------------------------------
// Tooltip for chart marks
// ---------------------------------------------------------------------------

let tipEl: HTMLElement | null = null;

export function showTip(x: number, y: number, ...content: Child[]): void {
  if (!tipEl) {
    tipEl = h('div', { class: 'tip', role: 'tooltip' });
    document.body.appendChild(tipEl);
  }
  tipEl.replaceChildren();
  for (const child of content.flat()) {
    if (child === null || child === undefined || child === false) continue;
    tipEl.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  tipEl.hidden = false;
  const box = tipEl.getBoundingClientRect();
  let left = x + 12;
  if (left + box.width > innerWidth - 8) left = x - box.width - 12;
  let top = y - box.height - 10;
  if (top < 8) top = y + 14;
  tipEl.style.left = `${Math.max(8, left)}px`;
  tipEl.style.top = `${top}px`;
}

export function hideTip(): void {
  if (tipEl) tipEl.hidden = true;
}

/** Attaches a tooltip to a mark for pointer and keyboard focus alike. */
export function withTip<T extends Element>(target: T, content: () => Child[]): T {
  const show = (event: Event): void => {
    const pointer = event as PointerEvent;
    if (pointer.clientX !== undefined && event.type !== 'focus') showTip(pointer.clientX, pointer.clientY, content());
    else {
      const box = target.getBoundingClientRect();
      showTip(box.left + box.width / 2, box.top, content());
    }
  };
  target.addEventListener('pointerenter', show);
  target.addEventListener('pointermove', show);
  target.addEventListener('pointerleave', hideTip);
  target.addEventListener('focus', show);
  target.addEventListener('blur', hideTip);
  return target;
}

// ---------------------------------------------------------------------------
// Clipboard
// ---------------------------------------------------------------------------

/**
 * Copies text and confirms it. When the browser refuses clipboard access the text is shown selected in a
 * dialog instead, so it can still be copied by hand.
 */
export async function copyText(text: string, what = 'Copied'): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast(what);
    return;
  } catch {
    // fall through to the manual path
  }
  const area = h('textarea', { class: 'input num', rows: Math.min(14, text.split('\n').length + 1), readonly: true, 'aria-label': 'Text to copy' }) as HTMLTextAreaElement;
  area.value = text;
  const dialog = openDialog({ title: 'Copy this text' });
  dialog.body.append(
    h('p', { class: 'hint', style: { marginBottom: '10px' } }, 'The browser did not allow clipboard access. The text is selected: press Ctrl+C or Cmd+C.'),
    area
  );
  dialog.foot.append(h('span', { class: 'sp' }), h('button', { class: 'btn primary', type: 'button', onclick: dialog.close }, 'Done'));
  area.focus();
  area.select();
}

/** A button that opens a menu of copy formats. */
export function copyMenuButton(formats: { label: string; text: () => string; toast?: string }[], label = 'Copy'): HTMLButtonElement {
  const button = h(
    'button',
    {
      class: 'icon-btn',
      type: 'button',
      title: label,
      'aria-label': label,
      onclick: (event: Event) => {
        event.stopPropagation();
        showMenu(
          button,
          formats.map((format) => ({ label: format.label, icon: 'copy', onSelect: () => void copyText(format.text(), format.toast ?? 'Copied') }))
        );
      }
    },
    icon('copy')
  );
  return button;
}
