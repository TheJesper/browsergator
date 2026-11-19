import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { addAccount } from '../src/core/accounts.js';
import { HOUR, iso } from '../src/core/time.js';
import { emptyState, type Account, type Meter, type SpendSource, type State } from '../src/core/types.js';
import type { CollectorHost, CollectorStatus } from '../src/server/collectors/types.js';
import { ConfigError, MAX_BODY_BYTES, VERSION, loadConfig, type ServiceConfig } from '../src/server/config.js';
import { TokengatorHttpServer, type HttpServerOptions, type McpHttpHandler } from '../src/server/http.js';
import { TokengatorService } from '../src/server/service.js';
import { FileStateStore, LockTimeoutError, MemoryStateStore, type StateStore } from '../src/server/store.js';

// A local fake preset: the real catalog is data that changes, and these tests are not about it.
vi.mock('../src/core/catalog.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/core/catalog.js')>()),
  CATALOG_CHECKED: '2026-01-01',
  CATALOG: [
    {
      id: 'fakeai',
      name: 'FakeAI',
      vendor: 'Fake Labs',
      monogram: 'Fa',
      category: 'other',
      usageUrl: 'https://fake.example/usage',
      howToRead: 'Read the weekly percentage.',
      plans: [
        {
          id: 'pro',
          name: 'Pro',
          price: { amount: 20, currency: 'USD', period: 'month' },
          meters: [{ key: 'weekly', label: 'Weekly', role: 'allowance', unit: 'percent', reset: { kind: 'interval', hours: 168 } }]
        }
      ],
      collectors: []
    }
  ]
}));

const NOW = Date.parse('2026-11-19T12:00:00.000Z');
const TOKEN = 'test-token-0123456789abcdef';
const OUTSIDE_SECRET = 'outside-the-public-directory';
const DOTFILE_SECRET = 'inside-a-dotfile';
const JSON_HEADERS = { 'Content-Type': 'application/json' };

let root = '';
let publicDir = '';
let emptyDir = '';

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'tokengator-http-'));
  publicDir = join(root, 'public');
  emptyDir = join(root, 'not-built');
  await mkdir(join(publicDir, 'assets'), { recursive: true });
  await mkdir(emptyDir);
  await writeFile(join(publicDir, 'index.html'), '<!doctype html><title>tg-test-index</title>');
  await writeFile(join(publicDir, 'app.js'), 'console.log("tg-test-app");');
  await writeFile(join(publicDir, 'assets', 'style.css'), 'body{color:red}');
  await writeFile(join(publicDir, 'blob.bin'), 'opaque');
  await writeFile(join(publicDir, '.env'), DOTFILE_SECRET);
  await writeFile(join(root, 'outside.txt'), OUTSIDE_SECRET);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

interface Harness {
  server: TokengatorHttpServer;
  service: TokengatorService;
  base: string;
  port: number;
}

interface StartOptions {
  token?: string | null;
  state?: State;
  store?: StateStore;
  collectors?: CollectorHost;
  mcpHandler?: McpHttpHandler;
  cliCommand?: string;
  publicDir?: string;
  demo?: boolean;
}

const running: TokengatorHttpServer[] = [];

async function start(options: StartOptions = {}): Promise<Harness> {
  const store = options.store ?? new MemoryStateStore(options.state ?? emptyState());
  const service = new TokengatorService(store, { now: () => NOW, timeZone: 'UTC' });
  const config: ServiceConfig = {
    host: '127.0.0.1',
    port: 0,
    token: options.token ?? null,
    home: join(root, 'home'),
    demo: options.demo ?? false
  };
  const serverOptions: HttpServerOptions = { service, config, publicDir: options.publicDir ?? publicDir };
  if (options.collectors) serverOptions.collectors = options.collectors;
  if (options.mcpHandler) serverOptions.mcpHandler = options.mcpHandler;
  if (options.cliCommand) serverOptions.cliCommand = options.cliCommand;
  const server = new TokengatorHttpServer(serverOptions);
  running.push(server);
  const address = await server.listen();
  return { server, service, base: address.url, port: address.port };
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(running.splice(0).map((server) => server.close()));
});

interface RawResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

/** A request with full control over the request line and the Host header, which fetch does not give. */
function raw(
  port: number,
  options: { method?: string; path: string; headers?: Record<string, string>; chunks?: (string | Buffer)[] }
): Promise<RawResponse> {
  return new Promise((done, fail) => {
    const req = request(
      { host: '127.0.0.1', port, method: options.method ?? 'GET', path: options.path, headers: options.headers ?? {}, agent: false },
      (res) => {
        const parts: Buffer[] = [];
        res.on('data', (chunk: Buffer) => parts.push(chunk));
        res.on('end', () => done({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(parts).toString('utf8') }));
        res.on('error', fail);
      }
    );
    req.on('error', fail);
    for (const chunk of options.chunks ?? []) req.write(chunk);
    req.end();
  });
}

function send(harness: Harness, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
  const init: RequestInit = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.headers = { ...JSON_HEADERS, ...headers };
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  return fetch(`${harness.base}${path}`, init);
}

interface ErrorAnswer {
  error: { code: string; message: string; field?: string; candidates?: { accountId: string; meterId: string | null; label: string }[] };
}

async function errorOf(response: Response): Promise<ErrorAnswer['error']> {
  return ((await response.json()) as ErrorAnswer).error;
}

interface StateAnswer {
  state: State;
  now: string;
  timeZone: string;
  version: string;
  demo: boolean;
  collectors: CollectorStatus[];
  warnings: string[];
  cli: string;
  tokenRequired: boolean;
}

async function readState(harness: Harness, headers: Record<string, string> = {}): Promise<StateAnswer> {
  const response = await send(harness, 'GET', '/api/state', undefined, headers);
  expect(response.status).toBe(200);
  return (await response.json()) as StateAnswer;
}

function percentAccount(label: string): Record<string, unknown> {
  return {
    providerId: 'custom',
    label,
    price: { amount: 100, currency: 'USD', period: 'month' },
    meters: [{ key: 'weekly', label: 'Weekly', unit: 'percent', reset: { kind: 'interval', hours: 168 } }]
  };
}

function fakeCollectors(): CollectorHost & { refreshed: (string[] | undefined)[] } {
  const status: CollectorStatus = {
    id: 'fake-source',
    providerId: 'fakeai',
    title: 'Fake source',
    description: 'Reads nothing from nowhere.',
    sourceKind: 'documented-api',
    env: ['FAKE_API_KEY'],
    enabled: false,
    available: true,
    reason: null,
    lastRunAt: null,
    lastOutcome: null,
    lastMessage: null,
    lastUpdated: [],
    nextRunAt: null
  };
  const refreshed: (string[] | undefined)[] = [];
  return {
    refreshed,
    list: () => Promise.resolve([{ ...status }]),
    setEnabled: (_id, enabled) => {
      status.enabled = enabled;
      return Promise.resolve({ ...status });
    },
    refresh: (ids) => {
      refreshed.push(ids);
      status.lastOutcome = 'ok';
      status.lastRunAt = iso(NOW);
      return Promise.resolve([{ ...status }]);
    }
  };
}

/** Reads a server-sent event stream one block at a time. */
async function openEvents(harness: Harness, headers: Record<string, string> = {}): Promise<{
  response: Response;
  next: () => Promise<string | null>;
  cancel: () => Promise<void>;
}> {
  const response = await fetch(`${harness.base}/api/events`, { headers });
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  return {
    response,
    next: async () => {
      for (;;) {
        const boundary = buffered.indexOf('\n\n');
        if (boundary >= 0) {
          const block = buffered.slice(0, boundary);
          buffered = buffered.slice(boundary + 2);
          return block;
        }
        if (!reader) return null;
        const chunk = await reader.read().catch(() => ({ done: true as const, value: undefined }));
        if (chunk.done) return null;
        buffered += decoder.decode(chunk.value, { stream: true });
      }
    },
    cancel: async () => {
      await reader?.cancel().catch(() => undefined);
    }
  };
}

function revisionOf(block: string | null): number {
  const data = /^data: (.*)$/m.exec(block ?? '');
  return (JSON.parse(data?.[1] ?? '{}') as { revision: number }).revision;
}

async function until(condition: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('condition was not met in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// ---------------------------------------------------------------------------

describe('Loopback by default', () => {
  it('defaults to 127.0.0.1 port 4777 with no token (scenario: Default start)', () => {
    const config = loadConfig({});
    expect(config).toMatchObject({ host: '127.0.0.1', port: 4777, token: null });
  });

  it('listens on loopback and reports the address to open (scenario: Default start)', async () => {
    const harness = await start();
    const address = harness.server.server.address() as AddressInfo;
    expect(address.address).toBe('127.0.0.1');
    expect(harness.port).toBe(address.port);
    expect(harness.base).toBe(`http://127.0.0.1:${address.port}`);
    const health = await fetch(`${harness.base}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: 'ok', service: 'tokengator', version: VERSION });
  });

  it('refuses a non-loopback address without a token (scenario: Exposed without a token)', () => {
    expect(() => loadConfig({ TOKENGATOR_HOST: '0.0.0.0' })).toThrow(ConfigError);
    expect(() => loadConfig({ TOKENGATOR_HOST: '0.0.0.0' })).toThrow(/token/i);
    expect(() => loadConfig({}, { host: '192.168.1.20' })).toThrow(ConfigError);
    expect(loadConfig({ TOKENGATOR_HOST: '0.0.0.0', TOKENGATOR_TOKEN: TOKEN })).toMatchObject({ host: '0.0.0.0', token: TOKEN });
  });
});

describe('Request validation', () => {
  it('answers a foreign Host with 403 and no data on every route (scenario: DNS rebinding attempt)', async () => {
    const calls: string[] = [];
    const harness = await start({
      state: addAccount(emptyState(), percentAccount('Secret Plan') as never, NOW).state,
      mcpHandler: (_req, res) => {
        calls.push('mcp');
        res.end('{}');
        return Promise.resolve();
      }
    });
    for (const path of ['/', '/app.js', '/healthz', '/api/state', '/api/export', '/api/events', '/mcp']) {
      const answer = await raw(harness.port, { path, headers: { Host: 'evil.example' } });
      expect(answer.status, path).toBe(403);
      expect(answer.body, path).not.toContain('Secret Plan');
      expect(answer.body, path).not.toContain('tg-test');
      expect((JSON.parse(answer.body) as ErrorAnswer).error.code, path).toBe('forbidden');
    }
    const write = await raw(harness.port, {
      method: 'POST',
      path: '/api/accounts',
      headers: { Host: `evil.example:${harness.port}`, ...JSON_HEADERS },
      chunks: [JSON.stringify(percentAccount('Injected'))]
    });
    expect(write.status).toBe(403);
    expect((await readState(harness)).state.accounts.map((account) => account.label)).toEqual(['Secret Plan']);
    expect(calls).toEqual([]);
  });

  it('accepts its own names and rejects the wrong port or a missing Host', async () => {
    const harness = await start();
    for (const host of [`localhost:${harness.port}`, `127.0.0.1:${harness.port}`, `[::1]:${harness.port}`]) {
      expect((await raw(harness.port, { path: '/healthz', headers: { Host: host } })).status, host).toBe(200);
    }
    expect((await raw(harness.port, { path: '/healthz', headers: { Host: `localhost:${harness.port + 1}` } })).status).toBe(403);
    expect((await raw(harness.port, { path: '/healthz', headers: { Host: 'localhost' } })).status).toBe(403);
  });

  it('answers a write from another origin with 403 and changes nothing (scenario: Cross-site write)', async () => {
    const harness = await start();
    const response = await send(harness, 'POST', '/api/accounts', percentAccount('Injected'), { Origin: 'https://evil.example' });
    expect(response.status).toBe(403);
    expect((await errorOf(response)).code).toBe('forbidden');
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect((await readState(harness)).state.accounts).toEqual([]);
  });

  it('applies the origin check to every method on the API and to /mcp, but not to the page itself', async () => {
    const harness = await start({
      mcpHandler: (_req, res) => {
        res.end('{}');
        return Promise.resolve();
      }
    });
    const foreign = { Origin: 'https://evil.example' };
    expect((await send(harness, 'GET', '/api/state', undefined, foreign)).status).toBe(403);
    expect((await send(harness, 'DELETE', '/api/accounts/x', undefined, foreign)).status).toBe(403);
    expect((await send(harness, 'OPTIONS', '/api/accounts', undefined, foreign)).status).toBe(403);
    expect((await send(harness, 'POST', '/mcp', { jsonrpc: '2.0' }, foreign)).status).toBe(403);
    expect((await send(harness, 'GET', '/api/state', undefined, { 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
    expect((await send(harness, 'GET', '/mcp', undefined, { 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
    // Another port on localhost is another application.
    expect((await send(harness, 'GET', '/api/state', undefined, { Origin: `http://127.0.0.1:${harness.port + 1}` })).status).toBe(403);
    // Following a link from another site to the dashboard must still load it.
    expect((await send(harness, 'GET', '/', undefined, { ...foreign, 'Sec-Fetch-Site': 'cross-site' })).status).toBe(200);
    expect((await send(harness, 'GET', '/healthz', undefined, foreign)).status).toBe(200);
  });

  it('accepts a write from its own origin', async () => {
    const harness = await start();
    const response = await send(harness, 'POST', '/api/accounts', percentAccount('Mine'), {
      Origin: harness.base,
      'Sec-Fetch-Site': 'same-origin'
    });
    expect(response.status).toBe(201);
  });

  it('answers a 300 KB body with 413 and changes nothing (scenario: Oversized body)', async () => {
    const harness = await start();
    const account = { ...percentAccount('Too big'), notes: 'x'.repeat(300 * 1024) };
    const response = await send(harness, 'POST', '/api/accounts', account);
    expect(response.status).toBe(413);
    expect((await errorOf(response)).code).toBe('too_large');
    expect((await readState(harness)).state.accounts).toEqual([]);
    // Exactly at the cap is still accepted for parsing.
    const atCap = await send(harness, 'POST', '/api/quick', `{"text":"${'a'.repeat(MAX_BODY_BYTES - 11)}"}`);
    expect(atCap.status).toBe(400);
  });

  it('caps a body sent without a declared length while it streams', async () => {
    const harness = await start();
    const chunk = Buffer.alloc(64 * 1024, 0x20);
    const answer = await raw(harness.port, {
      method: 'POST',
      path: '/api/import',
      headers: { Host: `127.0.0.1:${harness.port}`, ...JSON_HEADERS, 'Transfer-Encoding': 'chunked' },
      chunks: [chunk, chunk, chunk, chunk, chunk]
    });
    expect(answer.status).toBe(413);
  });

  it('cuts off a body far beyond the cap', async () => {
    const harness = await start();
    const account = { ...percentAccount('Huge'), notes: 'x'.repeat(3 * 1024 * 1024) };
    // The connection is closed mid-upload, so the client sees either the 413 or a reset.
    const outcome = await send(harness, 'POST', '/api/accounts', account).then(
      (response) => response.status,
      () => 'reset'
    );
    expect([413, 'reset']).toContain(outcome);
    expect((await readState(harness)).state.accounts).toEqual([]);
  });

  it('accepts bodies only as JSON', async () => {
    const harness = await start();
    const plain = await fetch(`${harness.base}/api/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(percentAccount('As text'))
    });
    expect(plain.status).toBe(415);
    expect((await errorOf(plain)).code).toBe('unsupported_media_type');
    const form = await fetch(`${harness.base}/api/quick`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'text=claude+62%25'
    });
    expect(form.status).toBe(415);
    const untyped = await fetch(`${harness.base}/api/accounts`, { method: 'POST', body: Buffer.from(JSON.stringify(percentAccount('Untyped'))) });
    expect(untyped.status).toBe(415);
    expect((await readState(harness)).state.accounts).toEqual([]);
    // A request without a body has nothing to declare a type for.
    expect((await fetch(`${harness.base}/api/refresh`, { method: 'POST' })).status).toBe(200);
    expect((await fetch(`${harness.base}/api/accounts`, { method: 'POST' })).status).toBe(400);

    const withCharset = await fetch(`${harness.base}/api/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(percentAccount('With charset'))
    });
    expect(withCharset.status).toBe(201);
  });

  it('answers malformed JSON and non-object bodies with 400', async () => {
    const harness = await start();
    const broken = await send(harness, 'POST', '/api/accounts', '{"label": ');
    expect(broken.status).toBe(400);
    expect((await errorOf(broken)).code).toBe('invalid_json');
    for (const body of ['[]', '"text"', 'null', '']) {
      const response = await send(harness, 'POST', '/api/accounts', body);
      expect(response.status, body).toBe(400);
    }
    expect((await readState(harness)).state.accounts).toEqual([]);
    // A byte-order mark in front of otherwise valid JSON is tolerated.
    const withMark = await send(harness, 'POST', '/api/accounts', `\uFEFF${JSON.stringify(percentAccount('With mark'))}`);
    expect(withMark.status).toBe(201);
  });
});

describe('Optional access token', () => {
  const bearer = { Authorization: `Bearer ${TOKEN}` };

  it('answers 401 without the token on the API, the event stream and /mcp (scenario: Missing token)', async () => {
    const calls: string[] = [];
    const harness = await start({
      token: TOKEN,
      mcpHandler: (_req, res) => {
        calls.push('mcp');
        res.end('{}');
        return Promise.resolve();
      }
    });
    for (const [method, path] of [
      ['GET', '/api/state'],
      ['GET', '/api/events'],
      ['GET', '/api/export'],
      ['GET', '/api/unknown'],
      ['DELETE', '/api/accounts/x'],
      ['GET', '/mcp'],
      ['DELETE', '/mcp']
    ] as const) {
      const response = await send(harness, method, path);
      expect(response.status, path).toBe(401);
      expect(response.headers.get('www-authenticate'), path).toBe('Bearer');
      expect((await errorOf(response)).code, path).toBe('unauthorized');
    }
    expect((await send(harness, 'POST', '/api/accounts', percentAccount('No token'))).status).toBe(401);
    expect((await send(harness, 'POST', '/mcp', { jsonrpc: '2.0' })).status).toBe(401);
    expect(calls).toEqual([]);
    expect((await readState(harness, bearer)).state.accounts).toEqual([]);
  });

  it('accepts the token as a bearer header and rejects a wrong one', async () => {
    const harness = await start({ token: TOKEN });
    const state = await readState(harness, bearer);
    expect(state.tokenRequired).toBe(true);
    expect(JSON.stringify(state)).not.toContain(TOKEN);
    expect((await send(harness, 'GET', '/api/state', undefined, { Authorization: `Bearer ${TOKEN}x` })).status).toBe(401);
    expect((await send(harness, 'GET', '/api/state', undefined, { Authorization: `Basic ${TOKEN}` })).status).toBe(401);
    expect((await send(harness, 'GET', '/api/state', undefined, { Authorization: TOKEN })).status).toBe(401);
  });

  it('never accepts the token in a query string (scenario: Token in a query string)', async () => {
    const harness = await start({ token: TOKEN });
    for (const query of [`token=${TOKEN}`, `access_token=${TOKEN}`, `tg_session=${TOKEN}`, `authorization=Bearer%20${TOKEN}`]) {
      expect((await send(harness, 'GET', `/api/state?${query}`)).status, query).toBe(401);
      expect((await send(harness, 'GET', `/api/events?${query}`)).status, query).toBe(401);
      expect((await send(harness, 'GET', `/mcp?${query}`)).status, query).toBe(401);
    }
  });

  it('exchanges the token once for an HTTP-only, same-site session cookie (scenario: Opening the dashboard with the token)', async () => {
    const harness = await start({ token: TOKEN });

    const wrong = await send(harness, 'POST', '/api/session', { token: `${TOKEN}-wrong` });
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get('set-cookie')).toBeNull();
    expect((await send(harness, 'POST', '/api/session', {})).status).toBe(401);
    expect((await send(harness, 'POST', '/api/session', { token: 12345 })).status).toBe(401);

    const exchange = await send(harness, 'POST', '/api/session', { token: TOKEN });
    expect(exchange.status).toBe(204);
    const setCookie = exchange.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(/^tg_session=[A-Za-z0-9_-]{43};/);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).not.toContain(TOKEN);

    const cookie = { Cookie: setCookie.split(';')[0] as string };
    expect((await readState(harness, cookie)).tokenRequired).toBe(true);
    expect((await send(harness, 'POST', '/api/accounts', percentAccount('By cookie'), cookie)).status).toBe(201);

    const events = await openEvents(harness, cookie);
    expect(events.response.status).toBe(200);
    await events.cancel();

    expect((await send(harness, 'GET', '/api/state', undefined, { Cookie: 'tg_session=forged' })).status).toBe(401);
    expect((await send(harness, 'GET', '/api/state', undefined, { Cookie: `tg_session=${TOKEN}` })).status).toBe(401);
  });

  it('cannot be dodged by spelling the path differently', async () => {
    const harness = await start({ token: TOKEN, state: addAccount(emptyState(), percentAccount('Secret Plan') as never, NOW).state });
    const host = { Host: `127.0.0.1:${harness.port}` };
    for (const path of ['/%61pi/state', '//api/state', '/api//state', '/api/state/', '/api/%73tate', '/%61pi/export']) {
      const answer = await raw(harness.port, { path, headers: host });
      expect(answer.status, path).toBe(401);
      expect(answer.body, path).not.toContain('Secret Plan');
    }
    // Anything that is not the API after decoding is the dashboard, which holds no data.
    for (const path of ['/API/state', '/api%2Fstate', '/apis/state']) {
      const answer = await raw(harness.port, { path, headers: host });
      expect(answer.body, path).not.toContain('Secret Plan');
    }
    const authorised = await raw(harness.port, { path: '/%61pi/state', headers: { ...host, Authorization: `Bearer ${TOKEN}` } });
    expect(authorised.status).toBe(200);
    expect(authorised.body).toContain('Secret Plan');
  });

  it('refuses a token exchange from another site', async () => {
    const harness = await start({ token: TOKEN });
    const response = await send(harness, 'POST', '/api/session', { token: TOKEN }, { Origin: 'https://evil.example' });
    expect(response.status).toBe(403);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('keeps the page and the health check open so the token can be sent at all', async () => {
    const harness = await start({ token: TOKEN });
    const page = await fetch(`${harness.base}/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('tg-test-index');
    expect((await fetch(`${harness.base}/app.js`)).status).toBe(200);
    expect((await fetch(`${harness.base}/healthz`)).status).toBe(200);
  });

  it('answers the exchange with 204 and no cookie when no token is configured', async () => {
    const harness = await start();
    const response = await send(harness, 'POST', '/api/session', { token: 'anything' });
    expect(response.status).toBe(204);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect((await readState(harness)).tokenRequired).toBe(false);
  });
});

describe('HTTP API', () => {
  it('returns the whole state rolled forward to now (scenario: Read state)', async () => {
    // A daily window that ended an hour ago, last read at 40%.
    const earlier = NOW - 2 * HOUR;
    const seeded = addAccount(
      emptyState(),
      {
        providerId: 'custom',
        label: 'Daily Plan',
        price: { amount: 30, currency: 'USD', period: 'month' },
        meters: [
          { key: 'daily', label: 'Daily', unit: 'percent', used: 40, reset: { kind: 'interval', hours: 24 }, resetsAt: iso(NOW - HOUR) }
        ]
      },
      earlier
    ).state;
    const harness = await start({ state: seeded, collectors: fakeCollectors(), cliCommand: 'node "/opt/tg/main.js"' });

    const response = await send(harness, 'GET', '/api/state');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    const answer = (await response.json()) as StateAnswer;

    expect(answer.now).toBe(iso(NOW));
    expect(answer.timeZone).toBe('UTC');
    expect(answer.version).toBe(VERSION);
    expect(answer.demo).toBe(false);
    expect(answer.warnings).toEqual([]);
    expect(answer.cli).toBe('node "/opt/tg/main.js"');
    expect(answer.tokenRequired).toBe(false);
    expect(answer.collectors.map((collector) => collector.id)).toEqual(['fake-source']);

    expect(answer.state.accounts).toHaveLength(1);
    expect(answer.state.spend).toEqual([]);
    expect(answer.state.settings).toEqual({ currency: 'USD', enabledCollectors: [] });
    const meter = answer.state.accounts[0]?.meters[0] as Meter;
    // The window that ended an hour ago is closed and recorded; the meter is in the next one.
    expect(meter.resetsAt).toBe(iso(NOW + 23 * HOUR));
    expect(meter.used).toBe(0);
    expect(answer.state.cycles).toHaveLength(1);
    expect(answer.state.cycles[0]).toMatchObject({ meterId: meter.id, endedAt: iso(NOW - HOUR), used: 40 });
  });

  it('defaults the CLI command and survives a collector runner that fails', async () => {
    const broken: CollectorHost = {
      list: () => Promise.reject(new Error('runner is down')),
      setEnabled: () => Promise.reject(new Error('runner is down')),
      refresh: () => Promise.reject(new Error('runner is down'))
    };
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const harness = await start({ collectors: broken, demo: true });
    const answer = await readState(harness);
    expect(answer.cli).toBe('tokengator');
    expect(answer.collectors).toEqual([]);
    expect(answer.demo).toBe(true);
    stderr.mockRestore();
  });

  it('names the field of an invalid value (scenario: Validation error)', async () => {
    const harness = await start();
    const created = await send(harness, 'POST', '/api/accounts', percentAccount('Claude Max'));
    const { account } = (await created.json()) as { account: Account };

    const response = await send(harness, 'POST', `/api/accounts/${account.id}/meters`, {
      label: 'Premium requests',
      unit: 'requests',
      limit: -5,
      reset: { kind: 'monthly', day: 1 }
    });
    expect(response.status).toBe(400);
    const error = await errorOf(response);
    expect(error.code).toBe('validation');
    expect(error.field).toMatch(/limit$/);
    expect(error.message).toMatch(/limit/);
    expect((await readState(harness)).state.accounts[0]?.meters).toHaveLength(1);
  });

  it('creates, changes and removes accounts and meters, and records readings', async () => {
    const harness = await start();

    const created = await send(harness, 'POST', '/api/accounts', percentAccount('Claude Max'));
    expect(created.status).toBe(201);
    expect(created.headers.get('cache-control')).toBe('no-store');
    const { account } = (await created.json()) as { account: Account };
    expect(account).toMatchObject({ id: 'claude-max', label: 'Claude Max' });
    expect(account.meters[0]?.id).toBe('claude-max:weekly');

    const patched = await send(harness, 'PATCH', '/api/accounts/claude-max', { notes: 'Team seat', plan: 'Max 20x' });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { account: Account }).account).toMatchObject({ notes: 'Team seat', plan: 'Max 20x' });

    const added = await send(harness, 'POST', '/api/accounts/claude-max/meters', {
      key: 'session',
      label: 'Session',
      role: 'throttle',
      unit: 'percent',
      reset: { kind: 'rolling', hours: 5 }
    });
    expect(added.status).toBe(201);
    const { meter: session } = (await added.json()) as { meter: Meter };
    expect(session).toMatchObject({ id: 'claude-max:session', role: 'throttle' });

    // Meter ids contain a colon and travel percent-encoded.
    const weeklyPath = `/api/meters/${encodeURIComponent('claude-max:weekly')}`;
    expect(weeklyPath).toContain('%3A');
    const renamed = await send(harness, 'PATCH', weeklyPath, { label: 'All models' });
    expect(renamed.status).toBe(200);
    expect(((await renamed.json()) as { meter: Meter }).meter.label).toBe('All models');

    const reading = await send(harness, 'POST', `${weeklyPath}/readings`, {
      usedPercent: 62,
      resetsAt: iso(NOW + 48 * HOUR),
      remaining: null,
      source: { kind: 'agent', id: 'browser-agent' }
    });
    expect(reading.status).toBe(200);
    const recorded = (await reading.json()) as { account: Account; meter: Meter };
    expect(recorded.account.id).toBe('claude-max');
    expect(recorded.meter).toMatchObject({ used: 62, resetsAt: iso(NOW + 48 * HOUR), source: { kind: 'agent', id: 'browser-agent' } });

    // A client cannot pass itself off as a collector.
    const spoofed = await send(harness, 'POST', `${weeklyPath}/readings`, { usedPercent: 63, source: { kind: 'collector', id: 'x' } });
    expect(((await spoofed.json()) as { meter: Meter }).meter.source.kind).toBe('manual');

    const badReading = await send(harness, 'POST', `${weeklyPath}/readings`, { usedPercent: '62' });
    expect(badReading.status).toBe(400);
    expect(await errorOf(badReading)).toMatchObject({ code: 'validation', field: 'usedPercent' });
    const emptyReading = await send(harness, 'POST', `${weeklyPath}/readings`, {});
    expect(emptyReading.status).toBe(400);
    const outOfRange = await send(harness, 'POST', `${weeklyPath}/readings`, { usedPercent: 140 });
    expect(await errorOf(outOfRange)).toMatchObject({ code: 'validation', field: 'usedPercent' });

    const removedMeter = await send(harness, 'DELETE', `/api/meters/${encodeURIComponent(session.id)}`);
    expect(removedMeter.status).toBe(204);
    expect(await removedMeter.text()).toBe('');
    expect((await readState(harness)).state.accounts[0]?.meters.map((meter) => meter.id)).toEqual(['claude-max:weekly']);

    const removed = await send(harness, 'DELETE', '/api/accounts/claude-max');
    expect(removed.status).toBe(204);
    expect(removed.headers.get('cache-control')).toBe('no-store');
    expect((await readState(harness)).state.accounts).toEqual([]);
  });

  it('adds an account from a catalog preset', async () => {
    const harness = await start();
    const response = await send(harness, 'POST', '/api/accounts', {
      preset: { provider: 'fakeai', plan: 'pro', label: 'Work FakeAI', price: { amount: 15, currency: 'eur' } }
    });
    expect(response.status).toBe(201);
    const { account } = (await response.json()) as { account: Account };
    expect(account).toMatchObject({
      providerId: 'fakeai',
      label: 'Work FakeAI',
      plan: 'Pro',
      price: { amount: 15, currency: 'EUR', period: 'month' }
    });
    expect(account.meters.map((meter) => meter.key)).toEqual(['weekly']);

    const plain = await send(harness, 'POST', '/api/accounts', { preset: { provider: 'fakeai' } });
    expect(((await plain.json()) as { account: Account }).account.label).toBe('FakeAI');

    const unknown = await send(harness, 'POST', '/api/accounts', { preset: { provider: 'nope' } });
    expect(unknown.status).toBe(400);
    expect(await errorOf(unknown)).toMatchObject({ code: 'validation', field: 'provider' });
    const missing = await send(harness, 'POST', '/api/accounts', { preset: { plan: 'pro' } });
    expect(await errorOf(missing)).toMatchObject({ code: 'validation', field: 'preset.provider' });
    const wrongType = await send(harness, 'POST', '/api/accounts', { preset: { provider: 7 } });
    expect(wrongType.status).toBe(400);
  });

  it('answers malformed documents with 400 instead of failing inside', async () => {
    const harness = await start();
    const badProvider = await send(harness, 'POST', '/api/accounts', { ...percentAccount('X'), providerId: 7 });
    expect(await errorOf(badProvider)).toMatchObject({ code: 'validation', field: 'providerId' });
    const badMeter = await send(harness, 'POST', '/api/accounts', { ...percentAccount('X'), meters: [null] });
    expect(await errorOf(badMeter)).toMatchObject({ code: 'validation', field: 'meters[0]' });
    const badKey = await send(harness, 'POST', '/api/accounts', {
      ...percentAccount('X'),
      meters: [{ key: 5, label: 'Weekly', reset: { kind: 'none' } }]
    });
    expect(await errorOf(badKey)).toMatchObject({ code: 'validation', field: 'meters[0].key' });
    expect((await readState(harness)).state.accounts).toEqual([]);
  });

  it('previews and saves a quick entry, and reports an ambiguous name with candidates', async () => {
    const harness = await start();
    await send(harness, 'POST', '/api/accounts', percentAccount('Claude Max'));

    const preview = await send(harness, 'POST', '/api/quick', { text: 'claude 62%', dryRun: true });
    expect(preview.status).toBe(200);
    const previewed = (await preview.json()) as { preview: string; accountId: string; meterId: string; saved: boolean };
    expect(previewed).toMatchObject({ accountId: 'claude-max', meterId: 'claude-max:weekly', saved: false });
    expect(previewed.preview).toContain('62% used');
    expect((await readState(harness)).state.accounts[0]?.meters[0]?.used).toBe(0);

    const save = await send(harness, 'POST', '/api/quick', { text: 'claude 62%' });
    expect(save.status).toBe(200);
    expect(await save.json()).toMatchObject({ accountId: 'claude-max', meterId: 'claude-max:weekly', saved: true });
    expect((await readState(harness)).state.accounts[0]?.meters[0]?.used).toBe(62);

    await send(harness, 'POST', '/api/accounts', percentAccount('Claude Pro'));
    for (const dryRun of [true, false]) {
      const ambiguous = await send(harness, 'POST', '/api/quick', { text: 'claude 10%', dryRun });
      expect(ambiguous.status).toBe(409);
      const error = await errorOf(ambiguous);
      expect(error.code).toBe('ambiguous');
      expect(error.candidates?.map((candidate) => candidate.accountId).sort()).toEqual(['claude-max', 'claude-pro']);
    }
    const unknown = await send(harness, 'POST', '/api/quick', { text: 'gemini 10%' });
    expect(unknown.status).toBe(409);
    expect((await errorOf(unknown)).candidates?.length).toBe(2);
    expect((await readState(harness)).state.accounts[0]?.meters[0]?.used).toBe(62);

    const empty = await send(harness, 'POST', '/api/quick', { text: '   ' });
    expect(await errorOf(empty)).toMatchObject({ code: 'validation', field: 'text' });
    // "true" as text must not be taken for "save".
    const sloppy = await send(harness, 'POST', '/api/quick', { text: 'claude max 5%', dryRun: 'true' });
    expect(await errorOf(sloppy)).toMatchObject({ code: 'validation', field: 'dryRun' });
    expect((await readState(harness)).state.accounts[0]?.meters[0]?.used).toBe(62);
  });

  it('manages spend sources and entries', async () => {
    const harness = await start();
    const created = await send(harness, 'POST', '/api/spend', { providerId: 'openai', label: 'OpenAI API', monthlyBudget: 50 });
    expect(created.status).toBe(201);
    const { source } = (await created.json()) as { source: SpendSource };
    expect(source).toMatchObject({ id: 'openai-api', currency: 'USD', monthlyBudget: 50, entries: [] });

    const patched = await send(harness, 'PATCH', '/api/spend/openai-api', { label: 'OpenAI (work)', monthlyBudget: null });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { source: SpendSource }).source).toMatchObject({
      id: 'openai-api',
      label: 'OpenAI (work)',
      monthlyBudget: null
    });

    const set = await send(harness, 'POST', '/api/spend/openai-api/entries', { date: '2026-11-18', amount: 3.5 });
    expect(set.status).toBe(200);
    const added = await send(harness, 'POST', '/api/spend/openai-api/entries', { amount: 1.25, mode: 'add' });
    await send(harness, 'POST', '/api/spend/openai-api/entries', { amount: 1, mode: 'add' });
    expect(((await added.json()) as { source: SpendSource }).source.entries).toEqual([
      { date: '2026-11-18', amount: 3.5 },
      { date: '2026-11-19', amount: 1.25 }
    ]);
    expect((await readState(harness)).state.spend[0]?.entries[1]).toEqual({ date: '2026-11-19', amount: 2.25 });

    expect(await errorOf(await send(harness, 'POST', '/api/spend/openai-api/entries', { amount: -1 }))).toMatchObject({
      code: 'validation',
      field: 'amount'
    });
    expect(await errorOf(await send(harness, 'POST', '/api/spend/openai-api/entries', { amount: 1, mode: 'multiply' }))).toMatchObject({
      code: 'validation',
      field: 'mode'
    });
    expect(await errorOf(await send(harness, 'PATCH', '/api/spend/openai-api', { label: 5 }))).toMatchObject({
      code: 'validation',
      field: 'label'
    });
    expect((await send(harness, 'PATCH', '/api/spend/nope', { label: 'x' })).status).toBe(404);

    expect((await send(harness, 'DELETE', '/api/spend/openai-api')).status).toBe(204);
    expect((await readState(harness)).state.spend).toEqual([]);
  });

  it('changes settings, exports the state and imports it again', async () => {
    const harness = await start();
    await send(harness, 'POST', '/api/accounts', percentAccount('Claude Max'));

    const settings = await send(harness, 'PATCH', '/api/settings', { currency: 'eur' });
    expect(settings.status).toBe(200);
    expect(await settings.json()).toEqual({ settings: { currency: 'EUR', enabledCollectors: [] } });
    expect(await errorOf(await send(harness, 'PATCH', '/api/settings', { currency: 'euros' }))).toMatchObject({
      code: 'validation',
      field: 'currency'
    });

    const exported = await send(harness, 'GET', '/api/export');
    expect(exported.status).toBe(200);
    expect(exported.headers.get('content-disposition')).toBe('attachment; filename="tokengator-state.json"');
    expect(exported.headers.get('cache-control')).toBe('no-store');
    const document = (await exported.json()) as State;
    expect(document).toMatchObject({ version: 1, settings: { currency: 'EUR' } });
    expect(document.accounts.map((account) => account.id)).toEqual(['claude-max']);

    await send(harness, 'DELETE', '/api/accounts/claude-max');
    const imported = await send(harness, 'POST', '/api/import', document);
    expect(imported.status).toBe(200);
    expect(((await imported.json()) as { state: State }).state.accounts.map((account) => account.id)).toEqual(['claude-max']);
    expect((await readState(harness)).state.settings.currency).toBe('EUR');

    const invalid = await send(harness, 'POST', '/api/import', { version: 99 });
    expect(await errorOf(invalid)).toMatchObject({ code: 'validation', field: 'version' });
    const malformed = await send(harness, 'POST', '/api/import', {
      version: 1,
      accounts: [{ label: 'X', meters: [{ key: 9, label: 'Weekly', reset: { kind: 'none' } }] }]
    });
    expect(await errorOf(malformed)).toMatchObject({ code: 'validation', field: 'accounts[0].meters[0].key' });
    expect((await readState(harness)).state.accounts.map((account) => account.id)).toEqual(['claude-max']);
  });

  it('serves the snapshot, the brief and the catalog', async () => {
    const harness = await start();
    await send(harness, 'POST', '/api/accounts', percentAccount('Claude Max'));

    const snapshot = await send(harness, 'GET', '/api/snapshot');
    expect(snapshot.status).toBe(200);
    expect(await snapshot.json()).toEqual(JSON.parse(JSON.stringify(await harness.service.snapshot())));

    const brief = await send(harness, 'GET', '/api/brief');
    expect(brief.status).toBe(200);
    expect(brief.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(brief.headers.get('cache-control')).toBe('no-store');
    expect(await brief.text()).toBe(await harness.service.brief());

    const catalog = await send(harness, 'GET', '/api/catalog');
    expect(catalog.status).toBe(200);
    const body = (await catalog.json()) as { checked: string; providers: { id: string }[] };
    expect(body.checked).toBe('2026-01-01');
    expect(body.providers.map((provider) => provider.id)).toEqual(['fakeai']);
  });

  it('lists, switches and runs collectors', async () => {
    const collectors = fakeCollectors();
    const harness = await start({ collectors });

    const listed = await send(harness, 'GET', '/api/collectors');
    expect(listed.status).toBe(200);
    expect(((await listed.json()) as { collectors: CollectorStatus[] }).collectors[0]).toMatchObject({ id: 'fake-source', enabled: false });

    const switched = await send(harness, 'PATCH', '/api/collectors/fake-source', { enabled: true });
    expect(switched.status).toBe(200);
    expect(((await switched.json()) as { collector: CollectorStatus }).collector).toMatchObject({ id: 'fake-source', enabled: true });
    expect(await errorOf(await send(harness, 'PATCH', '/api/collectors/fake-source', { enabled: 'yes' }))).toMatchObject({
      code: 'validation',
      field: 'enabled'
    });
    expect((await send(harness, 'PATCH', '/api/collectors/unknown', { enabled: true })).status).toBe(404);

    const refreshed = await send(harness, 'POST', '/api/refresh', { ids: ['fake-source'] });
    expect(refreshed.status).toBe(200);
    expect(((await refreshed.json()) as { collectors: CollectorStatus[] }).collectors[0]).toMatchObject({ lastOutcome: 'ok' });
    expect((await send(harness, 'POST', '/api/refresh', {})).status).toBe(200);
    // No body at all means "everything that is enabled".
    expect((await fetch(`${harness.base}/api/refresh`, { method: 'POST' })).status).toBe(200);
    expect(collectors.refreshed).toEqual([['fake-source'], undefined, undefined]);
    expect(await errorOf(await send(harness, 'POST', '/api/refresh', { ids: 'fake-source' }))).toMatchObject({
      code: 'validation',
      field: 'ids'
    });
  });

  it('answers the collector routes when no runner is attached', async () => {
    const harness = await start();
    expect(await (await send(harness, 'GET', '/api/collectors')).json()).toEqual({ collectors: [] });
    expect(await (await send(harness, 'POST', '/api/refresh', {})).json()).toEqual({ collectors: [] });
    expect((await send(harness, 'PATCH', '/api/collectors/any', { enabled: true })).status).toBe(404);
  });

  it('uses one error shape for unknown things and wrong methods', async () => {
    const harness = await start();
    const unknownAccount = await send(harness, 'PATCH', '/api/accounts/nope', { label: 'x' });
    expect(unknownAccount.status).toBe(404);
    expect(await errorOf(unknownAccount)).toMatchObject({ code: 'not_found', message: expect.stringContaining('nope') as string });
    expect((await send(harness, 'DELETE', '/api/accounts/nope')).status).toBe(404);
    expect((await send(harness, 'DELETE', `/api/meters/${encodeURIComponent('nope:weekly')}`)).status).toBe(404);
    expect((await send(harness, 'POST', `/api/meters/${encodeURIComponent('nope:weekly')}/readings`, { used: 1 })).status).toBe(404);

    const unknownRoute = await send(harness, 'GET', '/api/nothing-here');
    expect(unknownRoute.status).toBe(404);
    expect(unknownRoute.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect((await errorOf(unknownRoute)).code).toBe('not_found');
    expect((await send(harness, 'GET', '/api')).status).toBe(404);

    const wrongMethod = await send(harness, 'PUT', '/api/accounts/x', { label: 'x' });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get('allow')).toBe('PATCH, DELETE');
    expect((await errorOf(wrongMethod)).code).toBe('method_not_allowed');
    expect((await send(harness, 'POST', '/api/state', {})).status).toBe(405);
    expect((await send(harness, 'POST', '/healthz', {})).status).toBe(405);

    const badEncoding = await raw(harness.port, { path: '/api/accounts/%E0%A4%A', headers: { Host: `127.0.0.1:${harness.port}` } });
    expect(badEncoding.status).toBe(400);
  });

  it('answers 503 while another process holds the state', async () => {
    class BusyStore extends MemoryStateStore {
      override update<T>(): Promise<T> {
        return Promise.reject(new LockTimeoutError(this.location));
      }
    }
    const harness = await start({ store: new BusyStore() });
    const response = await send(harness, 'POST', '/api/accounts', percentAccount('Claude Max'));
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('1');
    expect((await errorOf(response)).code).toBe('busy');
  });

  it('hides unexpected failures behind a generic 500 and keeps credentials out of the log', async () => {
    const secret = 'sk-live-abcdefghijklmnop123456';
    const collectors = fakeCollectors();
    collectors.refresh = () => Promise.reject(new Error(`upstream refused Authorization: Bearer ${secret}`));
    const written: string[] = [];
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    const harness = await start({ collectors, token: TOKEN });
    const response = await send(harness, 'POST', '/api/refresh', {}, { Authorization: `Bearer ${TOKEN}`, Cookie: 'theme=dark' });
    stderr.mockRestore();

    expect(response.status).toBe(500);
    const error = await errorOf(response);
    expect(error.code).toBe('internal');
    expect(error.message).not.toContain('upstream');
    expect(error.message).not.toContain(secret);
    const logged = written.join('');
    expect(logged).toContain('Request failed');
    expect(logged).toContain('/api/refresh');
    expect(logged).not.toContain(secret);
    expect(logged).not.toContain(TOKEN);
    expect(logged).not.toContain('theme=dark');
  });
});

describe('Event stream', () => {
  it('announces the current revision, then every change', async () => {
    const harness = await start();
    const events = await openEvents(harness);
    expect(events.response.status).toBe(200);
    expect(events.response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(events.response.headers.get('cache-control')).toBe('no-store');

    expect(await events.next()).toBe('retry: 3000');
    const first = await events.next();
    expect(first).toMatch(/^event: change\ndata: \{"revision":\d+\}$/);
    const revision = revisionOf(first);

    expect((await send(harness, 'POST', '/api/accounts', percentAccount('Claude Max'))).status).toBe(201);
    const second = await events.next();
    expect(second).toMatch(/^event: change\n/);
    expect(revisionOf(second)).toBe(revision + 1);

    // A change made behind the API's back (another process, the CLI) is announced as well.
    await harness.service.updateSettings({ currency: 'SEK' });
    expect(revisionOf(await events.next())).toBe(revision + 2);

    // A later subscriber starts from where the service is now.
    const late = await openEvents(harness);
    await late.next();
    expect(revisionOf(await late.next())).toBe(revision + 2);
    await late.cancel();
    await events.cancel();
  });

  it('announces a change written by another process within five seconds (scenario: Change made by another process)', async () => {
    const home = await mkdtemp(join(root, 'home-'));
    const watched = new FileStateStore(home, { pollMs: 50 });
    const other = new FileStateStore(home, { pollMs: 0 });
    try {
      const harness = await start({ store: watched });
      const events = await openEvents(harness);
      await events.next();
      const revision = revisionOf(await events.next());

      const started = Date.now();
      await new TokengatorService(other, { now: () => NOW }).addAccount(percentAccount('From the CLI') as never);
      expect(revisionOf(await events.next())).toBeGreaterThan(revision);
      expect(Date.now() - started).toBeLessThan(5000);
      expect((await readState(harness)).state.accounts.map((account) => account.label)).toEqual(['From the CLI']);
      await events.cancel();
    } finally {
      watched.close();
      other.close();
    }
  });

  it('sends a comment every 25 seconds and stops the timer when the client leaves', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const harness = await start();
    const events = await openEvents(harness);
    await events.next();
    await events.next();
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(24_999);
    vi.advanceTimersByTime(1);
    expect(await events.next()).toBe(': ping');

    await events.cancel();
    await until(() => vi.getTimerCount() === 0);
    // Nothing is left listening to a stream that is gone.
    await harness.service.updateSettings({ currency: 'NOK' });
  });

  it('ends open streams on close so the server shuts down promptly', async () => {
    const harness = await start();
    const events = await openEvents(harness);
    await events.next();
    await events.next();

    const started = Date.now();
    await harness.server.close();
    expect(Date.now() - started).toBeLessThan(1000);
    expect(harness.server.server.listening).toBe(false);
    expect(await events.next()).toBeNull();
    await expect(fetch(`${harness.base}/healthz`)).rejects.toThrow();
    // Closing twice, or after a change, is harmless.
    await harness.service.updateSettings({ currency: 'DKK' });
    await harness.server.close();
  });

  it('can be closed without ever having listened', async () => {
    const service = new TokengatorService(new MemoryStateStore());
    const server = new TokengatorHttpServer({
      service,
      config: { host: '127.0.0.1', port: 0, token: null, home: root, demo: false },
      publicDir
    });
    await server.close();
  });
});

describe('Static files', () => {
  it('serves index.html at / with the dashboard security headers', async () => {
    const harness = await start();
    const response = await fetch(`${harness.base}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-cache');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    const csp = response.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(await response.text()).toContain('tg-test-index');
  });

  it('serves assets with their content type', async () => {
    const harness = await start();
    const script = await fetch(`${harness.base}/app.js`);
    expect(script.status).toBe(200);
    expect(script.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(script.headers.get('cache-control')).toBe('no-cache');
    expect(await script.text()).toContain('tg-test-app');
    const style = await fetch(`${harness.base}/assets/style.css?v=3`);
    expect(style.headers.get('content-type')).toBe('text/css; charset=utf-8');
    expect((await fetch(`${harness.base}/blob.bin`)).headers.get('content-type')).toBe('application/octet-stream');
    expect((await fetch(`${harness.base}/index.html`)).headers.get('content-type')).toBe('text/html; charset=utf-8');
  });

  it('revalidates with an ETag and answers HEAD without a body', async () => {
    const harness = await start();
    const first = await fetch(`${harness.base}/app.js`);
    const etag = first.headers.get('etag') ?? '';
    expect(etag).not.toBe('');
    const again = await fetch(`${harness.base}/app.js`, { headers: { 'If-None-Match': etag } });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe('');

    const head = await fetch(`${harness.base}/app.js`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe(String((await first.text()).length));
    expect(await head.text()).toBe('');
  });

  it('serves index.html for unknown paths without an extension, and 404 for missing files', async () => {
    const harness = await start();
    const page = await fetch(`${harness.base}/timeline/anything`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('tg-test-index');
    const directory = await fetch(`${harness.base}/assets`);
    expect(await directory.text()).toContain('tg-test-index');

    const missing = await fetch(`${harness.base}/missing.js`);
    expect(missing.status).toBe(404);
    expect(await missing.text()).not.toContain('tg-test-index');
  });

  it('rejects path traversal', async () => {
    const harness = await start();
    const host = { Host: `127.0.0.1:${harness.port}` };
    for (const path of [
      '/../outside.txt',
      '/assets/../../outside.txt',
      '/%2e%2e/outside.txt',
      '/..%2foutside.txt',
      '/..%2Foutside.txt',
      '/..%5coutside.txt',
      '/assets/..%2f..%2foutside.txt',
      '/c:%5coutside.txt',
      '/app.js%00.txt'
    ]) {
      const answer = await raw(harness.port, { path, headers: host });
      expect(answer.status, path).toBe(403);
      expect(answer.body, path).not.toContain(OUTSIDE_SECRET);
    }
    // What fetch itself can express after URL normalisation.
    const viaFetch = await fetch(`${harness.base}/..%2f..%2foutside.txt`);
    expect(viaFetch.status).toBe(403);
    expect(await viaFetch.text()).not.toContain(OUTSIDE_SECRET);
  });

  it('does not serve dotfiles', async () => {
    const harness = await start();
    for (const path of ['/.env', '/%2Eenv', '/.git/config', '/assets/.hidden']) {
      const answer = await raw(harness.port, { path, headers: { Host: `127.0.0.1:${harness.port}` } });
      expect(answer.status, path).toBe(404);
      expect(answer.body, path).not.toContain(DOTFILE_SECRET);
      expect(answer.body, path).not.toContain('tg-test-index');
    }
  });

  it('accepts only GET and HEAD', async () => {
    const harness = await start();
    const response = await send(harness, 'POST', '/', { any: 'thing' });
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, HEAD');
    expect((await send(harness, 'DELETE', '/app.js')).status).toBe(405);
  });

  it('explains how to build the dashboard when index.html is missing', async () => {
    const harness = await start({ publicDir: emptyDir });
    for (const path of ['/', '/index.html', '/queue']) {
      const response = await fetch(`${harness.base}${path}`);
      expect(response.status, path).toBe(200);
      expect(response.headers.get('content-type'), path).toBe('text/html; charset=utf-8');
      expect(await response.text(), path).toContain('npm run build');
    }
    // The API works regardless.
    expect((await readState(harness)).state.accounts).toEqual([]);
  });
});

describe('/mcp mount', () => {
  interface Call {
    method: string;
    body: unknown;
  }

  function recorder(): { calls: Call[]; handler: McpHttpHandler } {
    const calls: Call[] = [];
    return {
      calls,
      handler: (req, res, parsedBody) => {
        calls.push({ method: req.method ?? '', body: parsedBody });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }));
        return Promise.resolve();
      }
    };
  }

  it('answers 404 when no handler is mounted', async () => {
    const harness = await start();
    const response = await send(harness, 'POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'ping' });
    expect(response.status).toBe(404);
    expect((await errorOf(response)).code).toBe('not_found');
  });

  it('hands POST, GET and DELETE to the handler, with the parsed body for POST', async () => {
    const { calls, handler } = recorder();
    const harness = await start({ mcpHandler: handler });
    const message = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { cursor: 'ü' } };

    const post = await send(harness, 'POST', '/mcp', message, { Accept: 'application/json, text/event-stream' });
    expect(post.status).toBe(200);
    expect(await post.json()).toEqual({ jsonrpc: '2.0', id: 1, result: { ok: true } });
    expect((await send(harness, 'GET', '/mcp')).status).toBe(200);
    expect((await send(harness, 'DELETE', '/mcp')).status).toBe(200);
    expect(calls).toEqual([
      { method: 'POST', body: message },
      { method: 'GET', body: undefined },
      { method: 'DELETE', body: undefined }
    ]);

    const put = await send(harness, 'PUT', '/mcp', message);
    expect(put.status).toBe(405);
    expect(put.headers.get('allow')).toBe('GET, POST, DELETE');
    expect((await send(harness, 'POST', '/mcp/extra', message)).status).toBe(404);
    expect(calls).toHaveLength(3);
  });

  it('applies the body rules before the handler sees anything', async () => {
    const { calls, handler } = recorder();
    const harness = await start({ mcpHandler: handler });
    const plain = await fetch(`${harness.base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
    expect(plain.status).toBe(415);
    expect((await send(harness, 'POST', '/mcp', '{"jsonrpc": ')).status).toBe(400);
    expect((await send(harness, 'POST', '/mcp', '')).status).toBe(400);
    expect((await send(harness, 'POST', '/mcp', { padding: 'x'.repeat(300 * 1024) })).status).toBe(413);
    expect(calls).toEqual([]);
  });

  it('is protected by the token', async () => {
    const { calls, handler } = recorder();
    const harness = await start({ mcpHandler: handler, token: TOKEN });
    const message = { jsonrpc: '2.0', id: 1, method: 'tools/list' };

    const anonymous = await send(harness, 'POST', '/mcp', message);
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get('www-authenticate')).toBe('Bearer');
    expect((await send(harness, 'POST', '/mcp', message, { Authorization: 'Bearer not-the-token-at-all' })).status).toBe(401);
    expect(calls).toEqual([]);

    const authorised = await send(harness, 'POST', '/mcp', message, { Authorization: `Bearer ${TOKEN}` });
    expect(authorised.status).toBe(200);
    expect(calls).toEqual([{ method: 'POST', body: message }]);
  });

  it('answers a generic 500 when the handler fails before answering', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const harness = await start({ mcpHandler: () => Promise.reject(new Error('transport exploded')) });
    const response = await send(harness, 'POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'ping' });
    stderr.mockRestore();
    expect(response.status).toBe(500);
    expect((await errorOf(response)).message).not.toContain('exploded');
  });
});
