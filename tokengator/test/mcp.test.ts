import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { LATEST_PROTOCOL_VERSION, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { addAccount, type AccountInput } from '../src/core/accounts.js';
import { briefMarkdown, costsMarkdown, meterRecord, queueText, snapshot } from '../src/core/brief.js';
import { ledgerTotals, viewAccount } from '../src/core/forecast.js';
import { addSpendSource, recordSpend, summariseSpend } from '../src/core/spend.js';
import { DAY, HOUR, MINUTE, iso } from '../src/core/time.js';
import { emptyState, type ClosedCycle, type Price, type State } from '../src/core/types.js';
import { explain, headline } from '../src/core/wording.js';
import type { CollectorHost, CollectorStatus } from '../src/server/collectors/types.js';
import { createMcpHttpHandler, createMcpServer, runMcpStdio, type McpDeps } from '../src/server/mcp.js';
import { TokengatorService } from '../src/server/service.js';
import { FileStateStore, MemoryStateStore, type StateStore } from '../src/server/store.js';

// A local fake preset: the real catalog is data that changes, and these tests are not about it. The
// array is shared with the mock, so a test can empty it in place.
const catalog = vi.hoisted(() => ({
  providers: [] as unknown[],
  fake: {
    id: 'fakeai',
    name: 'FakeAI',
    vendor: 'Fake Labs',
    monogram: 'Fa',
    category: 'other',
    usageUrl: 'https://fake.example/usage',
    howToRead: 'Read the weekly percentage and its reset time under Usage.',
    plans: [
      {
        id: 'pro',
        name: 'Pro',
        price: { amount: 20, currency: 'USD', period: 'month' },
        meters: [
          { key: 'weekly', label: 'Weekly', role: 'allowance', unit: 'percent', reset: { kind: 'interval', hours: 168 } },
          { key: 'session', label: 'Session', role: 'throttle', unit: 'percent', reset: { kind: 'rolling', hours: 5 } }
        ]
      }
    ],
    collectors: ['fake-source']
  }
}));

vi.mock('../src/core/catalog.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/core/catalog.js')>()),
  CATALOG_CHECKED: '2026-01-01',
  CATALOG: catalog.providers
}));

/** Thursday 19 November 2026, 12:00 UTC. */
const NOW = Date.parse('2026-11-19T12:00:00.000Z');
const TZ = 'UTC';
const STAMP = 'As of 12:00 UTC (2026-11-19T12:00:00.000Z).';

const TOOL_NAMES = [
  'what_to_use',
  'list_accounts',
  'get_account',
  'list_catalog',
  'report_usage',
  'quick_update',
  'add_account',
  'update_account',
  'remove_account',
  'refresh_usage',
  'waste_report',
  'record_spend',
  'get_costs'
];
const READ_ONLY = ['what_to_use', 'list_accounts', 'get_account', 'list_catalog', 'waste_report', 'get_costs'];

const usd = (amount: number): Price => ({ amount, currency: 'USD', period: 'month' });
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function build(accounts: AccountInput[]): State {
  let state = emptyState();
  for (const input of accounts) state = addAccount(state, input, NOW).state;
  return state;
}

const CLAUDE: AccountInput = {
  providerId: 'claude',
  label: 'Claude Max',
  plan: 'Max',
  price: usd(100),
  usageUrl: 'https://claude.example/usage',
  notes: 'Shared with the team.',
  meters: [
    // 40% used with ten hours of a week left: the one quota that needs using now.
    { key: 'weekly', label: 'Weekly limit', unit: 'percent', used: 40, reset: { kind: 'interval', hours: 168 }, resetsAt: iso(NOW + 10 * HOUR) },
    { key: 'session', label: '5-hour session', role: 'throttle', unit: 'percent', used: 12, reset: { kind: 'rolling', hours: 5 }, resetsAt: iso(NOW + 3 * HOUR) }
  ]
};
const SUNO: AccountInput = {
  providerId: 'suno',
  label: 'Suno Pro',
  plan: 'Pro',
  price: usd(10),
  meters: [{ key: 'credits', label: 'Credits', unit: 'credits', limit: 2500, reset: { kind: 'interval', hours: 720 } }]
};
// 185 of 300 on day 18.5 of 30 is exactly on pace.
const COPILOT: AccountInput = {
  providerId: 'copilot',
  label: 'Copilot Pro',
  price: usd(10),
  meters: [{ key: 'premium', label: 'Premium requests', unit: 'requests', limit: 300, used: 185, reset: { kind: 'monthly', day: 1, time: '00:00', tz: 'UTC' } }]
};
const team = (label: string): AccountInput => ({
  label,
  meters: [{ key: 'weekly', label: 'Weekly', unit: 'percent', used: 99, reset: { kind: 'interval', hours: 168 }, resetsAt: iso(NOW + 3 * DAY) }]
});

function cycle(accountId: string, key: string, endedAgo: number, wastedFraction: number, wastedValue: number, confidence: ClosedCycle['confidence']): ClosedCycle {
  const endedAt = iso(NOW - endedAgo);
  return {
    id: `${accountId}:${key}:${endedAt}:0`,
    accountId,
    meterId: `${accountId}:${key}`,
    providerId: accountId.split('-')[0] ?? 'custom',
    accountLabel: accountId === 'claude-max' ? 'Claude Max' : 'Suno Pro',
    meterLabel: key === 'weekly' ? 'Weekly limit' : 'Credits',
    unit: key === 'weekly' ? 'percent' : 'credits',
    startedAt: iso(NOW - endedAgo - 7 * DAY),
    endedAt,
    limit: 100,
    used: (1 - wastedFraction) * 100,
    wastedFraction,
    wastedValue,
    currency: 'USD',
    confidence
  };
}

/** Five accounts, a small ledger and one spend source. */
function fixture(): State {
  let state = build([CLAUDE, SUNO, COPILOT, team('Team Alpha'), team('Team Beta')]);
  state = {
    ...state,
    cycles: [
      cycle('claude-max', 'weekly', 40 * DAY, 1, 23, 'estimated'),
      cycle('claude-max', 'weekly', 9 * DAY, 0.5, 11.5, 'estimated'),
      cycle('suno-pro', 'credits', 5 * DAY, 0.1, 1, 'measured'),
      cycle('claude-max', 'weekly', 2 * DAY, 0.25, 5.75, 'measured')
    ]
  };
  const added = addSpendSource(state, { providerId: 'openrouter', label: 'OpenRouter', monthlyBudget: 50 }, NOW);
  state = recordSpend(added.state, added.source.id, { date: '2026-11-03', amount: 12.5 }, NOW, TZ);
  return recordSpend(state, added.source.id, { date: '2026-11-18', amount: 4 }, NOW, TZ);
}

interface Harness {
  client: Client;
  service: TokengatorService;
}

interface Answer {
  text: string;
  data: any;
  isError: boolean;
}

const cleanups: (() => Promise<void> | void)[] = [];

beforeEach(() => {
  catalog.providers.splice(0, catalog.providers.length, catalog.fake);
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function serviceOn(store: StateStore): TokengatorService {
  return new TokengatorService(store, { now: () => NOW, timeZone: TZ });
}

async function connect(options: { state?: State; collectors?: CollectorHost; clientName?: string; service?: TokengatorService } = {}): Promise<Harness> {
  const service = options.service ?? serviceOn(new MemoryStateStore(options.state ?? fixture()));
  const deps: McpDeps = { service, version: '9.9.9' };
  if (options.collectors) deps.collectors = options.collectors;
  const server = createMcpServer(deps);
  const client = new Client({ name: options.clientName ?? 'test-agent', version: '1.0.0' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  await client.connect(clientSide);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  return { client, service };
}

async function call(target: Harness | Client, name: string, args: Record<string, unknown> = {}): Promise<Answer> {
  const client = target instanceof Client ? target : target.client;
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  const first = result.content[0];
  return {
    text: first && first.type === 'text' ? first.text : '',
    data: result.structuredContent ?? null,
    isError: result.isError === true
  };
}

/** Calls a tool that must be refused and proves that nothing was saved. */
async function refused(harness: Harness, name: string, args: Record<string, unknown>): Promise<Answer> {
  const before = JSON.stringify(await harness.service.state());
  const answer = await call(harness, name, args);
  expect(answer.isError).toBe(true);
  expect(answer.data).toBeNull();
  expect(JSON.stringify(await harness.service.state())).toBe(before);
  return answer;
}

async function meterOf(harness: Harness, meterId: string): Promise<State['accounts'][number]['meters'][number]> {
  for (const account of (await harness.service.state()).accounts) {
    const meter = account.meters.find((candidate) => candidate.id === meterId);
    if (meter) return meter;
  }
  throw new Error(`no meter ${meterId}`);
}

function fakeCollectors(statuses: Partial<CollectorStatus>[]): CollectorHost & { refreshed: (string[] | undefined)[] } {
  const full = statuses.map(
    (status): CollectorStatus => ({
      id: 'fake-source',
      providerId: 'fakeai',
      title: 'Fake source',
      description: 'Reads nothing from nowhere.',
      sourceKind: 'documented-api',
      env: ['FAKE_API_KEY'],
      enabled: true,
      available: true,
      reason: null,
      lastRunAt: null,
      lastOutcome: null,
      lastMessage: null,
      lastUpdated: [],
      nextRunAt: null,
      ...status
    })
  );
  const refreshed: (string[] | undefined)[] = [];
  return {
    refreshed,
    list: () => Promise.resolve(full.map((status) => ({ ...status, lastRunAt: null, lastOutcome: null, lastMessage: null, lastUpdated: [] }))),
    setEnabled: () => Promise.reject(new Error('not used')),
    refresh: (ids) => {
      refreshed.push(ids);
      return Promise.resolve(ids ? full.filter((status) => ids.includes(status.id)) : full.filter((status) => status.enabled));
    }
  };
}

// ---------------------------------------------------------------------------

describe('the server', () => {
  it('introduces itself and tells agents the rule about spending quota', async () => {
    const { client } = await connect();
    expect(client.getServerVersion()).toMatchObject({ name: 'tokengator', version: '9.9.9' });
    const instructions = client.getInstructions() ?? '';
    expect(instructions).toContain('never spend quota');
    expect(instructions).toContain('You have no clock');
  });

  it('lists exactly the contract tools, each described and annotated', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([...TOOL_NAMES].sort());

    for (const tool of tools) {
      expect(tool.title, tool.name).toBeTruthy();
      expect((tool.description ?? '').length, tool.name).toBeGreaterThan(80);
      expect(tool.inputSchema.type, tool.name).toBe('object');
      expect(tool.outputSchema?.type, tool.name).toBe('object');
      const hints = tool.annotations ?? {};
      for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'] as const) {
        expect(typeof hints[hint], `${tool.name}.${hint}`).toBe('boolean');
      }
      expect(hints.readOnlyHint, tool.name).toBe(READ_ONLY.includes(tool.name));
      // Only the collectors reach outside the machine.
      expect(hints.openWorldHint, tool.name).toBe(tool.name === 'refresh_usage');
      if (hints.readOnlyHint) expect(hints.destructiveHint, tool.name).toBe(false);
    }
    const hintsOf = (name: string): Record<string, unknown> => tools.find((tool) => tool.name === name)?.annotations ?? {};
    expect(hintsOf('remove_account')).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true });
    expect(hintsOf('update_account')).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    for (const name of ['report_usage', 'quick_update', 'add_account', 'record_spend', 'refresh_usage']) {
      expect(hintsOf(name), name).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false });
    }
  });

  it('publishes the accepted values in the input schemas', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    const schema = (name: string): any => tools.find((tool) => tool.name === name)?.inputSchema;
    expect(schema('what_to_use').properties.limit).toMatchObject({ type: 'integer', minimum: 1, maximum: 50, default: 10 });
    expect(schema('waste_report').properties.days).toMatchObject({ type: 'integer', minimum: 1, maximum: 365, default: 30 });
    expect(schema('report_usage').required).toEqual(['account']);
    expect(schema('report_usage').properties.usedPercent).toMatchObject({ type: 'number', minimum: 0, maximum: 100 });
    expect(schema('report_usage').properties.remainingPercent).toMatchObject({ minimum: 0, maximum: 100 });
    expect(schema('report_usage').additionalProperties).toBe(false);
    expect(schema('record_spend').properties.mode.enum).toEqual(['set', 'add']);
    expect(schema('remove_account').required).toEqual(['account']);
  });
});

describe('what_to_use', () => {
  it('scenario "Choosing a subscription for a large task": the most urgent quota comes first and says what is left and when it resets', async () => {
    const harness = await connect();
    const answer = await call(harness, 'what_to_use');
    expect(answer.isError).toBe(false);

    const first = answer.data.queue[0];
    expect(first).toMatchObject({
      id: 'claude-max:weekly',
      account: 'Claude Max',
      tier: 'use-now',
      remainingPercent: 60,
      resetsInMinutes: 600,
      resetsAt: iso(NOW + 10 * HOUR),
      currency: 'USD',
      stale: false,
      blockedBy: null
    });
    expect(first.valueAtRisk).toBeGreaterThan(0);
    expect(first.requiredPaceMultiple).toBeGreaterThan(1);
    expect(first.recommendation).toContain('Prefer Claude Max');

    const lines = answer.text.split('\n');
    expect(lines[0]).toBe(STAMP);
    expect(lines[1]).toMatch(/^1 quota needs using now/);
    expect(answer.text).toContain('1. Claude Max · Weekly limit: Use now: 60% left, resets in 10h');
    expect(answer.text).toContain('Prefer Claude Max for work the user wants done now');
  });

  it('returns the core snapshot and the core queue text, trimmed as asked', async () => {
    const harness = await connect();
    const state = await harness.service.state();
    const core = json(snapshot(state, NOW, TZ));

    const everything = await call(harness, 'what_to_use', { limit: 50, includeSettled: true });
    expect(everything.data).toEqual({ ...core, omitted: { settled: 0, beyondLimit: 0 } });
    expect(everything.text).toBe(queueText(state, NOW, TZ, 50));
    expect(everything.data.throttles.map((record: any) => record.id)).toEqual(['claude-max:session']);

    // By default the two used-up team quotas are left out of the structured queue.
    const usual = await call(harness, 'what_to_use');
    expect(usual.text).toBe(queueText(state, NOW, TZ, 10));
    expect(usual.data.queue.map((record: any) => record.id)).toEqual(['claude-max:weekly', 'copilot-pro:premium', 'suno-pro:credits']);
    expect(usual.data.omitted).toEqual({ settled: 2, beyondLimit: 0 });
    expect(usual.data.summary).toEqual(core.summary);

    const one = await call(harness, 'what_to_use', { limit: 1 });
    expect(one.data.queue.map((record: any) => record.id)).toEqual(['claude-max:weekly']);
    expect(one.data.omitted).toEqual({ settled: 2, beyondLimit: 2 });
    expect(one.text).toBe(queueText(state, NOW, TZ, 1));
  });

  it('scenario "Nothing at risk": says so and still lists the meters in order', async () => {
    const harness = await connect({ state: build([team('Team Alpha'), COPILOT]) });
    const answer = await call(harness, 'what_to_use', { includeSettled: true });
    expect(answer.isError).toBe(false);
    expect(answer.data.summary).toMatchObject({ useNow: 0, behind: 0, line: 'Nothing is going to waste right now.' });
    expect(answer.text).toContain('Nothing is going to waste right now.');
    expect(answer.data.queue.map((record: any) => [record.id, record.tier])).toEqual([
      ['copilot-pro:premium', 'on-pace'],
      ['team-alpha:weekly', 'spent']
    ]);
    expect(answer.text).toContain('1. Copilot Pro · Premium requests: On pace: 115 requests left, resets in 11d');
    expect(answer.text).toContain('2. Team Alpha · Weekly: Used up: resets in 3d');
  });

  it('answers an empty state by pointing at add_account', async () => {
    const harness = await connect({ state: emptyState() });
    const answer = await call(harness, 'what_to_use');
    expect(answer.data.queue).toEqual([]);
    expect(answer.text).toContain('No subscriptions are tracked yet. Add one with add_account.');
  });

  it.each([0, 51, 2.5, 'ten'])('refuses limit %j with a message naming the field', async (limit) => {
    const harness = await connect();
    const answer = await refused(harness, 'what_to_use', { limit });
    expect(answer.text).toContain('limit');
  });
});

describe('reading tools', () => {
  it('list_accounts returns every account with every meter as a core record, plus price and usage page', async () => {
    const harness = await connect();
    const state = await harness.service.state();
    const answer = await call(harness, 'list_accounts');

    expect(answer.data.generatedAt).toBe(iso(NOW));
    expect(answer.data.timeZone).toBe(TZ);
    expect(answer.data.accounts.map((account: any) => account.id)).toEqual(['claude-max', 'suno-pro', 'copilot-pro', 'team-alpha', 'team-beta']);
    for (const account of state.accounts) {
      const listed = answer.data.accounts.find((candidate: any) => candidate.id === account.id);
      expect(listed.meters).toEqual(json(viewAccount(account, NOW).map((view) => meterRecord(view, NOW))));
      expect(listed.price).toEqual(account.price);
      expect(listed.usageUrl).toBe(account.usageUrl);
    }
    expect(answer.data.accounts[0]).toMatchObject({ label: 'Claude Max', provider: 'claude', plan: 'Max', price: usd(100), usageUrl: 'https://claude.example/usage' });

    expect(answer.text.split('\n')[0]).toBe(STAMP);
    expect(answer.text).toContain('Claude Max (id: claude-max, plan Max, $100 a month) https://claude.example/usage');
    expect(answer.text).toContain('- Weekly limit [weekly]: Use now: 60% left, resets in 10h');
    expect(answer.text).toContain('- Credits [credits]: Reset time unknown: 2,500 credits left (no reading yet)');
  });

  it('list_accounts filters by provider and says so when nothing matches', async () => {
    const harness = await connect();
    const some = await call(harness, 'list_accounts', { provider: 'Suno' });
    expect(some.data.accounts.map((account: any) => account.id)).toEqual(['suno-pro']);

    const none = await call(harness, 'list_accounts', { provider: 'midjourney' });
    expect(none.isError).toBe(false);
    expect(none.data.accounts).toEqual([]);
    expect(none.text).toContain('No account of provider "midjourney" is tracked. Tracked providers: claude, suno, copilot, custom.');
  });

  it('get_account returns the meters in full: records, samples, finished windows and notes', async () => {
    const harness = await connect();
    const state = await harness.service.state();
    const answer = await call(harness, 'get_account', { account: 'claude' });
    expect(answer.isError).toBe(false);
    expect(answer.data.account).toMatchObject({ id: 'claude-max', notes: 'Shared with the team.', price: usd(100), snoozedUntil: null });

    const claude = state.accounts[0];
    if (!claude) throw new Error('fixture');
    const views = viewAccount(claude, NOW);
    const [weekly, session] = answer.data.meters;
    expect(weekly).toMatchObject(json(meterRecord(views[0]!, NOW)));
    expect(weekly.explanation).toBe(explain(views[0]!, NOW));
    expect(weekly.samples).toEqual([{ t: iso(NOW), used: 40 }]);
    expect(weekly.reset).toEqual({ kind: 'interval', hours: 168 });
    // Oldest first, including the window that ended before the ledger's 30-day totals begin.
    expect(weekly.cycles.map((entry: any) => [entry.endedAt, entry.unusedPercent, entry.lostValue, entry.confidence])).toEqual([
      [iso(NOW - 40 * DAY), 100, 23, 'estimated'],
      [iso(NOW - 9 * DAY), 50, 11.5, 'estimated'],
      [iso(NOW - 2 * DAY), 25, 5.75, 'measured']
    ]);
    expect(session).toMatchObject({ id: 'claude-max:session', role: 'throttle', tier: 'open', cycles: [] });

    expect(answer.text.split('\n')[0]).toBe(STAMP);
    expect(answer.text).toContain('Notes: Shared with the team.');
    expect(answer.text).toContain('Usage page: https://claude.example/usage');
    expect(answer.text).toContain(`**${headline(views[0]!, NOW)}**`);
    expect(answer.text).toContain('Finished windows on record: 3. Unused at each reset, oldest first: 100%, 50%, 25%.');
  });

  it('get_account resolves ids and loose words, and lists candidates when the name is ambiguous or unknown', async () => {
    const harness = await connect();
    expect((await call(harness, 'get_account', { account: 'copilot-pro' })).data.account.id).toBe('copilot-pro');
    expect((await call(harness, 'get_account', { account: 'Suno Pro' })).data.account.id).toBe('suno-pro');

    const ambiguous = await call(harness, 'get_account', { account: 'team' });
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.text).toContain('account id: team-alpha');
    expect(ambiguous.text).toContain('account id: team-beta');
    // A read has nothing to undo, so it does not claim to have left things alone.
    expect(ambiguous.text).not.toContain('Nothing was changed');

    const unknown = await call(harness, 'get_account', { account: 'midjourney' });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toContain('No account matches "midjourney".');
    expect(unknown.text).toContain('- Claude Max (account id: claude-max)');
  });

  it('scenario "Catalog tells an agent where to look": a provider entry carries its usage page and what to read there', async () => {
    const harness = await connect();
    const answer = await call(harness, 'list_catalog', { provider: 'fakeai' });
    expect(answer.isError).toBe(false);
    expect(answer.data.checked).toBe('2026-01-01');
    expect(answer.data.providers).toHaveLength(1);
    expect(answer.data.providers[0]).toMatchObject({
      id: 'fakeai',
      name: 'FakeAI',
      category: 'other',
      usageUrl: 'https://fake.example/usage',
      howToRead: 'Read the weekly percentage and its reset time under Usage.',
      collectors: ['fake-source']
    });
    expect(answer.data.providers[0].plans).toEqual([
      {
        id: 'pro',
        name: 'Pro',
        price: usd(20),
        note: null,
        meters: [
          { key: 'weekly', label: 'Weekly', role: 'allowance', unit: 'percent', unitLabel: null, limit: 100, reset: { kind: 'interval', hours: 168 }, renewsOnBillingDay: false, rollover: 'none' },
          { key: 'session', label: 'Session', role: 'throttle', unit: 'percent', unitLabel: null, limit: 100, reset: { kind: 'rolling', hours: 5 }, renewsOnBillingDay: false, rollover: 'none' }
        ]
      }
    ]);
    expect(answer.text).toContain('Usage page: https://fake.example/usage');
    expect(answer.text).toContain('What to read there: Read the weekly percentage and its reset time under Usage.');
    expect(answer.text).toContain('Catalog checked 2026-01-01');
    expect(answer.text).toContain('- Weekly [weekly]: allowance, percent only, resets every 168h');

    // The provider's display name works as well as its id.
    expect((await call(harness, 'list_catalog', { provider: 'FakeAI' })).data.providers[0].id).toBe('fakeai');
  });

  it('list_catalog without a provider is a compact list that mentions when the catalog was checked', async () => {
    const harness = await connect();
    const answer = await call(harness, 'list_catalog');
    expect(answer.data).toEqual({
      checked: '2026-01-01',
      known: ['fakeai'],
      providers: [
        {
          id: 'fakeai',
          name: 'FakeAI',
          vendor: 'Fake Labs',
          category: 'other',
          usageUrl: 'https://fake.example/usage',
          collectors: ['fake-source'],
          plans: [{ id: 'pro', name: 'Pro', price: usd(20) }]
        }
      ]
    });
    expect(answer.text).toContain('checked 2026-01-01');
    expect(answer.text).toContain('- fakeai: FakeAI (other); plans pro; usage page https://fake.example/usage');
    expect(answer.text).toContain('add_account and a custom definition');
  });

  it('list_catalog still answers for an unknown provider and for an empty catalog, and says how to add a custom account', async () => {
    const harness = await connect();
    const unknown = await call(harness, 'list_catalog', { provider: 'nosuch' });
    expect(unknown.isError).toBe(false);
    expect(unknown.data).toEqual({ checked: '2026-01-01', known: ['fakeai'], providers: [] });
    expect(unknown.text).toContain('No preset for "nosuch". Known providers: fakeai.');
    expect(unknown.text).toContain('add_account and a custom definition');

    catalog.providers.length = 0;
    for (const args of [{}, { provider: 'fakeai' }]) {
      const empty = await call(harness, 'list_catalog', args);
      expect(empty.isError).toBe(false);
      expect(empty.data).toEqual({ checked: '2026-01-01', known: [], providers: [] });
      expect(empty.text).toContain('The catalog has no presets.');
      expect(empty.text).toContain('add_account and a custom definition: a label and one or more meters');
    }
  });

  it('waste_report totals the ledger and breaks it down per meter in a Markdown table', async () => {
    const harness = await connect();
    const state = await harness.service.state();
    const totals = ledgerTotals(state.cycles, NOW, 30);
    const answer = await call(harness, 'waste_report');

    expect(answer.data).toMatchObject({
      generatedAt: iso(NOW),
      days: 30,
      windows: 3,
      utilisationPercent: 71.7,
      lost: totals.lost30,
      lostIsEstimate: true
    });
    expect(answer.data.lost).toEqual({ USD: 18.25 });
    expect(answer.data.meters).toHaveLength(2);
    expect(answer.data.meters[0]).toMatchObject({
      meterId: 'claude-max:weekly',
      account: 'Claude Max',
      meter: 'Weekly limit',
      windows: 2,
      averageUnusedPercent: 37.5,
      lost: { USD: 17.25 },
      estimated: true
    });
    expect(answer.data.meters[0].recent.map((entry: any) => entry.unusedPercent)).toEqual([50, 25]);
    expect(answer.data.meters[1]).toMatchObject({ meterId: 'suno-pro:credits', windows: 1, averageUnusedPercent: 10, lost: { USD: 1 }, estimated: false });

    const lines = answer.text.split('\n');
    expect(lines[0]).toBe(STAMP);
    expect(lines[1]).toBe('Last 30 days: 3 finished windows, 72% of the quota used on average, about $18.25 expired unused.');
    expect(answer.text).toContain('| Subscription | Meter | Windows | Unused on average | Expired value |');
    expect(answer.text).toContain('| Claude Max | Weekly limit | 2 | 38% | $17.25 |');
    expect(answer.text).toContain('| Suno Pro | Credits | 1 | 10% | $1.00 |');
  });

  it('waste_report honours days and refuses a range it does not accept', async () => {
    const harness = await connect();
    const week = await call(harness, 'waste_report', { days: 7 });
    expect(week.data).toMatchObject({ days: 7, windows: 2, lost: { USD: 6.75 }, lostIsEstimate: false });

    const year = await call(harness, 'waste_report', { days: 365 });
    expect(year.data).toMatchObject({ windows: 4, lost: { USD: 41.25 } });

    const quiet = await call(harness, 'waste_report', { days: 1 });
    expect(quiet.data).toMatchObject({ windows: 0, utilisationPercent: null, lost: {}, meters: [] });
    expect(quiet.text).toContain('No window finished in the last 1 days');

    for (const days of [0, 366]) expect((await refused(harness, 'waste_report', { days })).text).toContain('days');
  });

  it('get_costs summarises each spend source and prints the shared costs table', async () => {
    const harness = await connect();
    const state = await harness.service.state();
    const source = state.spend[0];
    if (!source) throw new Error('fixture');
    const summary = summariseSpend(source, NOW, TZ);
    const answer = await call(harness, 'get_costs');

    expect(answer.data.monthToDate).toEqual({ USD: 16.5 });
    expect(answer.data.sources).toHaveLength(1);
    expect(answer.data.sources[0]).toMatchObject({
      id: 'openrouter',
      label: 'OpenRouter',
      provider: 'openrouter',
      currency: 'USD',
      monthlyBudget: 50,
      monthToDate: 16.5,
      projected: Math.round(summary.projected * 100) / 100,
      budgetPercent: 33,
      overBudget: false,
      headingOver: false,
      recentDays: [
        { date: '2026-11-03', amount: 12.5 },
        { date: '2026-11-18', amount: 4 }
      ]
    });
    expect(answer.text).toBe(`${STAMP}\n\n${costsMarkdown(state, NOW, TZ)}`);
    expect(answer.text).toContain('| OpenRouter | $16.50 |');

    const none = await call(await connect({ state: emptyState() }), 'get_costs');
    expect(none.data).toMatchObject({ monthToDate: {}, sources: [] });
    expect(none.text).toContain('No API spend sources are tracked.');
  });
});

describe('report_usage', () => {
  it('scenario "Agent reads a usage page": updates the meter, marks it as reported by the agent and states the new forecast', async () => {
    const harness = await connect();
    const resetsAt = iso(NOW + 9 * DAY);
    const answer = await call(harness, 'report_usage', { account: 'suno', remaining: 1200, resetsAt, note: 'usage page' });
    expect(answer.isError).toBe(false);

    const stored = await meterOf(harness, 'suno-pro:credits');
    expect(stored).toMatchObject({ used: 1300, resetsAt, updatedAt: iso(NOW), source: { kind: 'agent', id: 'test-agent', note: 'usage page' } });

    const account = (await harness.service.state()).accounts.find((candidate) => candidate.id === 'suno-pro');
    if (!account) throw new Error('fixture');
    const view = viewAccount(account, NOW)[0]!;
    expect(answer.data).toEqual({
      accountId: 'suno-pro',
      meterId: 'suno-pro:credits',
      meter: json(meterRecord(view, NOW)),
      explanation: explain(view, NOW)
    });
    expect(answer.data.meter).toMatchObject({ used: 1300, remaining: 1200, source: 'agent:test-agent', resetsInMinutes: 9 * 24 * 60, tier: 'behind' });
    expect(answer.text.split('\n')).toEqual([
      STAMP,
      'Recorded, reported by agent "test-agent".',
      `Suno Pro · Credits: ${headline(view, NOW)}`,
      explain(view, NOW)
    ]);
    expect(answer.text).toContain('Behind pace');
    expect(answer.text).toContain('resets in 9d');
  });

  it('accepts each way of giving an amount, a countdown, and a meter by key, label or id', async () => {
    const harness = await connect();

    const byKey = await call(harness, 'report_usage', { account: 'claude-max', meter: 'session', usedPercent: 80, resetsInMinutes: 90 });
    expect(byKey.data.meter).toMatchObject({ id: 'claude-max:session', usedPercent: 80, resetsAt: iso(NOW + 90 * MINUTE), source: 'agent:test-agent' });

    const byLabel = await call(harness, 'report_usage', { account: 'claude', meter: 'Weekly limit', remainingPercent: 25 });
    expect(byLabel.data.meter).toMatchObject({ id: 'claude-max:weekly', usedPercent: 75 });

    const byId = await call(harness, 'report_usage', { account: 'copilot', meter: 'copilot-pro:premium', used: 200 });
    expect(byId.data.meter).toMatchObject({ id: 'copilot-pro:premium', used: 200, remaining: 100 });

    const withLimit = await call(harness, 'report_usage', { account: 'copilot', used: 150, limit: 1500 });
    expect(withLimit.data.meter).toMatchObject({ limit: 1500, used: 150, usedPercent: 10 });

    // A reset alone moves the window and leaves the amount as it was.
    const resetOnly = await call(harness, 'report_usage', { account: 'claude', resetsAt: '2026-11-20T01:00:00+01:00' });
    expect(resetOnly.data.meter).toMatchObject({ id: 'claude-max:weekly', usedPercent: 75, resetsAt: '2026-11-20T00:00:00.000Z' });
  });

  it('finds a meter by its own name even when the account label contains the same word', async () => {
    const harness = await connect({
      state: build([
        {
          label: 'Max Plan',
          meters: [
            { key: 'weekly', label: 'Weekly', unit: 'percent', reset: { kind: 'interval', hours: 168 }, resetsAt: iso(NOW + 2 * DAY) },
            { key: 'max-burst', label: 'Max burst', role: 'throttle', unit: 'percent', reset: { kind: 'rolling', hours: 5 } }
          ]
        }
      ])
    });
    const answer = await call(harness, 'report_usage', { account: 'max-plan', meter: 'max', usedPercent: 30 });
    expect(answer.data.meterId).toBe('max-plan:max-burst');
    expect((await meterOf(harness, 'max-plan:weekly')).used).toBe(0);
  });

  it('scenario "Ambiguous account": changes nothing and lists the candidates with their ids', async () => {
    const harness = await connect();
    const answer = await refused(harness, 'report_usage', { account: 'team', usedPercent: 50 });
    expect(answer.text).toContain('matches more than one meter');
    expect(answer.text).toContain('Nothing was changed.');
    expect(answer.text).toContain('- Team Alpha · Weekly (account id: team-alpha, meter id: team-alpha:weekly)');
    expect(answer.text).toContain('- Team Beta · Weekly (account id: team-beta, meter id: team-beta:weekly)');

    // Naming one of the candidates by its id goes through.
    const retry = await call(harness, 'report_usage', { account: 'team-beta', usedPercent: 50 });
    expect(retry.data.meter).toMatchObject({ id: 'team-beta:weekly', usedPercent: 50 });
    expect((await meterOf(harness, 'team-alpha:weekly')).used).toBe(99);
  });

  it('scenario "Unknown meter": changes nothing and lists the meters of the account', async () => {
    const harness = await connect();
    const answer = await refused(harness, 'report_usage', { account: 'claude', meter: 'bogus', usedPercent: 50 });
    expect(answer.text).toContain('No meter of Claude Max matches "bogus". Nothing was changed.');
    expect(answer.text).toContain('- Claude Max · Weekly limit (account id: claude-max, meter id: claude-max:weekly)');
    expect(answer.text).toContain('- Claude Max · 5-hour session (account id: claude-max, meter id: claude-max:session)');
    // Only that account's meters: the others are not candidates for a meter name.
    expect(answer.text).not.toContain('Suno');
  });

  it('scenario "Invalid percentage": a used percentage of 140 is an error naming the field and the accepted range', async () => {
    const harness = await connect();
    const answer = await refused(harness, 'report_usage', { account: 'suno', usedPercent: 140 });
    expect(answer.text).toContain('usedPercent');
    expect(answer.text).toContain('must be a percentage from 0 to 100');

    const negative = await refused(harness, 'report_usage', { account: 'suno', remainingPercent: -1 });
    expect(negative.text).toContain('remainingPercent');
    expect(negative.text).toContain('0 to 100');
  });

  it.each([
    [{ account: 'suno', used: 5, remaining: 3 }, ['remaining', 'not used and remaining']],
    [{ account: 'suno' }, ['Give an amount', 'resetsInMinutes']],
    [{ account: 'suno', limit: 3000 }, ['Give an amount']],
    [{ account: 'suno', used: 1, resetsAt: iso(NOW + DAY), resetsInMinutes: 5 }, ['resetsInMinutes', 'not both']],
    [{ account: 'suno', used: 1, resetsAt: 'tomorrow 9am' }, ['resetsAt', 'ISO 8601 instant with a time zone', 'It is now 12:00 UTC']],
    [{ account: 'suno', used: 1, resetsAt: '2026-11-21T09:00:00' }, ['resetsAt', 'time zone']],
    [{ account: 'suno', used: 1, resetsAt: '2026-11-01T00:00:00Z' }, ['resetsAt', 'in the past', 'It is now 12:00 UTC (2026-11-19T12:00:00.000Z)']],
    [{ account: 'suno', used: -1 }, ['used', '0 or more']],
    [{ account: 'suno', usedPercent: '62' }, ['usedPercent', 'expected number']],
    [{ account: 'suno', percent: 62 }, ['percent']],
    [{ usedPercent: 62 }, ['account']],
    [{ account: '   ', usedPercent: 62 }, ['account']]
  ])('refuses %j and says why', async (args, expected) => {
    const harness = await connect();
    const answer = await refused(harness, 'report_usage', args);
    for (const part of expected) expect(answer.text).toContain(part);
  });

  it('names the reporting client, and falls back to "mcp" when the name is unusable', async () => {
    const named = await connect({ clientName: 'Claude Code' });
    expect((await call(named, 'report_usage', { account: 'suno', used: 10 })).data.meter.source).toBe('agent:Claude Code');

    const unnamed = await connect({ clientName: '\u0007\n' });
    const answer = await call(unnamed, 'report_usage', { account: 'suno', used: 10 });
    expect(answer.data.meter.source).toBe('agent:mcp');
    expect(answer.text).toContain('reported by agent "mcp"');
  });
});

describe('quick_update', () => {
  it('saves a quick-entry line and returns how it was understood with the new forecast', async () => {
    const harness = await connect();
    const answer = await call(harness, 'quick_update', { text: 'claude weekly 62% resets in 9h' });
    expect(answer.isError).toBe(false);
    expect(answer.data.preview).toBe('Claude Max, Weekly limit: 62% used, 38% left · resets today 21:00 (in 9h)');
    expect(answer.data).toMatchObject({ accountId: 'claude-max', meterId: 'claude-max:weekly' });
    expect(answer.data.meter).toMatchObject({ usedPercent: 62, resetsAt: iso(NOW + 9 * HOUR), source: 'agent:test-agent', tier: 'use-now' });
    expect(answer.text.split('\n').slice(0, 3)).toEqual([
      STAMP,
      'Saved: Claude Max, Weekly limit: 62% used, 38% left · resets today 21:00 (in 9h)',
      'Claude Max · Weekly limit: Use now: 38% left, resets in 9h'
    ]);
    expect(await meterOf(harness, 'claude-max:weekly')).toMatchObject({ used: 62, source: { kind: 'agent', id: 'test-agent' } });
  });

  it('refuses what it cannot place and offers the candidates', async () => {
    const harness = await connect();
    const ambiguous = await refused(harness, 'quick_update', { text: 'team 40%' });
    expect(ambiguous.text).toContain('meter id: team-alpha:weekly');
    expect(ambiguous.text).toContain('meter id: team-beta:weekly');

    expect((await refused(harness, 'quick_update', { text: 'claude weekly 162%' })).text).toContain('A percentage must be between 0 and 100. Nothing was changed.');
    expect((await refused(harness, 'quick_update', { text: 'claude weekly 20% resets whenever' })).text).toContain('Did not understand the reset time');
    expect((await refused(harness, 'quick_update', { text: '' })).text).toContain('text');
    expect((await refused(harness, 'quick_update', {})).text).toContain('text');
  });
});

describe('managing accounts', () => {
  it('add_account from a preset creates the account with the preset meters, reported by the agent', async () => {
    const harness = await connect({ state: emptyState() });
    const answer = await call(harness, 'add_account', { provider: 'fakeai' });
    expect(answer.isError).toBe(false);
    expect(answer.data.account).toMatchObject({ id: 'fakeai', label: 'FakeAI', provider: 'fakeai', plan: 'Pro', price: usd(20), usageUrl: 'https://fake.example/usage' });
    expect(answer.data.meters.map((record: any) => [record.id, record.role, record.source])).toEqual([
      ['fakeai:weekly', 'allowance', 'agent:test-agent'],
      ['fakeai:session', 'throttle', 'agent:test-agent']
    ]);
    expect(answer.text).toContain('Added FakeAI (id: fakeai), plan Pro, $20.00 a month.');
    expect(answer.text).toContain('What to read there: Read the weekly percentage and its reset time under Usage.');
    expect(answer.text).toContain('report_usage');
    expect((await harness.service.state()).accounts).toHaveLength(1);

    // A plan by name, a label and a price of one's own.
    const second = await call(harness, 'add_account', { provider: 'FakeAI', plan: 'Pro', label: 'Work FakeAI', price: { amount: 240, currency: 'eur', period: 'year' } });
    expect(second.data.account).toMatchObject({ id: 'work-fakeai', label: 'Work FakeAI', price: { amount: 240, currency: 'EUR', period: 'year' } });

    const free = await call(harness, 'add_account', { provider: 'fakeai', label: 'Free tier', price: null });
    expect(free.data.account).toMatchObject({ label: 'Free tier', price: null });
  });

  it('add_account from a custom definition builds the meters as described', async () => {
    const harness = await connect({ state: emptyState() });
    const answer = await call(harness, 'add_account', {
      plan: 'Creator',
      price: { amount: 22, currency: 'USD', period: 'month' },
      custom: {
        label: 'ElevenLabs',
        usageUrl: 'https://eleven.example/subscription',
        notes: 'Voice work.',
        meters: [
          { label: 'Characters', unit: 'characters', limit: 100000, used: 25000, reset: { kind: 'monthly', day: 3, time: '00:00', tz: 'UTC' } },
          { label: 'Voice slots', key: 'slots', unit: 'count', unitLabel: 'voices', limit: 30, reset: { kind: 'none' }, rollover: 'carries', valueShare: 0 }
        ]
      }
    });
    expect(answer.isError).toBe(false);
    expect(answer.data.account).toMatchObject({
      id: 'elevenlabs',
      provider: 'custom',
      plan: 'Creator',
      price: usd(22),
      usageUrl: 'https://eleven.example/subscription',
      notes: 'Voice work.'
    });
    expect(answer.data.meters[0]).toMatchObject({ id: 'elevenlabs:characters', unit: 'characters', limit: 100000, used: 25000, resetsAt: '2026-12-03T00:00:00.000Z' });
    expect(answer.data.meters[1]).toMatchObject({ id: 'elevenlabs:slots', tier: 'balance', limit: 30 });
    expect(await meterOf(harness, 'elevenlabs:slots')).toMatchObject({ unitLabel: 'voices', rollover: 'carries', valueShare: 0, source: { kind: 'agent', id: 'test-agent' } });
  });

  it.each([
    [{}, ['provider', 'custom']],
    [{ provider: 'fakeai', custom: { label: 'Both', meters: [{ label: 'M', reset: { kind: 'none' } }] } }, ['custom', 'not both']],
    [{ provider: 'nosuch' }, ['provider', 'Unknown provider "nosuch"', 'fakeai']],
    [{ provider: 'fakeai', plan: 'platinum' }, ['plan', 'Unknown plan "platinum"', 'pro']],
    [{ custom: { label: 'No limit', meters: [{ label: 'Chars', unit: 'characters', reset: { kind: 'none' } }] } }, ['custom.meters[0].limit', 'limit is required']],
    [{ custom: { label: 'No hours', meters: [{ label: 'Week', reset: { kind: 'rolling' } }] } }, ['custom.meters[0].reset.hours', 'hours must be a number greater than 0']],
    [{ custom: { label: 'Bad kind', meters: [{ label: 'Week', reset: { kind: 'fortnightly' } }] } }, ['reset.kind']],
    [{ custom: { label: 'Bad zone', meters: [{ label: 'Day', reset: { kind: 'daily', tz: 'Mars/Olympus' } }] } }, ['custom.meters[0].reset.tz', 'Mars/Olympus']],
    [{ custom: { label: 'Bad time', meters: [{ label: 'Day', reset: { kind: 'none' }, resetsAt: 'friday' }] } }, ['custom.meters[0].resetsAt', 'time zone']],
    [{ custom: { label: 'Bad page', usageUrl: 'ftp://example', meters: [{ label: 'M', reset: { kind: 'none' } }] } }, ['custom.usageUrl', 'http://']],
    [{ custom: { label: 'Empty', meters: [] } }, ['custom.meters']],
    [{ provider: 'fakeai', price: { amount: 5, currency: 'dollars', period: 'month' } }, ['price.currency', 'three-letter']],
    [{ provider: 'fakeai', billingDay: 3 }, ['billingDay']]
  ])('add_account refuses %j and names the field', async (args, expected) => {
    const harness = await connect({ state: emptyState() });
    const answer = await refused(harness, 'add_account', args);
    for (const part of expected) expect(answer.text).toContain(part);
  });

  it('update_account changes account fields, the snooze and one meter in a single call', async () => {
    const harness = await connect();
    const answer = await call(harness, 'update_account', {
      account: 'copilot',
      label: 'Copilot Work',
      plan: 'Pro+',
      price: { amount: 39, currency: 'USD', period: 'month' },
      usageUrl: 'https://github.example/billing',
      notes: 'Paid by work.',
      snoozeHours: 24,
      meterPatch: { limit: 1500, label: 'Premium', valueShare: 0.5, rollover: 'carries' }
    });
    expect(answer.isError).toBe(false);
    expect(answer.data.changed).toEqual([
      'label',
      'plan',
      'price',
      'usageUrl',
      'notes',
      'snoozeHours',
      'meterPatch.label',
      'meterPatch.limit',
      'meterPatch.rollover',
      'meterPatch.valueShare'
    ]);
    expect(answer.data.account).toMatchObject({
      id: 'copilot-pro',
      label: 'Copilot Work',
      plan: 'Pro+',
      price: usd(39),
      usageUrl: 'https://github.example/billing',
      notes: 'Paid by work.',
      snoozedUntil: iso(NOW + 24 * HOUR)
    });
    expect(answer.data.meters[0]).toMatchObject({ id: 'copilot-pro:premium', meter: 'Premium', limit: 1500, used: 185, snoozed: true });
    expect(await meterOf(harness, 'copilot-pro:premium')).toMatchObject({ limit: 1500, valueShare: 0.5, rollover: 'carries' });
    expect(answer.text).toContain('Updated Copilot Work (id: copilot-pro): label, plan, price');
    expect(answer.text).toContain('Snoozed until 12:00 UTC (2026-11-20T12:00:00.000Z).');

    // null wakes it up and clears what can be cleared.
    const cleared = await call(harness, 'update_account', { account: 'copilot-pro', snoozeHours: null, plan: null, price: null, usageUrl: null, notes: null });
    expect(cleared.data.account).toMatchObject({ snoozedUntil: null, plan: null, price: null, usageUrl: null, notes: null });
    expect(cleared.data.meters[0].snoozed).toBe(false);
  });

  it('update_account patches a named meter: reset rule, reset time and a corrected amount', async () => {
    const harness = await connect();
    const answer = await call(harness, 'update_account', {
      account: 'claude',
      meter: 'weekly',
      meterPatch: { reset: { kind: 'interval', hours: 336 }, resetsAt: '2026-11-25T12:00:00Z', used: 10 }
    });
    expect(answer.isError).toBe(false);
    expect(answer.data.changed).toEqual(['meterPatch.used', 'meterPatch.reset', 'meterPatch.resetsAt']);
    expect(await meterOf(harness, 'claude-max:weekly')).toMatchObject({ used: 10, reset: { kind: 'interval', hours: 336 }, resetsAt: '2026-11-25T12:00:00.000Z' });
    expect(answer.data.meters[0]).toMatchObject({ id: 'claude-max:weekly', usedPercent: 10, windowHours: 336 });
    // The other meter is left as it was.
    expect((await meterOf(harness, 'claude-max:session')).used).toBe(12);
  });

  it.each([
    [{ account: 'copilot' }, ['Nothing to change']],
    [{ account: 'team', label: 'X' }, ['account id: team-alpha', 'account id: team-beta']],
    [{ account: 'claude', meterPatch: { limit: 5 } }, ['meter', 'Claude Max has: weekly, session']],
    [{ account: 'claude', meter: 'weekly' }, ['meterPatch']],
    [{ account: 'claude', meter: 'weekly', meterPatch: {} }, ['meterPatch is empty']],
    [{ account: 'claude', meter: 'monthly', meterPatch: { limit: 5 } }, ['No meter of Claude Max matches "monthly"', 'meter id: claude-max:weekly']],
    [{ account: 'copilot', usageUrl: 'ftp://example' }, ['usageUrl', 'http://']],
    [{ account: 'copilot', snoozeHours: -2 }, ['snoozeHours']],
    [{ account: 'copilot', meterPatch: { valueShare: 2 } }, ['meterPatch.valueShare']],
    [{ account: 'copilot', meterPatch: { resetsAt: 'next week' } }, ['meterPatch.resetsAt', 'time zone']],
    [{ account: 'copilot', colour: 'blue' }, ['colour']],
    // A valid account change next to a meter change the core rejects: neither may be saved.
    [{ account: 'copilot', label: 'Renamed', meterPatch: { reset: { kind: 'rolling' } } }, ['meterPatch.reset.hours']],
    [{ account: 'copilot', label: 'Renamed', usageUrl: 'nope', meterPatch: { limit: 10 } }, ['usageUrl']]
  ])('update_account refuses %j and leaves everything as it was', async (args, expected) => {
    const harness = await connect();
    const answer = await refused(harness, 'update_account', args);
    for (const part of expected) expect(answer.text).toContain(part);
  });

  it('scenario "Remove without confirmation": removes nothing and names the account and its meters', async () => {
    const harness = await connect();
    for (const args of [{ account: 'claude' }, { account: 'claude', confirm: false }]) {
      const answer = await call(harness, 'remove_account', args);
      // Not an error: the call did what it is meant to do without the confirmation.
      expect(answer.isError).toBe(false);
      expect(answer.data).toEqual({
        removed: false,
        confirmationRequired: true,
        account: { id: 'claude-max', label: 'Claude Max', provider: 'claude', plan: 'Max' },
        meters: [
          { id: 'claude-max:weekly', key: 'weekly', label: 'Weekly limit' },
          { id: 'claude-max:session', key: 'session', label: '5-hour session' }
        ]
      });
      expect(answer.text).toContain('Not removed.');
      expect(answer.text).toContain('Claude Max (id: claude-max)');
      expect(answer.text).toContain('- Weekly limit [weekly]');
      expect(answer.text).toContain('- 5-hour session [session]');
      expect(answer.text).toContain('confirm: true');
      expect((await harness.service.state()).accounts).toHaveLength(5);
    }
  });

  it('remove_account with confirm: true removes the account and keeps its finished windows', async () => {
    const harness = await connect();
    const answer = await call(harness, 'remove_account', { account: 'claude', confirm: true });
    expect(answer.isError).toBe(false);
    expect(answer.data).toMatchObject({ removed: true, confirmationRequired: false, account: { id: 'claude-max' } });
    expect(answer.text).toContain('Removed Claude Max (id: claude-max) and its 2 meters:');

    const state = await harness.service.state();
    expect(state.accounts.map((account) => account.id)).toEqual(['suno-pro', 'copilot-pro', 'team-alpha', 'team-beta']);
    expect(state.cycles.filter((entry) => entry.accountId === 'claude-max')).toHaveLength(3);

    const again = await refused(harness, 'remove_account', { account: 'claude-max', confirm: true });
    expect(again.text).toContain('No account matches "claude-max"');
    expect((await refused(harness, 'remove_account', { account: 'team', confirm: true })).text).toContain('account id: team-beta');
    expect((await refused(harness, 'remove_account', { account: 'suno', confirm: 'yes' })).text).toContain('confirm');
  });
});

describe('refresh_usage', () => {
  it('scenario "Refresh": runs the enabled collectors once and lists updated meters and failure reasons', async () => {
    const collectors = fakeCollectors([
      { id: 'fake-source', title: 'Fake source', lastRunAt: iso(NOW), lastOutcome: 'ok', lastUpdated: ['claude-max:weekly', 'claude-max:session'] },
      {
        id: 'fake-api',
        title: 'Fake API',
        lastRunAt: iso(NOW),
        lastOutcome: 'auth',
        // A careless upstream message: the key must not reach the model.
        lastMessage: 'FAKE_API_KEY was rejected (sent Bearer sk-live-abcdefghijklmnop1234)'
      },
      { id: 'fake-logs', title: 'Fake logs', lastRunAt: iso(NOW), lastOutcome: 'unavailable', lastMessage: 'Nothing to read right now.' },
      { id: 'fake-off', title: 'Fake off', enabled: false }
    ]);
    const harness = await connect({ collectors });
    const answer = await call(harness, 'refresh_usage');
    expect(answer.isError).toBe(false);
    expect(collectors.refreshed).toEqual([undefined]);

    expect(answer.data.available).toBe(true);
    expect(answer.data.ran).toBe(3);
    expect(answer.data.collectors.map((entry: any) => [entry.id, entry.ran, entry.outcome, entry.updatedMeters])).toEqual([
      ['fake-source', true, 'ok', ['claude-max:weekly', 'claude-max:session']],
      ['fake-api', true, 'auth', []],
      ['fake-logs', true, 'unavailable', []]
    ]);
    expect(answer.data.collectors[1].message).toBe('FAKE_API_KEY was rejected (sent [redacted])');

    expect(answer.text.split('\n')).toEqual([
      STAMP,
      'Ran 3 collectors.',
      '- fake-source (Fake source): ok, updated 2 meters: claude-max:weekly, claude-max:session.',
      '- fake-api (Fake API): the credential was rejected. FAKE_API_KEY was rejected (sent [redacted])',
      '- fake-logs (Fake logs): nothing to read. Nothing to read right now.'
    ]);
    expect(JSON.stringify(answer)).not.toContain('sk-live');
  });

  it('runs only the collectors asked for, and never one that is switched off', async () => {
    const collectors = fakeCollectors([
      { id: 'fake-source', lastRunAt: iso(NOW), lastOutcome: 'ok', lastUpdated: [] },
      { id: 'fake-off', title: 'Fake off', enabled: false, reason: 'Set FAKE_OFF_KEY to use it.' }
    ]);
    const harness = await connect({ collectors });

    const one = await call(harness, 'refresh_usage', { collectors: ['fake-source'] });
    expect(collectors.refreshed).toEqual([['fake-source']]);
    expect(one.data.collectors.map((entry: any) => entry.id)).toEqual(['fake-source']);
    expect(one.text).toContain('- fake-source (Fake source): ok, nothing changed.');

    const off = await call(harness, 'refresh_usage', { collectors: ['fake-off'] });
    expect(off.isError).toBe(false);
    expect(off.data).toMatchObject({ ran: 0, collectors: [{ id: 'fake-off', ran: false, outcome: null, enabled: false, updatedMeters: [] }] });
    expect(off.text).toContain('None of the requested collectors is enabled');
    expect(off.text).toContain('- fake-off (Fake off): not run, it is not enabled. Set FAKE_OFF_KEY to use it.');

    const unknown = await call(harness, 'refresh_usage', { collectors: ['nosuch'] });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toContain('Unknown collector "nosuch". Known: fake-source, fake-off.');
    expect(collectors.refreshed).toHaveLength(2);
  });

  it('says so when nothing is enabled and when the process has no collectors at all', async () => {
    const idle = await call(await connect({ collectors: fakeCollectors([{ enabled: false }]) }), 'refresh_usage');
    expect(idle.isError).toBe(false);
    expect(idle.data).toMatchObject({ available: true, ran: 0, collectors: [] });
    expect(idle.text).toContain('No collector is enabled, so nothing was refreshed.');
    expect(idle.text).toContain('report_usage');

    const none = await call(await connect(), 'refresh_usage');
    expect(none.isError).toBe(false);
    expect(none.data).toEqual({ available: false, collectors: [] });
    expect(none.text).toContain('Collectors are not available in this Tokengator process');
    expect(none.text).toContain('report_usage');
  });
});

describe('record_spend', () => {
  it('records a day against an existing source, replacing or adding to its total', async () => {
    const harness = await connect();
    const set = await call(harness, 'record_spend', { source: 'openrouter', amount: 3.2 });
    expect(set.isError).toBe(false);
    expect(set.data).toMatchObject({ created: false, entry: { date: '2026-11-19', amount: 3.2, mode: 'set' }, dayTotal: 3.2 });
    expect(set.data.source).toMatchObject({ id: 'openrouter', monthToDate: 19.7, reportedBy: 'agent:test-agent' });
    expect(set.text.split('\n')[0]).toBe(STAMP);
    expect(set.text).toContain('Recorded $3.20 for OpenRouter on 2026-11-19 (set); that day now totals $3.20.');
    expect(set.text).toContain('Month to date $19.70');
    expect(set.text).toContain('budget $50.00');

    const add = await call(harness, 'record_spend', { source: 'OpenRouter', amount: 1.3, mode: 'add' });
    expect(add.data).toMatchObject({ dayTotal: 4.5, entry: { mode: 'add' } });

    const earlier = await call(harness, 'record_spend', { source: 'open', amount: 20, date: '2026-11-03', mode: 'set' });
    expect(earlier.data).toMatchObject({ dayTotal: 20, entry: { date: '2026-11-03' } });
    expect((await harness.service.state()).spend[0]?.entries).toEqual([
      { date: '2026-11-03', amount: 20 },
      { date: '2026-11-18', amount: 4 },
      { date: '2026-11-19', amount: 4.5 }
    ]);
  });

  it('creates the source first when asked to and nothing matches', async () => {
    const harness = await connect();
    const answer = await call(harness, 'record_spend', { source: 'anthropic api', amount: 7, create: { label: 'Anthropic API', currency: 'eur', monthlyBudget: 5 } });
    expect(answer.isError).toBe(false);
    expect(answer.data).toMatchObject({ created: true, dayTotal: 7 });
    expect(answer.data.source).toMatchObject({ id: 'anthropic-api', label: 'Anthropic API', currency: 'EUR', monthlyBudget: 5, overBudget: true });
    expect(answer.text).toContain('Created spend source Anthropic API (id: anthropic-api).');
    expect(answer.text).toContain('(over)');
    expect((await harness.service.state()).spend.map((source) => source.id)).toEqual(['openrouter', 'anthropic-api']);

    // A name that already matches is used as it is: create is only a fallback.
    const existing = await call(harness, 'record_spend', { source: 'openrouter', amount: 1, create: { label: 'Another OpenRouter' } });
    expect(existing.data).toMatchObject({ created: false, source: { id: 'openrouter' } });
    expect((await harness.service.state()).spend).toHaveLength(2);
  });

  it.each([
    [{ source: 'vertex', amount: 3 }, ['No spend source matches "vertex"', 'Known: openrouter', 'create']],
    [{ source: 'vertex', amount: 3, date: '2026-13-45', create: { label: 'Vertex' } }, ['date']],
    [{ source: 'vertex', amount: 3, date: '19 Nov', create: { label: 'Vertex' } }, ['date', '2026-11-19']],
    [{ source: 'vertex', amount: -3, create: { label: 'Vertex' } }, ['amount', '0 or more']],
    [{ source: 'vertex', amount: 3, mode: 'replace', create: { label: 'Vertex' } }, ['mode']],
    [{ source: 'vertex', amount: 3, create: { label: 'Vertex', currency: 'dollars' } }, ['create.currency']],
    [{ source: 'openrouter' }, ['amount']]
  ])('refuses %j without creating or recording anything', async (args, expected) => {
    const harness = await connect();
    const answer = await refused(harness, 'record_spend', args);
    for (const part of expected) expect(answer.text).toContain(part);
  });

  it('does not create a third source when the name is ambiguous', async () => {
    let state = fixture();
    state = addSpendSource(state, { label: 'OpenRouter batch' }, NOW).state;
    const harness = await connect({ state });
    const answer = await refused(harness, 'record_spend', { source: 'router', amount: 1, create: { label: 'Router' } });
    expect(answer.text).toContain('matches several spend sources: openrouter, openrouter-batch');
  });
});

describe('resources and prompt', () => {
  it('lists the brief and the state with their media types', async () => {
    const { client } = await connect();
    const { resources } = await client.listResources();
    expect(resources.map((resource) => [resource.uri, resource.name, resource.mimeType])).toEqual([
      ['tokengator://brief', 'brief', 'text/markdown'],
      ['tokengator://state', 'state', 'application/json']
    ]);
    for (const resource of resources) expect(resource.description).toBeTruthy();
  });

  it('scenario "Read the brief": the resource is the same Markdown as "copy brief" at that moment', async () => {
    const harness = await connect();
    const expected = briefMarkdown(await harness.service.state(), NOW, TZ);
    const { contents } = await harness.client.readResource({ uri: 'tokengator://brief' });
    expect(contents).toEqual([{ uri: 'tokengator://brief', mimeType: 'text/markdown', text: expected }]);
    expect(expected).toContain('# AI quota brief');
    expect(expected).toContain('| Claude Max | Weekly limit | 60% |');

    // It follows the state: after a report the brief is the brief of the new state.
    await call(harness, 'report_usage', { account: 'claude', usedPercent: 97 });
    const after = await harness.client.readResource({ uri: 'tokengator://brief' });
    expect(after.contents[0]).toMatchObject({ text: briefMarkdown(await harness.service.state(), NOW, TZ) });
    expect(after.contents[0]).not.toMatchObject({ text: expected });
  });

  it('serves the exported state as JSON', async () => {
    const harness = await connect();
    const { contents } = await harness.client.readResource({ uri: 'tokengator://state' });
    const first = contents[0] as { uri: string; mimeType?: string; text: string };
    expect(first.uri).toBe('tokengator://state');
    expect(first.mimeType).toBe('application/json');
    expect(JSON.parse(first.text)).toEqual(json(await harness.service.exportState()));
  });

  it('offers burn_plan with an optional description of the work', async () => {
    const harness = await connect();
    const { prompts } = await harness.client.listPrompts();
    expect(prompts.map((prompt) => prompt.name)).toEqual(['burn_plan']);
    expect(prompts[0]?.arguments).toEqual([expect.objectContaining({ name: 'work', required: false })]);

    const queue = queueText(await harness.service.state(), NOW, TZ);
    const planned = await harness.client.getPrompt({ name: 'burn_plan', arguments: { work: 'refactor the parser' } });
    expect(planned.messages).toHaveLength(1);
    const message = planned.messages[0];
    if (!message || message.content.type !== 'text') throw new Error('expected one text message');
    expect(message.role).toBe('user');
    expect(message.content.text).toContain(queue);
    expect(message.content.text).toContain('What I want to get done: refactor the parser');
    expect(message.content.text).toContain('most urgent first');
    expect(message.content.text).toContain('wait for my choice');
    expect(message.content.text).toContain('do not invent work just to use it up');

    const open = await harness.client.getPrompt({ name: 'burn_plan' });
    const openMessage = open.messages[0];
    if (!openMessage || openMessage.content.type !== 'text') throw new Error('expected one text message');
    expect(openMessage.content.text).toContain(queue);
    expect(openMessage.content.text).toContain('I have not decided what to work on yet.');
    expect(openMessage.content.text).toContain('wait for my choice');
  });
});

describe('what never leaves the machine', () => {
  it('answers an internal failure without its details, and logs it redacted', async () => {
    const secret = 'sk-live-abcdefghijklmnop1234';
    const broken: StateStore = {
      location: 'broken',
      warnings: [],
      read: () => Promise.reject(new Error(`EACCES: /home/someone/.tokengator/state.json (Bearer ${secret})`)),
      update: () => Promise.reject(new Error('unused')),
      onChange: () => () => undefined,
      close: () => undefined
    };
    const logged: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      logged.push(String(chunk));
      return true;
    });
    const harness = await connect({ service: serviceOn(broken) });
    for (const name of ['what_to_use', 'list_accounts', 'get_costs']) {
      const answer = await call(harness, name);
      expect(answer.isError).toBe(true);
      expect(answer.text).toBe('Something went wrong inside Tokengator. The service log has the details.');
    }
    expect(logged.join('')).toContain('MCP tool failed');
    expect(logged.join('')).not.toContain(secret);
  });

  it('keeps environment values out of every tool result, resource and prompt', async () => {
    const secret = 'tg-test-secret-0123456789abcdef';
    vi.stubEnv('TOKENGATOR_TOKEN', secret);
    vi.stubEnv('FAKE_API_KEY', secret);
    try {
      const harness = await connect({ collectors: fakeCollectors([{ lastRunAt: iso(NOW), lastOutcome: 'ok' }]) });
      const outputs: unknown[] = [];
      outputs.push(await call(harness, 'what_to_use'));
      outputs.push(await call(harness, 'list_accounts'));
      outputs.push(await call(harness, 'get_account', { account: 'claude' }));
      outputs.push(await call(harness, 'list_catalog', { provider: 'fakeai' }));
      outputs.push(await call(harness, 'refresh_usage'));
      outputs.push(await call(harness, 'waste_report'));
      outputs.push(await call(harness, 'get_costs'));
      outputs.push(await harness.client.readResource({ uri: 'tokengator://state' }));
      outputs.push(await harness.client.readResource({ uri: 'tokengator://brief' }));
      outputs.push(await harness.client.getPrompt({ name: 'burn_plan' }));
      expect(JSON.stringify(outputs)).not.toContain(secret);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

// ---------------------------------------------------------------------------
// Transports
// ---------------------------------------------------------------------------

/** A bare HTTP server around the handler, parsing the JSON body the way the real service does before it. */
async function listen(deps: McpDeps): Promise<{ url: URL; server: Server }> {
  const handler = createMcpHttpHandler(deps);
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      let body: unknown;
      if (req.method === 'POST') {
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          res.writeHead(400).end();
          return;
        }
      }
      void handler(req, res, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      })
  );
  const { port } = server.address() as AddressInfo;
  return { url: new URL(`http://127.0.0.1:${port}/mcp`), server };
}

async function httpClient(url: URL, name = 'http-agent'): Promise<Client> {
  const client = new Client({ name, version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(url));
  cleanups.push(() => client.close());
  return client;
}

describe('Streamable HTTP', () => {
  it('round trip: a client lists, reads and reports through the stateless handler', async () => {
    const service = serviceOn(new MemoryStateStore(fixture()));
    const { url } = await listen({ service, version: '9.9.9' });
    const client = await httpClient(url);
    expect(client.getServerVersion()).toMatchObject({ name: 'tokengator', version: '9.9.9' });

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([...TOOL_NAMES].sort());

    const queue = await call(client, 'what_to_use');
    expect(queue.isError).toBe(false);
    expect(queue.data.queue[0]).toMatchObject({ id: 'claude-max:weekly', tier: 'use-now' });
    expect(queue.text).toBe(queueText(await service.state(), NOW, TZ, 10));

    const reported = await call(client, 'report_usage', { account: 'suno', remaining: 1200, resetsInMinutes: 60 });
    expect(reported.isError).toBe(false);
    // Each POST gets a fresh server that never saw the handshake, so the reporter is the generic name.
    expect(reported.data.meter).toMatchObject({ id: 'suno-pro:credits', used: 1300, source: 'agent:mcp' });
    const stored = (await service.state()).accounts[1]?.meters[0];
    expect(stored).toMatchObject({ used: 1300, source: { kind: 'agent', id: 'mcp' } });

    const brief = await client.readResource({ uri: 'tokengator://brief' });
    expect(brief.contents[0]).toMatchObject({ text: briefMarkdown(await service.state(), NOW, TZ) });

    const refusedCall = await call(client, 'report_usage', { account: 'suno', usedPercent: 140 });
    expect(refusedCall.isError).toBe(true);
    expect(refusedCall.text).toContain('usedPercent');
  });

  it('answers each POST with plain JSON and no session id', async () => {
    const { url } = await listen({ service: serviceOn(new MemoryStateStore(fixture())) });
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'get_costs', arguments: {} } })
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('mcp-session-id')).toBeNull();
    const body = (await response.json()) as { id: number; result: CallToolResult };
    expect(body.id).toBe(7);
    expect(body.result.structuredContent).toMatchObject({ monthToDate: { USD: 16.5 } });

    // Notifications are accepted and have no answer.
    const notified = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })
    });
    expect(notified.status).toBe(202);
  });

  it.each(['GET', 'DELETE'])('answers %s with 405 and a JSON-RPC error', async (method) => {
    const { url } = await listen({ service: serviceOn(new MemoryStateStore(emptyState())) });
    const response = await fetch(url, { method, headers: { Accept: 'text/event-stream' } });
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      jsonrpc: '2.0',
      error: { code: -32000, message: expect.stringContaining('Method not allowed') },
      id: null
    });
  });

  it('refuses a body that is not JSON-RPC without calling a tool', async () => {
    const service = serviceOn(new MemoryStateStore(fixture()));
    const { url } = await listen({ service });
    const before = JSON.stringify(await service.state());
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ tool: 'remove_account', account: 'claude', confirm: true })
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: number } }).error.code).toBe(-32700);
    expect(JSON.stringify(await service.state())).toBe(before);
  });
});

/** Speaks newline-delimited JSON-RPC to a server over a pair of streams, as a stdio client would. */
class Wire {
  readonly lines: string[] = [];
  private buffer = '';
  private nextId = 1;
  private readonly waiting = new Map<number, (message: any) => void>();
  private readonly input = new PassThrough();
  private readonly output = new PassThrough();

  constructor() {
    this.output.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8');
      for (let end = this.buffer.indexOf('\n'); end >= 0; end = this.buffer.indexOf('\n')) {
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        this.lines.push(line);
        const message = JSON.parse(line) as { id?: number };
        if (typeof message.id === 'number') this.waiting.get(message.id)?.(message);
      }
    });
  }

  async attach(deps: McpDeps, clientName: string): Promise<void> {
    const server = createMcpServer(deps);
    await server.connect(new StdioServerTransport(this.input, this.output));
    cleanups.push(() => server.close());
    const hello = await this.request('initialize', {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: clientName, version: '1.0.0' }
    });
    expect(hello.result.serverInfo.name).toBe('tokengator');
    this.input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  }

  request(method: string, params: unknown): Promise<any> {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }
}

describe('stdio', () => {
  it('serves the same tools over newline-delimited JSON-RPC and writes nothing else', async () => {
    const service = serviceOn(new MemoryStateStore(fixture()));
    const wire = new Wire();
    await wire.attach({ service }, 'stdio-agent');

    const listed = await wire.request('tools/list', {});
    expect(listed.result.tools.map((tool: { name: string }) => tool.name).sort()).toEqual([...TOOL_NAMES].sort());

    const reported = await wire.request('tools/call', { name: 'report_usage', arguments: { account: 'suno', remaining: 1200, resetsInMinutes: 30 } });
    expect(reported.result.isError).toBeUndefined();
    expect(reported.result.structuredContent.meter).toMatchObject({ used: 1300, source: 'agent:stdio-agent' });
    expect(reported.result.content[0].text).toContain('reported by agent "stdio-agent"');

    expect(wire.lines).toHaveLength(3);
    for (const line of wire.lines) expect(JSON.parse(line)).toMatchObject({ jsonrpc: '2.0' });
  });

  it('exports the stdio entry point', () => {
    expect(typeof runMcpStdio).toBe('function');
    expect(runMcpStdio).toHaveLength(1);
  });
});

describe('two transports, one state', () => {
  it('scenarios "Stdio without the service" and "Report over stdio, read over HTTP": both work on the same state file', async () => {
    const home = await mkdtemp(join(tmpdir(), 'tokengator-mcp-'));
    cleanups.push(() => rm(home, { recursive: true, force: true }));
    const open = (): TokengatorService => {
      const store = new FileStateStore(home, { pollMs: 0 });
      cleanups.push(() => store.close());
      return serviceOn(store);
    };

    // The stdio server alone, with nothing else running: its tools work against the stored state.
    const wire = new Wire();
    await wire.attach({ service: open() }, 'stdio-agent');
    const added = await wire.request('tools/call', {
      name: 'add_account',
      arguments: { custom: { label: 'Suno Pro', meters: [{ label: 'Credits', unit: 'credits', limit: 2500, reset: { kind: 'interval', hours: 720 } }] } }
    });
    expect(added.result.isError).toBeUndefined();
    const reported = await wire.request('tools/call', {
      name: 'report_usage',
      arguments: { account: 'suno', remaining: 1200, resetsAt: iso(NOW + 9 * DAY) }
    });
    expect(reported.result.isError).toBeUndefined();

    // A second process's view: the HTTP endpoint of the service, over its own store on the same file.
    const { url } = await listen({ service: open() });
    const client = await httpClient(url);
    const seen = await call(client, 'get_account', { account: 'suno-pro' });
    expect(seen.isError).toBe(false);
    expect(seen.data.meters[0]).toMatchObject({ id: 'suno-pro:credits', used: 1300, resetsAt: iso(NOW + 9 * DAY), source: 'agent:stdio-agent' });

    // And back: what HTTP writes, stdio reads.
    await call(client, 'quick_update', { text: 'suno 2000 used' });
    const back = await wire.request('tools/call', { name: 'what_to_use', arguments: {} });
    expect(back.result.structuredContent.queue[0]).toMatchObject({ id: 'suno-pro:credits', used: 2000, source: 'agent:mcp' });
  });
});
