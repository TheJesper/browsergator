// Shared interface pieces: toasts, popover menus, dialogs, tooltips and copy-to-clipboard.

import { h, icon, type Child } from './dom.js';

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

let toastHost: HTMLElement | null = null;

export function toast(message: string, kind: 'ok' | 'err' = 'ok'): void {
  if (!toastHost) {
    toastHost = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(toastHost);
  }
  const el = h('div', { class: kind === 'err' ? 'toast err' : 'toast' }, kind === 'ok' ? icon('check') : null, message);
  toastHost.appendChild(el);
  setTimeout(() => el.remove(), kind === 'err' ? 5200 : 2200);
}

// ---------------------------------------------------------------------------
// Popover menus
// ---------------------------------------------------------------------------

export type MenuEntry =
  | { kind?: 'item'; label: string; icon?: string; end?: Child; checked?: boolean; danger?: boolean; onSelect: () => void }
  | { kind: 'sep' }
  | { kind: 'title'; label: string };

let openMenu: { el: HTMLElement; anchor: HTMLElement; close: () => void } | null = null;

export function closeMenu(): void {
  openMenu?.close();
}

export function isMenuOpen(): boolean {
  return openMenu !== null;
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
            role: checkable ? 'menuitemradio' : 'menuitem',
            'aria-checked': checkable ? String(entry.checked) : null,
            onclick: () => {
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
    } else if (event.key === 'Tab') close();
  };
  const onPointer = (event: Event): void => {
    const target = event.target as Node;
    if (!el.contains(target) && !anchor.contains(target)) close();
  };
  function close(): void {
    el.remove();
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('pointerdown', onPointer, true);
    removeEventListener('resize', close);
    removeEventListener('scroll', close, true);
    anchor.setAttribute('aria-expanded', 'false');
    if (openMenu?.el === el) openMenu = null;
  }
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('pointerdown', onPointer, true);
  addEventListener('resize', close);
  addEventListener('scroll', close, true);
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

/** Asked of the document rather than counted, so it is right the instant a dialog closes. */
export function isDialogOpen(): boolean {
  return document.querySelector('dialog[open]') !== null;
}

export function openDialog(options: { title: string; class?: string; onClose?: () => void; head?: boolean }): DialogHandle {
  closeMenu();
  const body = h('div', { class: 'dlg-body' });
  const errorLine = h('p', { class: 'err', role: 'alert', hidden: true });
  const foot = h('div', { class: 'dlg-foot' }, errorLine);
  const el = h('dialog', { class: `dialog ${options.class ?? ''}`.trim(), 'aria-label': options.title });
  const close = (): void => el.close();
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
  el.addEventListener('close', () => {
    el.remove();
    options.onClose?.();
  });
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
