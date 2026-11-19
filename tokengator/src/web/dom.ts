// A small element helper. The dashboard has a few dozen rows on screen, so views simply rebuild their DOM
// from state; there is no virtual DOM to keep in sync.

export type Child = Node | string | number | null | undefined | false | Child[];

type Props = Record<string, unknown>;

function append(parent: Node, child: Child): void {
  if (child === null || child === undefined || child === false) return;
  if (Array.isArray(child)) {
    for (const entry of child) append(parent, entry);
    return;
  }
  // Text always goes in as a text node: account names and notes are user data, never markup.
  parent.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
}

function applyProps(el: Element, props: Props): void {
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.setAttribute('class', String(value));
    else if (key === 'style' && typeof value === 'object') Object.assign((el as HTMLElement).style, value);
    else if (key === 'dataset' && typeof value === 'object') {
      for (const [name, data] of Object.entries(value as Record<string, unknown>)) {
        if (data !== null && data !== undefined) (el as HTMLElement).dataset[name] = String(data);
      }
    } else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (key === 'value' || key === 'checked' || key === 'disabled' || key === 'selected' || key === 'indeterminate') {
      (el as unknown as Record<string, unknown>)[key] = value;
    } else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, String(value));
  }
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Props | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) applyProps(el, props);
  append(el, children);
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

export function s(tag: string, props?: Props | null, ...children: Child[]): SVGElement {
  const el = document.createElementNS(SVG_NS, tag);
  if (props) applyProps(el, props);
  append(el, children);
  return el;
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function mount(el: Element, ...children: Child[]): void {
  clear(el);
  append(el, children);
}

// ---------------------------------------------------------------------------
// Icons: 16px, 1.5px strokes, drawn here so the bundle needs no icon font or sprite file.
// ---------------------------------------------------------------------------

const ICONS: Record<string, string[]> = {
  copy: ['M5.5 5.5V3.5a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-2', 'M3.5 5.5h6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-6a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1z'],
  plus: ['M8 3.5v9', 'M3.5 8h9'],
  check: ['M3.5 8.5l3 3 6-7'],
  x: ['M4 4l8 8', 'M12 4l-8 8'],
  more: ['M3.5 8h.01', 'M8 8h.01', 'M12.5 8h.01'],
  edit: ['M10.5 3.5l2 2', 'M3 13l.6-2.9 7.4-7.4a1.4 1.4 0 0 1 2 2L5.6 12.1z'],
  external: ['M9 3h4v4', 'M13 3L7.5 8.5', 'M11.5 9.5v3a.5.5 0 0 1-.5.5H3.5a.5.5 0 0 1-.5-.5V5a.5.5 0 0 1 .5-.5h3'],
  refresh: ['M13 8a5 5 0 1 1-1.5-3.6', 'M13 3v2.5h-2.5'],
  search: ['M7.2 11.4a4.2 4.2 0 1 0 0-8.4 4.2 4.2 0 0 0 0 8.4z', 'M10.3 10.3L13 13'],
  sort: ['M4.5 3v10', 'M2.5 11l2 2 2-2', 'M9 4.5h4.5', 'M9 8h3', 'M9 11.5h1.5'],
  chevron: ['M4.5 6.5L8 10l3.5-3.5'],
  clock: ['M8 13.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11z', 'M8 5v3l2 1.5'],
  snooze: ['M12.5 9.5A5 5 0 0 1 6.5 3.5a5 5 0 1 0 6 6z'],
  plug: ['M6 2.5v3', 'M10 2.5v3', 'M4.5 5.5h7v2.5a3.5 3.5 0 0 1-7 0z', 'M8 11.5v2'],
  keyboard: ['M2.5 4.5h11a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1z', 'M4.5 7h.01', 'M7 7h.01', 'M9.5 7h.01', 'M12 7h.01', 'M5.5 9.5h5'],
  sun: ['M8 10.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z', 'M8 1.8v1.4', 'M8 12.8v1.4', 'M1.8 8h1.4', 'M12.8 8h1.4', 'M3.6 3.6l1 1', 'M11.4 11.4l1 1', 'M3.6 12.4l1-1', 'M11.4 4.6l1-1'],
  trash: ['M3 4.5h10', 'M6.5 4.5V3h3v1.5', 'M4.5 4.5l.5 8.5h6l.5-8.5'],
  download: ['M8 2.5v7', 'M5 7l3 3 3-3', 'M3 12.5h10'],
  upload: ['M8 10V3', 'M5 5.5l3-3 3 3', 'M3 12.5h10'],
  bell: ['M4.5 11V7.5a3.5 3.5 0 0 1 7 0V11l1 1.5h-9z', 'M7 14h2'],
  eye: ['M1.8 8s2.2-4 6.2-4 6.2 4 6.2 4-2.2 4-6.2 4-6.2-4-6.2-4z', 'M8 9.8a1.8 1.8 0 1 0 0-3.6 1.8 1.8 0 0 0 0 3.6z'],
  bolt: ['M9 1.8L3.8 9H8l-1 5.2L12.2 7H8z'],
  rows: ['M2.5 4h11', 'M2.5 8h11', 'M2.5 12h11'],
  sample: ['M6 2.5h4', 'M6.5 2.5v4L3 12.5a.7.7 0 0 0 .6 1h8.8a.7.7 0 0 0 .6-1L9.5 6.5v-4', 'M5 10h6']
};

export function icon(name: keyof typeof ICONS | string, label?: string): SVGElement {
  const paths = ICONS[name] ?? [];
  const el = s(
    'svg',
    { class: 'ico', viewBox: '0 0 16 16', 'aria-hidden': label ? null : 'true', role: label ? 'img' : null, 'aria-label': label ?? null },
    paths.map((d) => s('path', { d }))
  );
  return el;
}

/** The wordmark's glyph: three bars draining, the last one about to expire. */
export function brandMark(): SVGElement {
  return s(
    'svg',
    { viewBox: '0 0 22 22', 'aria-hidden': 'true' },
    s('rect', { class: 'b-used', x: 2, y: 4, width: 18, height: 3.4, rx: 1.7 }),
    s('rect', { class: 'b-used', x: 2, y: 9.3, width: 12.5, height: 3.4, rx: 1.7 }),
    s('rect', { class: 'b-exp', x: 2, y: 14.6, width: 7, height: 3.4, rx: 1.7 })
  );
}

/** Runs `handler` once the element is clicked or activated by keyboard, without the click reaching a parent row. */
export function isolated(handler: (event: Event) => void): (event: Event) => void {
  return (event) => {
    event.stopPropagation();
    handler(event);
  };
}
