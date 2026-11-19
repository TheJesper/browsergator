import { describe, expect, it } from 'vitest';

import {
  ACTIVE_TIERS,
  BAR_CELLS,
  BAR_EXPIRING,
  BAR_PROJECTED,
  BAR_TRACK,
  BAR_USED,
  colorMode,
  columns,
  forecastBar,
  padEnd,
  padStart,
  renderCatalog,
  renderProvider,
  renderCollectors,
  renderConnect,
  renderEmpty,
  renderStatus,
  truncate,
  visibleLength
} from '../src/cli/render.js';
import { addAccount, updateAccount, type AccountInput } from '../src/core/accounts.js';
import type { ProviderPreset } from '../src/core/catalog-types.js';
import { connectSnippets } from '../src/core/connect.js';
import { TIER_ORDER, summarise, viewState, type MeterView, type Tier } from '../src/core/forecast.js';
import { applyReadingToState } from '../src/core/reset.js';
import { DAY, HOUR, iso } from '../src/core/time.js';
import { emptyState, type State } from '../src/core/types.js';
import { TIER_LABEL, stateLabel, summaryLine } from '../src/core/wording.js';

/** Thursday 19 November 2026, 10:00 UTC. */
const NOW = Date.UTC(2026, 10, 19, 10, 0, 0);
const ESC = String.fromCharCode(27);
const BAR = new RegExp(`[${BAR_USED}${BAR_PROJECTED}${BAR_EXPIRING}${BAR_TRACK}]{${BAR_CELLS}}`);
const BLUE = '38;2;111;177;214';
const ORANGE = '38;2;222;138;90';

interface Seed {
  input: AccountInput;
  /** Percent used, by meter label. A meter that is not listed never gets a reading. */
  used?: Record<string, number>;
  /** How long ago the readings were taken. */
  ageMs?: number;
}

function build(seeds: Seed[]): State {
  let state = emptyState();
  for (const seed of seeds) {
    const at = NOW - (seed.ageMs ?? 0);
    const added = addAccount(state, seed.input, at);
    state = added.state;
    for (const meter of added.account.meters) {
      const used = seed.used?.[meter.label];
      if (used !== undefined) state = applyReadingToState(state, added.account.id, meter.id, { usedPercent: used }, at);
    }
  }
  return state;
}

const week = (resetsInMs: number): AccountInput['meters'][number] => ({ label: 'Weekly limit', reset: { kind: 'interval', hours: 168 }, resetsAt: iso(NOW + resetsInMs) });
const month = (label: string, resetsInMs: number): AccountInput['meters'][number] => ({ label, reset: { kind: 'interval', hours: 720 }, resetsAt: iso(NOW + resetsInMs) });
const usd = (amount: number): AccountInput['price'] => ({ amount, currency: 'USD', period: 'month' });

/** One meter in each state the queue distinguishes, with names of very different lengths. */
function fixture(): State {
  return build([
    { input: { label: 'Midjourney Standard', price: usd(30), meters: [month('Fast GPU time', 8 * DAY)] }, used: { 'Fast GPU time': 99 } },
    { input: { label: 'GitHub Copilot Pro', price: usd(10), meters: [month('Monthly AI credits', 12 * DAY)] }, used: { 'Monthly AI credits': 12 } },
    { input: { label: 'Suno', price: usd(10), meters: [month('Credits', 22 * DAY)] }, used: { Credits: 52 } },
    {
      input: { label: 'Claude Max', price: usd(100), meters: [{ label: '5-hour session', role: 'throttle', reset: { kind: 'rolling', hours: 5 } }, week(14 * HOUR)] },
      used: { 'Weekly limit': 62 }
    },
    { input: { label: 'Gemini', price: usd(20), meters: [week(4 * DAY)] }, used: { 'Weekly limit': 40 } },
    { input: { label: 'Old plan', meters: [{ label: 'Tokens', reset: { kind: 'interval', hours: 168 } }] } }
  ]);
}

const tierOf = (state: State, account: string): Tier | null => viewState(state, NOW).find((view) => view.account.label === account && view.tier !== null)?.tier ?? null;
const viewOf = (state: State, account: string, meter?: string): MeterView => {
  const found = viewState(state, NOW).find((view) => view.account.label === account && (meter === undefined ? view.tier !== null : view.meter.label === meter));
  if (!found) throw new Error(`no view for ${account}`);
  return found;
};
const strip = (text: string): string => text.split(ESC).map((part, index) => (index === 0 ? part : part.slice(part.indexOf('m') + 1))).join('');
/** The lines that are table rows: the ones that carry a bar. */
const rowsOf = (text: string): string[] => text.split('\n').filter((line) => BAR.test(line));

describe('the fixture', () => {
  it('has one meter in each state the tests rely on', () => {
    const state = fixture();
    expect(tierOf(state, 'Claude Max')).toBe('use-now');
    expect(tierOf(state, 'GitHub Copilot Pro')).toBe('behind');
    expect(tierOf(state, 'Suno')).toBe('hot');
    expect(tierOf(state, 'Gemini')).toBe('on-pace');
    expect(tierOf(state, 'Midjourney Standard')).toBe('spent');
    expect(tierOf(state, 'Old plan')).toBe('idle');
  });
});

describe('width helpers', () => {
  it('measures what a terminal shows, not what the string holds', () => {
    expect(visibleLength('plain')).toBe(5);
    expect(visibleLength(`${ESC}[1;${ORANGE}mUse now${ESC}[0m`)).toBe(7);
    expect(visibleLength(`${ESC}[${BLUE}m${BAR_USED.repeat(3)}${ESC}[0m${BAR_EXPIRING}`)).toBe(4);
    expect(visibleLength('Claude · Weekly')).toBe(15);
    expect(visibleLength('')).toBe(0);
  });

  it('pads to a visible width and never cuts', () => {
    const painted = `${ESC}[${ORANGE}mab${ESC}[0m`;
    expect(padEnd('ab', 5)).toBe('ab   ');
    expect(padStart('ab', 5)).toBe('   ab');
    expect(padEnd(painted, 5)).toBe(`${painted}   `);
    expect(padStart(painted, 5)).toBe(`   ${painted}`);
    expect(padEnd('abcdef', 3)).toBe('abcdef');
  });

  it('shortens with an ellipsis only when it has to', () => {
    expect(truncate('Claude Max · Weekly limit', 40)).toBe('Claude Max · Weekly limit');
    expect(truncate('Claude Max · Weekly limit', 12)).toBe('Claude Max…');
    // Cut after a space, the blank goes too, so the result may be a cell shorter but never longer.
    expect(truncate('GitHub Copilot Pro · Monthly AI credits', 20)).toBe('GitHub Copilot Pro…');
    expect(truncate('GitHub Copilot Pro · Monthly AI credits', 23)).toBe('GitHub Copilot Pro · M…');
    expect(visibleLength(truncate('GitHub Copilot Pro · Monthly AI credits', 23))).toBe(23);
    expect(truncate('abc', 1)).toBe('a');
  });

  it('aligns cells into columns without trailing blanks', () => {
    expect(columns([['a', 'bbb', 'c'], ['aaaa', 'b', '']], 2, 1)).toEqual([' a     bbb  c', ' aaaa  b']);
    expect(columns([])).toEqual([]);
  });
});

describe('forecastBar', () => {
  const state = fixture();

  it('is always twenty cells, whatever the state', () => {
    for (const view of viewState(state, NOW)) {
      expect([...forecastBar(view)], `${view.account.label} ${view.meter.label}`).toHaveLength(BAR_CELLS);
      expect(visibleLength(forecastBar(view, 'truecolor'))).toBe(BAR_CELLS);
    }
  });

  it('shows used, projected and expiring with three different characters', () => {
    expect(new Set([BAR_USED, BAR_PROJECTED, BAR_EXPIRING, BAR_TRACK]).size).toBe(4);
    const view = viewOf(state, 'Claude Max');
    const bar = forecastBar(view);
    expect(bar).toMatch(new RegExp(`^${BAR_USED}+${BAR_PROJECTED}+${BAR_EXPIRING}+$`));
    // 62% used of twenty cells.
    expect(bar.split(BAR_USED).length - 1).toBe(12);
    expect(bar.split(BAR_EXPIRING).length - 1).toBe(Math.round(view.projectedUnused * BAR_CELLS));
  });

  it('draws no expiring share where nothing will expire', () => {
    expect(forecastBar(viewOf(state, 'Suno'))).toMatch(new RegExp(`^${BAR_USED}+${BAR_PROJECTED}+$`));
    expect(forecastBar(viewOf(state, 'Midjourney Standard'))).toBe(BAR_USED.repeat(BAR_CELLS));
    expect(forecastBar(viewOf(state, 'Old plan'))).toBe(BAR_TRACK.repeat(BAR_CELLS));
    expect(forecastBar(viewOf(state, 'Claude Max', '5-hour session'))).toBe(BAR_TRACK.repeat(BAR_CELLS));
  });

  it('never rounds a small used share away, nor the share that will expire', () => {
    const tiny = build([{ input: { label: 'Tiny', meters: [month('Credits', 20 * DAY)] }, used: { Credits: 1 } }]);
    expect(forecastBar(viewOf(tiny, 'Tiny')).startsWith(BAR_USED)).toBe(true);
    const nearly = build([{ input: { label: 'Nearly', meters: [week(10 * HOUR)] }, used: { 'Weekly limit': 88 } }]);
    const view = viewOf(nearly, 'Nearly');
    expect(view.tier).toBe('use-now');
    expect(forecastBar(view).endsWith(BAR_EXPIRING)).toBe(true);
  });

  it('colours used blue and expiring orange, and nothing when colour is off', () => {
    const view = viewOf(state, 'Claude Max');
    const painted = forecastBar(view, 'truecolor');
    expect(painted).toContain(`${ESC}[${BLUE}m${BAR_USED}`);
    expect(painted).toContain(`${ESC}[${ORANGE}m${BAR_EXPIRING}`);
    expect(strip(painted)).toBe(forecastBar(view));
    expect(forecastBar(view, 'none')).not.toContain(ESC);
    expect(forecastBar(view, '256')).toContain(`${ESC}[38;5;`);
  });
});

describe('renderStatus', () => {
  const state = fixture();
  const plain = renderStatus(state, NOW);

  it('has no escape codes and no trailing blanks when colour is off', () => {
    expect(plain).not.toContain(ESC);
    for (const line of plain.split('\n')) expect(line).toBe(line.trimEnd());
    expect(plain.endsWith('\n')).toBe(true);
  });

  it('keeps every column in the same place on every row', () => {
    const rows = rowsOf(plain);
    expect(rows).toHaveLength(4);
    const header = plain.split('\n')[0] as string;
    const barAt = (rows[0] as string).search(BAR);
    expect(header.indexOf('Forecast')).toBe(barAt);
    for (const row of rows) {
      expect(row.search(BAR), row).toBe(barAt);
      // Percentages are right-aligned under "Left", so the sign sits in one column.
      expect(row.indexOf('%', barAt), row).toBe(header.indexOf('Left') + 'Left'.length - 1);
      expect(row.slice(barAt + BAR_CELLS, barAt + BAR_CELLS + 2)).toBe('  ');
    }
    const nameAt = header.indexOf('Quota');
    expect(rows.map((row) => row.slice(nameAt).split(' · ')[0])).toEqual(['Claude Max', 'GitHub Copilot Pro', 'Suno', 'Gemini']);
    const resetAt = header.indexOf('Resets in');
    expect(rows.map((row) => row.slice(resetAt).split('  ')[0])).toEqual(['14h', '12d', '22d', '4d']);
  });

  it('gives each row its state, name, share left, time to reset and value at risk', () => {
    const claude = rowsOf(plain).find((row) => row.includes('Claude Max')) as string;
    const view = viewOf(state, 'Claude Max');
    expect(claude.trimStart().startsWith(stateLabel(view))).toBe(true);
    expect(claude).toContain('Claude Max · Weekly limit');
    expect(claude).toContain(' 38%');
    expect(claude).toContain('14h');
    expect(claude).toMatch(/\$\d+\.\d\d$/);
    expect(view.valueAtRisk).toBeGreaterThan(0);
  });

  it('groups rows under state headings in "use first" order', () => {
    const headings = plain.split('\n').filter((line) => /^\S.* \(\d+\)/.test(line));
    expect(headings.map((line) => line.split(' (')[0])).toEqual(['Use now', 'Behind pace', 'Running hot', 'On pace']);
    const order = headings.map((line) => TIER_ORDER.findIndex((tier) => TIER_LABEL[tier] === line.split(' (')[0]));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // Each heading is followed by its own rows.
    const lines = plain.split('\n');
    expect(lines[lines.indexOf(headings[0] as string) + 1]).toContain('Claude Max');
    expect(lines[lines.indexOf(headings[1] as string) + 1]).toContain('GitHub Copilot Pro');
  });

  it('shows only the states a person can act on, and says what it left out', () => {
    expect(ACTIVE_TIERS).toEqual(['use-now', 'behind', 'hot', 'on-pace', 'fresh']);
    expect(plain).not.toContain('Midjourney');
    expect(plain).not.toContain('5-hour session');
    expect(plain).not.toContain('Old plan');
    expect(plain).toContain('3 more are not shown (not running, used up, rate limits). Show everything: tokengator status --all');
  });

  it('shows everything with all, rate limits included', () => {
    const everything = renderStatus(state, NOW, { all: true });
    expect(rowsOf(everything)).toHaveLength(7);
    expect(everything).toContain('Used up (1)');
    expect(everything).toContain('Not running (1)');
    expect(everything).toContain('Rate limits (1)');
    expect(rowsOf(everything).find((row) => row.includes('5-hour session'))?.trimStart().startsWith('Idle')).toBe(true);
    expect(everything).not.toContain('not shown');
    const barAt = (rowsOf(everything)[0] as string).search(BAR);
    for (const row of rowsOf(everything)) expect(row.search(BAR)).toBe(barAt);
  });

  it('finishes with the summary line every interface shares', () => {
    const lines = plain.trimEnd().split('\n');
    const summary = summaryLine(summarise(state, NOW), state.settings.currency);
    expect(summary).toMatch(/^1 quota needs using now/);
    expect(lines[lines.length - 1]).toBe(summary);
  });

  it('adds a hint to refresh when a reading is stale', () => {
    const stale = build([{ input: { label: 'Claude Max', price: usd(100), meters: [week(14 * HOUR)] }, used: { 'Weekly limit': 62 }, ageMs: 3 * DAY }]);
    const text = renderStatus(stale, NOW);
    const lines = text.trimEnd().split('\n');
    expect(summarise(stale, NOW).stale).toBe(1);
    expect(lines[lines.length - 2]).toBe(summaryLine(summarise(stale, NOW), 'USD'));
    expect(lines[lines.length - 1]).toBe('1 reading is stale. Refresh: tokengator collectors run, or tokengator set <account> <amount>.');
    expect(rowsOf(text)[0]).toMatch(/updated 3d ago$/);
    expect(plain).not.toContain('stale');
  });

  it('is the same text with colour on, once the escape codes are removed', () => {
    for (const options of [{}, { all: true }, { width: 100 }, { width: 72, all: true }]) {
      const painted = renderStatus(state, NOW, { ...options, color: 'truecolor' });
      expect(painted).toContain(ESC);
      expect(strip(painted)).toBe(renderStatus(state, NOW, options));
      expect(strip(renderStatus(state, NOW, { ...options, color: '256' }))).toBe(renderStatus(state, NOW, options));
    }
  });

  it('uses blue for used, orange for expiring and for the two urgent labels, and grey for the rest', () => {
    const painted = renderStatus(state, NOW, { color: 'truecolor' });
    expect(painted).toContain(`${ESC}[${BLUE}m${BAR_USED}`);
    expect(painted).toContain(`${ESC}[${ORANGE}m${BAR_EXPIRING}`);
    expect(painted).toContain(`${ESC}[${ORANGE}mUse now${ESC}[0m`);
    expect(painted).toContain(`${ESC}[${ORANGE}mBehind pace${ESC}[0m`);
    expect(painted).not.toContain(`${ESC}[${ORANGE}mOn pace`);
    expect(painted).toContain(`${ESC}[38;2;128;141;144m`);
  });

  it('fits a narrow terminal by dropping the state column and shortening names', () => {
    const narrow = renderStatus(state, NOW, { width: 72 });
    const rows = rowsOf(narrow);
    expect(rows).toHaveLength(4);
    for (const row of rows) expect(visibleLength(row)).toBeLessThanOrEqual(72);
    expect(narrow.split('\n')[0]).not.toContain('State');
    expect(rows.find((row) => row.includes('GitHub Copilot'))).toContain('…');
    // The heading still carries the state the rows no longer repeat.
    expect(narrow).toContain('Use now (1)');
    const barAt = (rows[0] as string).search(BAR);
    for (const row of rows) expect(row.search(BAR)).toBe(barAt);
  });

  it('keeps the state column on a terminal wide enough for readable names', () => {
    const wide = renderStatus(state, NOW, { width: 120 });
    expect(wide.split('\n')[0]).toContain('State');
    expect(wide).toBe(plain);
  });

  it('puts a remark that does not fit under its row instead of letting it wrap', () => {
    const stale = build([{ input: { label: 'Claude Max', price: usd(100), meters: [week(14 * HOUR)] }, used: { 'Weekly limit': 62 }, ageMs: 3 * DAY }]);
    const lines = renderStatus(stale, NOW, { width: 76 }).split('\n');
    const row = lines.findIndex((line) => BAR.test(line));
    expect(lines[row]).not.toContain('updated');
    expect((lines[row + 1] as string).trim()).toBe('updated 3d ago');
  });

  it('says so when a snoozed account is left out, and shows it with all', () => {
    const base = fixture();
    const claude = base.accounts.find((account) => account.label === 'Claude Max');
    const snoozed = updateAccount(base, claude?.id ?? '', { snoozedUntil: iso(NOW + DAY) }, NOW);
    const text = renderStatus(snoozed, NOW);
    expect(text).not.toContain('Claude Max');
    expect(text).toContain('snoozed');
    const everything = renderStatus(snoozed, NOW, { all: true });
    expect(everything).toContain('Snoozed (1)');
    expect(rowsOf(everything).find((row) => row.includes('Claude Max · Weekly limit'))).toMatch(/snoozed$/);
  });

  it('explains how to add an account when nothing is tracked', () => {
    const text = renderStatus(emptyState(), NOW);
    expect(text).toBe(renderEmpty());
    expect(text).toContain('No subscriptions are tracked yet.');
    expect(text).toContain('tokengator add --list');
    expect(text).toContain('tokengator add <provider>');
    expect(renderEmpty('tg')).toContain('tg serve');
  });

  it('has something to say when accounts exist but none is in an active window', () => {
    const quiet = build([{ input: { label: 'Old plan', meters: [{ label: 'Tokens', reset: { kind: 'interval', hours: 168 } }] } }]);
    const text = renderStatus(quiet, NOW);
    expect(rowsOf(text)).toHaveLength(0);
    expect(text).toContain('Nothing is in an active window (1 meter: not running). Show everything: tokengator status --all');
    expect(text.trimEnd().split('\n').pop()).toBe(summaryLine(summarise(quiet, NOW), 'USD'));
  });
});

describe('colorMode', () => {
  const tty = { isTTY: true, getColorDepth: () => 24 };

  it('is off unless standard output is a terminal', () => {
    expect(colorMode({}, {})).toBe('none');
    expect(colorMode({ isTTY: false, getColorDepth: () => 24 }, {})).toBe('none');
    expect(colorMode(tty, {})).toBe('truecolor');
  });

  it('is off when NO_COLOR is set, when --no-color was given, and on a dumb terminal', () => {
    expect(colorMode(tty, { NO_COLOR: '1' })).toBe('none');
    expect(colorMode(tty, { NO_COLOR: '' })).toBe('none');
    expect(colorMode(tty, {}, true)).toBe('none');
    expect(colorMode(tty, { TERM: 'dumb' })).toBe('none');
  });

  it('falls back to the indexed palette, or to nothing, on terminals with fewer colours', () => {
    expect(colorMode({ isTTY: true, getColorDepth: () => 8 }, {})).toBe('256');
    expect(colorMode({ isTTY: true, getColorDepth: () => 4 }, {})).toBe('none');
    expect(colorMode({ isTTY: true, getColorDepth: () => 1 }, {})).toBe('none');
    expect(colorMode({ isTTY: true }, { COLORTERM: 'truecolor' })).toBe('truecolor');
    expect(colorMode({ isTTY: true }, {})).toBe('256');
  });
});

describe('other listings', () => {
  const preset: ProviderPreset = {
    id: 'example',
    name: 'Example AI',
    vendor: 'Example',
    monogram: 'Ex',
    category: 'music',
    usageUrl: 'https://example.com/usage',
    howToRead: 'Read the credits.',
    collectors: [],
    plans: [
      { id: 'pro', name: 'Pro', price: { amount: 10, currency: 'USD', period: 'month' }, meters: [] },
      { id: 'yearly', name: 'Yearly', price: { amount: 99.5, currency: 'USD', period: 'year' }, meters: [] },
      { id: 'free', name: 'Free', price: null, meters: [] }
    ]
  };

  it('says so when the catalog is empty', () => {
    const text = renderCatalog([], '2026-11-19');
    expect(text).toContain('The catalog has no providers.');
    expect(text).toContain('tokengator serve');
  });

  it('shows one provider in full', () => {
    const text = renderProvider({
      ...preset,
      collectors: ['example-api'],
      uses: [{ title: 'Scheduled runs', note: 'Draws on the same credits.', url: 'https://example.com/docs/schedule' }],
      plans: [{ id: 'pro', name: 'Pro', price: { amount: 10, currency: 'USD', period: 'month' }, note: 'Limits are not published.', meters: [] }]
    });
    expect(text.split('\n')).toEqual([
      'Example AI (example), music',
      '',
      'Usage page: https://example.com/usage',
      'What to read there: Read the credits.',
      '',
      'Plans',
      '  pro  Pro · $10/mo',
      '       Limits are not published.',
      '',
      'Ways the provider documents for using it while you are away',
      '  Scheduled runs: Draws on the same credits.',
      '    https://example.com/docs/schedule',
      '',
      'Can be read automatically: tokengator collectors enable example-api',
      '',
      'Add it: tokengator add example [--plan <plan>] [--label <name>] [--billing-day <1-31>]',
      ''
    ]);
  });

  it('says how a status line fills a provider, apart from collectors that can be switched on (review finding)', () => {
    const text = renderProvider({ ...preset, collectors: ['example-statusline', 'example-api'] });
    expect(text).toContain('Fills itself once its status line command is set: tokengator connect --client statusline');
    expect(text).toContain('Can be read automatically: tokengator collectors enable example-api');
    // The id of a status line is never offered to a command that would refuse it.
    expect(text).not.toContain('example-statusline');
  });

  it('lists providers by category with their plan ids and prices', () => {
    const text = renderCatalog([preset, { ...preset, id: 'longer-id', name: 'Other', category: 'coding', plans: [] }], '2026-11-19');
    const lines = text.split('\n');
    expect(lines[0]).toContain('checked 2026-11-19');
    expect(lines.indexOf('Coding')).toBeLessThan(lines.indexOf('Music'));
    expect(text).toContain('  example    Example AI  pro ($10/mo), yearly ($99.50/yr), free');
    expect(text).toContain('  longer-id  Other');
    expect(text).toContain('tokengator add <provider>');
    for (const line of lines) expect(line).toBe(line.trimEnd());
  });

  it('lists collectors with their source, switch, availability and last run', () => {
    const text = renderCollectors([
      { id: 'local', sourceKind: 'local-file', enabled: true, available: true, reason: null, lastOutcome: 'ok', lastMessage: null },
      { id: 'remote-api', sourceKind: 'documented-api', enabled: false, available: false, reason: 'Set EXAMPLE_API_KEY to switch this on.', lastOutcome: null, lastMessage: null },
      { id: 'broken', sourceKind: 'undocumented-api', enabled: true, available: true, reason: null, lastOutcome: 'auth', lastMessage: 'The provider refused the key (401).' }
    ]);
    expect(text.split('\n')).toEqual([
      'Id          Source            Enabled  Available                               Last run',
      'local       local-file        on       available                               ok',
      'remote-api  documented-api    off      Set EXAMPLE_API_KEY to switch this on.  -',
      'broken      undocumented-api  on       available                               auth: The provider refused the key (401).',
      ''
    ]);
    expect(renderCollectors([])).toBe('No collectors.\n');
  });

  it('prints connection snippets under the headings the dashboard uses', () => {
    const snippets = connectSnippets({ origin: 'http://127.0.0.1:4777', cli: 'tokengator', tokenRequired: false });
    const text = renderConnect(snippets);
    const lines = text.split('\n');
    expect(lines.indexOf('MCP over HTTP')).toBe(0);
    expect(lines.indexOf('MCP over HTTP')).toBeLessThan(lines.indexOf('MCP over stdio'));
    expect(lines.indexOf('MCP over stdio')).toBeLessThan(lines.indexOf('Command line'));
    expect(text).toContain('http://127.0.0.1:4777/mcp');
    for (const snippet of snippets) {
      expect(text).toContain(`  ${snippet.title} (${snippet.id})`);
      for (const codeLine of snippet.code.split('\n')) expect(lines).toContain(`    ${codeLine}`);
    }
    expect(renderConnect(snippets.filter((snippet) => snippet.group === 'skill')).split('\n')[0]).toBe('Skill');
  });
});
