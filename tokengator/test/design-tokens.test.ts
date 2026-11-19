// The colour tokens of the dashboard, checked by calculation rather than by eye (task 10.1): text against
// every ground it is set on, marks against the grounds they are drawn on, and the two dark definitions
// against each other.

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../public/app.css', import.meta.url), 'utf8');

/** The body of the first rule that starts with `selector`, nested braces included. */
function block(selector: string): string {
  const open = css.indexOf('{', css.indexOf(selector));
  let depth = 1;
  let at = open + 1;
  while (depth > 0) {
    if (css[at] === '{') depth += 1;
    else if (css[at] === '}') depth -= 1;
    at += 1;
  }
  return css.slice(open + 1, at - 1);
}

const tokens = (body: string): Record<string, string> => Object.fromEntries([...body.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})\s*;/gi)].map((match) => [match[1] as string, match[2] as string]));

const light = tokens(block(':root {'));
const darkBySystem = tokens(block('@media (prefers-color-scheme: dark)'));
const darkByChoice = tokens(block(':root[data-theme="dark"]'));

function luminance(hex: string): number {
  const channel = (at: number): number => {
    const value = parseInt(hex.slice(at, at + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** WCAG 2 contrast ratio of two colours. */
function contrast(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (high + 0.05) / (low + 0.05);
}

// Machado, Oliveira and Fernandes (2009): how a colour looks with one cone type missing, in linear RGB.
const DEFICIENCY = {
  protan: [0.152286, 1.052583, -0.204868, 0.114503, 0.786281, 0.099216, -0.003882, -0.048116, 1.051998],
  deutan: [0.367322, 0.860646, -0.227968, 0.280085, 0.672501, 0.047413, -0.01182, 0.04294, 0.968881],
  tritan: [1.255528, -0.076749, -0.178779, -0.078411, 0.930809, 0.147602, 0.004733, 0.691367, 0.3039]
} as const;

function linear(hex: string): [number, number, number] {
  const channel = (at: number): number => {
    const value = parseInt(hex.slice(at, at + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return [channel(1), channel(3), channel(5)];
}

function oklab([r, g, b]: [number, number, number]): [number, number, number] {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

/** Distance between two colours in OKLab (x100), as seen with the given deficiency or with none. */
function difference(a: string, b: string, kind: keyof typeof DEFICIENCY | null): number {
  const seen = (hex: string): [number, number, number] => {
    const [r, g, bl] = linear(hex);
    if (kind === null) return oklab([r, g, bl]);
    const m = DEFICIENCY[kind];
    const clamp = (value: number): number => Math.max(0, Math.min(1, value));
    return oklab([clamp(m[0] * r + m[1] * g + m[2] * bl), clamp(m[3] * r + m[4] * g + m[5] * bl), clamp(m[6] * r + m[7] * g + m[8] * bl)]);
  };
  const [p, q] = [seen(a), seen(b)];
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) * 100;
}

const TEXT = ['ink', 'ink-2', 'ink-3', 'used-ink', 'expiring-ink', 'ok-ink', 'hot-ink', 'stop-ink'];
/** Everything text is set on: the page, cards, raised controls, the selected row and the urgent band. */
const TEXT_GROUNDS = ['bg', 'surface', 'raised', 'select', 'risk-wash'];
/** Solid marks: a bar segment, a status dot, a chart line. The hatched forecast fills are not among them. */
const MARKS = ['used', 'expiring', 'ok', 'hot', 'stop'];
const MARK_GROUNDS = ['bg', 'surface', 'track'];

describe.each([
  ['light', light],
  ['dark', darkBySystem]
])('%s theme', (_name, theme) => {
  it('defines every token the checks below read', () => {
    for (const name of [...TEXT, ...TEXT_GROUNDS, ...MARKS, ...MARK_GROUNDS, 'control', 'focus']) expect(theme[name], name).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('sets every text colour at 4.5:1 or better on every ground it appears on', () => {
    for (const ink of TEXT) {
      for (const ground of TEXT_GROUNDS) {
        expect(contrast(theme[ink] as string, theme[ground] as string), `${ink} on ${ground}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('draws every solid mark at 3:1 or better against the page, the cards and the bar track', () => {
    for (const mark of MARKS) {
      for (const ground of MARK_GROUNDS) {
        expect(contrast(theme[mark] as string, theme[ground] as string), `${mark} on ${ground}`).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it('sets the text of an error message at 4.5:1 or better on its own fill (review finding)', () => {
    expect(contrast(theme['on-stop'] as string, theme['stop'] as string)).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps input borders and the focus ring at 3:1 or better', () => {
    for (const ground of ['bg', 'surface']) {
      expect(contrast(theme['control'] as string, theme[ground] as string), `control on ${ground}`).toBeGreaterThanOrEqual(3);
    }
    for (const ground of [...TEXT_GROUNDS, 'track']) {
      expect(contrast(theme['focus'] as string, theme[ground] as string), `focus on ${ground}`).toBeGreaterThanOrEqual(3);
    }
  });

  it('keeps "used" and "will expire" apart for readers with a colour-vision deficiency', () => {
    // Blue and orange are the pair the interface rests on, and they sit side by side in one bar. Hatching
    // separates fact from forecast, but these two are both solid, so the colours alone must hold.
    // The published design target for adjacent marks is a difference of 8 in OKLab (x100).
    for (const kind of ['protan', 'deutan', 'tritan'] as const) {
      expect(difference(theme['used'] as string, theme['expiring'] as string, kind), kind).toBeGreaterThanOrEqual(8);
    }
    expect(difference(theme['used'] as string, theme['expiring'] as string, null)).toBeGreaterThanOrEqual(15);
  });
});

describe('dark theme definitions', () => {
  it('are the same whether the system or the viewer chose dark', () => {
    expect(darkBySystem).toEqual(darkByChoice);
  });

  it('redefine every colour the light theme defines, and nothing else', () => {
    expect(Object.keys(darkBySystem).sort()).toEqual(Object.keys(light).sort());
  });
});
