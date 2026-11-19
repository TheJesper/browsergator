// The local HTTP server: the dashboard's files, the JSON API, the event stream and the /mcp mount
// (design D8, D9 and D15). node:http and a small router on purpose: there are two dozen routes, and a
// framework would only add a dependency to audit.

import { readFile, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';

import type { AccountInput, AccountPatch, MeterInput, MeterPatch } from '../core/accounts.js';
import { CATALOG, CATALOG_CHECKED } from '../core/catalog.js';
import type { SpendSourceInput } from '../core/spend.js';
import type { MeterSource, Price, Reading, Settings } from '../core/types.js';
import type { CollectorHost, CollectorStatus } from './collectors/types.js';
import { MAX_BODY_BYTES, VERSION, type ServiceConfig } from './config.js';
import { log } from './logger.js';
import {
  SessionStore,
  apiHeaders,
  isAllowedHost,
  isAuthorised,
  isSameOrigin,
  isWildcardHost,
  safeEqual,
  sessionCookie,
  staticHeaders
} from './security.js';
import {
  AmbiguousTargetError,
  quickError,
  NotFoundError,
  ReadingError,
  ValidationError,
  type TokengatorService
} from './service.js';
import { LockTimeoutError } from './store.js';

export type McpHttpHandler = (req: IncomingMessage, res: ServerResponse, parsedBody: unknown) => Promise<void>;

export interface HttpServerOptions {
  service: TokengatorService;
  config: ServiceConfig;
  /** Directory with index.html and the built assets. */
  publicDir: string;
  collectors?: CollectorHost;
  /** Mounted at /mcp for POST, GET and DELETE, behind the same Host/Origin/token checks. */
  mcpHandler?: McpHttpHandler;
  /** How this machine invokes the CLI; returned in /api/state for the Connect panel. */
  cliCommand?: string;
}

const SERVICE_NAME = 'tokengator';
const EVENT_PING_MS = 25_000;
const EVENT_RETRY_MS = 3000;
/** A stream whose client stopped reading is dropped once this much is waiting for it. */
const EVENT_BACKLOG_BYTES = 64 * 1024;
/**
 * How far past the cap a body is still read and thrown away. Answering 413 while the client is mid-upload
 * resets the connection and the client never sees the answer, so a moderately oversized body is drained
 * first; beyond this the connection is closed instead.
 */
const DRAIN_LIMIT_BYTES = 4 * MAX_BODY_BYTES;

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
};

const NOT_BUILT_PAGE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Tokengator</title></head>
<body>
<h1>Tokengator</h1>
<p>The dashboard has not been built yet. Run <code>npm run build</code> in the tokengator directory, then reload this page.</p>
<p>The API and the MCP endpoint are already running.</p>
</body>
</html>
`;

// ---------------------------------------------------------------------------
// Errors and answers
// ---------------------------------------------------------------------------

interface ErrorBody {
  code: string;
  message: string;
  field?: string;
  candidates?: unknown;
}

/** An error whose status and wording are already decided. */
class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers: Record<string, string> = {}
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/** The client went away before the request was complete: there is nobody left to answer. */
class ClientGoneError extends Error {}

function describeError(error: unknown): { status: number; body: ErrorBody; headers: Record<string, string> } {
  if (error instanceof HttpError) {
    return { status: error.status, body: { code: error.code, message: error.message }, headers: error.headers };
  }
  if (error instanceof ValidationError || error instanceof ReadingError) {
    return { status: 400, body: { code: 'validation', message: error.message, field: error.field }, headers: {} };
  }
  if (error instanceof NotFoundError) {
    return { status: 404, body: { code: 'not_found', message: error.message }, headers: {} };
  }
  if (error instanceof AmbiguousTargetError) {
    return {
      status: 409,
      body: { code: 'ambiguous', message: error.message, candidates: error.candidates },
      headers: {}
    };
  }
  if (error instanceof LockTimeoutError) {
    return {
      status: 503,
      body: { code: 'busy', message: 'Another Tokengator process is writing the state. Try again in a moment.' },
      headers: { 'Retry-After': '1' }
    };
  }
  // The real message may quote paths or upstream text; it goes to the log, not to the client.
  return {
    status: 500,
    body: { code: 'internal', message: 'Something went wrong inside Tokengator. The service log has the details.' },
    headers: {}
  };
}

function sendJson(res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    ...apiHeaders(),
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...headers
  });
  res.end(body);
}

function sendNoContent(res: ServerResponse, headers: Record<string, string> = {}): void {
  res.writeHead(204, { ...apiHeaders(), ...headers });
  res.end();
}

function sendStatic(res: ServerResponse, status: number, type: string, body: string | Buffer, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    ...staticHeaders(),
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(body),
    ...headers
  });
  res.end(body);
}

// ---------------------------------------------------------------------------
// Request reading
// ---------------------------------------------------------------------------

/** The path of an origin-form request target, without query. Null for anything else. */
function pathOf(url: string | undefined): string | null {
  if (!url || !url.startsWith('/')) return null;
  const end = url.search(/[?#]/);
  return end < 0 ? url : url.slice(0, end);
}

/** Decoded path segments. Routing happens on these, so an encoded `/%61pi/` cannot dodge the API checks. */
function segmentsOf(pathname: string): string[] | null {
  try {
    return pathname
      .split('/')
      .filter((part) => part !== '')
      .map((part) => decodeURIComponent(part));
  } catch {
    return null;
  }
}

function headerText(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join(',') : value;
}

/** True when the request announces a body. A bare `POST /api/refresh` has none and needs no type. */
function hasBody(req: IncomingMessage): boolean {
  if (req.headers['transfer-encoding'] !== undefined) return true;
  const length = Number(req.headers['content-length'] ?? 0);
  return !Number.isFinite(length) || length > 0;
}

function requireJson(req: IncomingMessage): void {
  const type = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
  // Forms cannot send this type, and a script on another site cannot send it without a preflight that
  // this service never approves. That is what makes the JSON-only rule a cross-site defence.
  if (type !== 'application/json') {
    throw new HttpError(415, 'unsupported_media_type', 'Send the body as JSON with Content-Type: application/json.');
  }
}

function tooLarge(drained: boolean): HttpError {
  return new HttpError(
    413,
    'too_large',
    `The request body is larger than ${MAX_BODY_BYTES / 1024} KB.`,
    drained ? {} : { Connection: 'close' }
  );
}

/** Reads a request body, refusing to hold more than MAX_BODY_BYTES of it. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((done, fail) => {
    if (req.destroyed) {
      // Gone before anyone listened: none of the events below would ever fire.
      fail(new ClientGoneError());
      return;
    }
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > DRAIN_LIMIT_BYTES) {
      fail(tooLarge(false));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    let settled = false;
    const settle = (action: () => void): void => {
      if (settled) return;
      settled = true;
      req.off('data', onData);
      action();
    };
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES && !over) {
        over = true;
        chunks.length = 0;
      }
      if (!over) chunks.push(chunk);
      else if (size > DRAIN_LIMIT_BYTES) settle(() => fail(tooLarge(false)));
    };
    req.on('data', onData);
    req.once('end', () => settle(() => (over ? fail(tooLarge(true)) : done(Buffer.concat(chunks, size)))));
    req.once('error', () => settle(() => fail(new ClientGoneError())));
    req.once('close', () => settle(() => fail(new ClientGoneError())));
  });
}

/** Parses a JSON body. An empty body is `undefined`, so routes can tell "no body" from `null`. */
function parseJson(raw: Buffer): unknown {
  const decoded = raw.toString('utf8');
  // Some Windows tools put a byte-order mark in front of the JSON they send.
  const text = decoded.charCodeAt(0) === 0xfeff ? decoded.slice(1) : decoded;
  if (text.trim() === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, 'invalid_json', 'The request body is not valid JSON.');
  }
}

// ---------------------------------------------------------------------------
// Body shapes
// ---------------------------------------------------------------------------
// The core validates values. These helpers only make sure it is handed the kinds of things it expects,
// so a malformed document is answered with 400 and a field name instead of a TypeError and a 500.

function asObject(value: unknown, field = 'body'): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError(field, field === 'body' ? 'The request body must be a JSON object.' : `${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function optionalText(source: Record<string, unknown>, key: string, field = key): string | undefined {
  const value = source[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new ValidationError(field, `${field} must be text.`);
  return value;
}

function meterShape(value: unknown, field: string): void {
  optionalText(asObject(value, field), 'key', `${field}.key`);
}

function accountShape(value: Record<string, unknown>, prefix = ''): void {
  optionalText(value, 'providerId', `${prefix}providerId`);
  const meters = value['meters'];
  if (Array.isArray(meters)) meters.forEach((meter, index) => meterShape(meter, `${prefix}meters[${index}]`));
}

const READING_AMOUNTS = ['used', 'remaining', 'usedPercent', 'remainingPercent', 'limit'] as const;
const READING_TIMES = ['resetsAt', 'windowStartedAt'] as const;

function readingOf(body: Record<string, unknown>): Reading {
  const reading: Reading = {};
  for (const key of READING_AMOUNTS) {
    const value = body[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'number') throw new ValidationError(key, `${key} must be a number.`);
    reading[key] = value;
  }
  for (const key of READING_TIMES) {
    const value = optionalText(body, key);
    if (value !== undefined) reading[key] = value;
  }
  return reading;
}

function sourceOf(body: Record<string, unknown>): MeterSource {
  const raw = body['source'];
  if (typeof raw !== 'object' || raw === null) return { kind: 'manual' };
  const given = raw as Record<string, unknown>;
  // The collector, status-line and sample kinds are assigned by the service itself. A client may only
  // say whether a person or an agent read the number.
  const source: MeterSource = { kind: given['kind'] === 'agent' ? 'agent' : 'manual' };
  if (typeof given['id'] === 'string' && given['id'].trim()) source.id = given['id'].trim().slice(0, 60);
  if (typeof given['note'] === 'string' && given['note'].trim()) source.note = given['note'].trim().slice(0, 200);
  return source;
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  /** Values of the `:name` segments, in order. */
  params: string[];
  /** The parsed JSON body; `undefined` when there was none. */
  body: unknown;
}

interface Route {
  method: Method;
  path: readonly string[];
  handle: (context: RouteContext) => Promise<void> | void;
}

function matchPath(pattern: readonly string[], segments: readonly string[]): string[] | null {
  if (pattern.length !== segments.length) return null;
  const params: string[] = [];
  for (let index = 0; index < pattern.length; index += 1) {
    const expected = pattern[index] as string;
    const actual = segments[index] as string;
    if (expected.startsWith(':')) params.push(actual);
    else if (expected !== actual) return null;
  }
  return params;
}

interface EventStream {
  res: ServerResponse;
  ping: NodeJS.Timeout;
}

function changeEvent(revision: number): string {
  return `event: change\ndata: ${JSON.stringify({ revision })}\n\n`;
}

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

export class TokengatorHttpServer {
  readonly server: Server;
  private readonly options: HttpServerOptions;
  private readonly sessions = new SessionStore();
  private readonly streams = new Set<EventStream>();
  private readonly routes: Route[];
  private readonly unsubscribe: () => void;
  /**
   * Starts at the clock rather than at zero so a dashboard that reconnects after a service restart never
   * sees a revision it has seen before and mistakes new state for old.
   */
  private revision = Date.now();
  private closing: Promise<void> | null = null;

  constructor(options: HttpServerOptions) {
    this.options = options;
    this.routes = this.buildRoutes();
    // Subscribed for the server's whole life, not per stream: the revision has to count changes that
    // happen while no dashboard is connected.
    this.unsubscribe = options.service.onChange(() => {
      try {
        this.announce();
      } catch (error) {
        // The store calls listeners in the middle of a write; a broken stream must not fail that write.
        log('warn', 'Could not announce a change', { error: error instanceof Error ? error.message : String(error) });
      }
    });
    this.server = createServer((req, res) => {
      // An unhandled 'error' event on either stream would take the whole process down.
      req.on('error', () => undefined);
      res.on('error', () => undefined);
      this.handle(req, res).catch((error: unknown) => {
        // handle() answers its own failures; this is only reached if answering itself failed.
        log('error', 'Request handling failed', { error: error instanceof Error ? error.message : String(error) });
        res.destroy();
      });
    });
  }

  /** Starts listening. port 0 picks a free port. Returns the actual address. */
  listen(): Promise<{ host: string; port: number; url: string }> {
    const { host, port } = this.options.config;
    return new Promise((done, fail) => {
      this.server.once('error', fail);
      // Node wants a bare IPv6 address; the configuration may carry the bracketed form.
      this.server.listen(port, host.replace(/^\[|\]$/g, ''), () => {
        this.server.off('error', fail);
        const address = this.server.address();
        const actual = address !== null && typeof address === 'object' ? address.port : port;
        // "Every interface" is not an address a browser can open; loopback always is.
        const open = isWildcardHost(host) ? (host.includes(':') ? 'localhost' : '127.0.0.1') : host;
        const name = open.includes(':') && !open.startsWith('[') ? `[${open}]` : open;
        done({ host, port: actual, url: `http://${name}:${actual}` });
      });
    });
  }

  close(): Promise<void> {
    this.closing ??= new Promise<void>((done) => {
      this.unsubscribe();
      // Resolves even when the server never listened: close() then reports that through its callback.
      this.server.close(() => done());
      for (const stream of [...this.streams]) {
        clearInterval(stream.ping);
        stream.res.end();
      }
      this.streams.clear();
      this.sessions.clear();
      // Event streams and keep-alive sockets would otherwise hold the server open indefinitely.
      this.server.closeAllConnections();
    });
    return this.closing;
  }

  // -- request pipeline --------------------------------------------------------

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = (req.method ?? 'GET').toUpperCase();
    const pathname = pathOf(req.url);
    if (pathname !== null) {
      // The query string is left out on purpose: someone may have put a token in it.
      res.once('finish', () => log('debug', 'http', { method, path: pathname.slice(0, 200), status: res.statusCode }));
    }
    try {
      const allowed = isAllowedHost(req.headers.host, {
        configHost: this.options.config.host,
        port: req.socket.localPort ?? -1,
        localAddress: req.socket.localAddress
      });
      if (!allowed) {
        throw new HttpError(403, 'forbidden', 'This service only answers requests addressed to its own host name and port.');
      }
      const segments = pathname === null ? null : segmentsOf(pathname);
      if (segments === null) throw new HttpError(400, 'bad_request', 'The request path is not valid.');

      const area = segments[0];
      if (area === 'healthz' && segments.length === 1) this.health(res, method);
      else if (area === 'api') await this.api(req, res, method, segments.slice(1));
      else if (area === 'mcp') await this.mcp(req, res, method, segments.slice(1));
      else await this.serveStatic(req, res, method, segments);
    } catch (error) {
      this.fail(res, method, pathname, error);
    }
  }

  private fail(res: ServerResponse, method: string, pathname: string | null, error: unknown): void {
    if (error instanceof ClientGoneError) {
      res.destroy();
      return;
    }
    const described = describeError(error);
    if (described.status === 500) {
      log('error', 'Request failed', {
        method,
        path: (pathname ?? '').slice(0, 200),
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      });
    }
    if (res.headersSent) {
      // Half an answer is already on the wire (an MCP stream, say); the only honest signal left is to cut it.
      res.destroy();
      return;
    }
    sendJson(res, described.status, { error: described.body }, described.headers);
  }

  /** The cross-site and token checks shared by the API and the MCP endpoint. */
  private guard(req: IncomingMessage, tokenExempt: boolean): void {
    const sameOrigin = isSameOrigin({
      host: req.headers.host ?? '',
      origin: headerText(req.headers.origin),
      secFetchSite: headerText(req.headers['sec-fetch-site'])
    });
    if (!sameOrigin) throw new HttpError(403, 'forbidden', 'Requests from other sites are not accepted.');

    const token = this.options.config.token;
    if (token === null || tokenExempt) return;
    // Only the header and the cookie are looked at. A token in the query string would end up in browser
    // history and logs, so it is never read.
    const authorised = isAuthorised(
      { authorization: req.headers.authorization, cookie: req.headers.cookie },
      token,
      this.sessions
    );
    if (!authorised) {
      throw new HttpError(
        401,
        'unauthorized',
        'This service needs its access token. Send "Authorization: Bearer <token>", or open the dashboard with the token.',
        { 'WWW-Authenticate': 'Bearer' }
      );
    }
  }

  private health(res: ServerResponse, method: string): void {
    if (method !== 'GET' && method !== 'HEAD') {
      throw new HttpError(405, 'method_not_allowed', 'Use GET.', { Allow: 'GET, HEAD' });
    }
    sendJson(res, 200, { status: 'ok', service: SERVICE_NAME, version: VERSION });
  }

  private async api(req: IncomingMessage, res: ServerResponse, method: string, segments: string[]): Promise<void> {
    // The token exchange has to work before the caller has a session.
    this.guard(req, method === 'POST' && segments.length === 1 && segments[0] === 'session');

    const allowed: string[] = [];
    let found: { route: Route; params: string[] } | null = null;
    for (const route of this.routes) {
      const params = matchPath(route.path, segments);
      if (!params) continue;
      allowed.push(route.method);
      if (route.method === method) found = { route, params };
    }
    if (!found) {
      if (allowed.length > 0) {
        throw new HttpError(405, 'method_not_allowed', `Use ${allowed.join(' or ')} here.`, { Allow: allowed.join(', ') });
      }
      throw new HttpError(404, 'not_found', `No API route at /api/${segments.join('/')}.`.slice(0, 200));
    }

    let body: unknown;
    if ((method === 'POST' || method === 'PATCH') && hasBody(req)) {
      requireJson(req);
      body = parseJson(await readBody(req));
    }
    await found.route.handle({ req, res, params: found.params, body });
  }

  private async mcp(req: IncomingMessage, res: ServerResponse, method: string, segments: string[]): Promise<void> {
    this.guard(req, false);
    const handler = this.options.mcpHandler;
    if (!handler || segments.length > 0) throw new HttpError(404, 'not_found', 'No MCP endpoint here.');
    if (method !== 'POST' && method !== 'GET' && method !== 'DELETE') {
      throw new HttpError(405, 'method_not_allowed', 'Use POST, GET or DELETE.', { Allow: 'GET, POST, DELETE' });
    }
    let body: unknown;
    if (method === 'POST') {
      requireJson(req);
      body = parseJson(await readBody(req));
      if (body === undefined) throw new HttpError(400, 'invalid_json', 'The request body is not valid JSON.');
    }
    // Defaults only: the transport sets its own headers for event streams.
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    await handler(req, res, body);
  }

  // -- event stream --------------------------------------------------------------

  private openEvents(res: ServerResponse): void {
    res.writeHead(200, {
      ...apiHeaders(),
      'Content-Type': 'text/event-stream; charset=utf-8',
      // Asks a buffering proxy, should one ever sit in front, to pass events through as they come.
      'X-Accel-Buffering': 'no'
    });
    res.write(`retry: ${EVENT_RETRY_MS}\n\n`);
    res.write(changeEvent(this.revision));
    if (this.closing) {
      res.end();
      return;
    }
    const stream: EventStream = { res, ping: setInterval(() => this.push(stream, ': ping\n\n'), EVENT_PING_MS) };
    // The listening socket keeps the process alive; this timer must not once that is gone.
    stream.ping.unref();
    this.streams.add(stream);
    res.once('close', () => this.drop(stream));
  }

  private push(stream: EventStream, text: string): void {
    const { res } = stream;
    if (res.writableEnded || res.destroyed) {
      this.drop(stream);
      return;
    }
    if (res.writableLength > EVENT_BACKLOG_BYTES) {
      // The client stopped reading. It will reconnect and refetch, which loses nothing.
      this.drop(stream);
      res.destroy();
      return;
    }
    res.write(text);
  }

  private drop(stream: EventStream): void {
    clearInterval(stream.ping);
    this.streams.delete(stream);
  }

  private announce(): void {
    this.revision += 1;
    const event = changeEvent(this.revision);
    for (const stream of [...this.streams]) this.push(stream, event);
  }

  // -- static files --------------------------------------------------------------

  private async serveStatic(req: IncomingMessage, res: ServerResponse, method: string, segments: string[]): Promise<void> {
    const text = CONTENT_TYPES['.txt'] as string;
    if (method !== 'GET' && method !== 'HEAD') {
      sendStatic(res, 405, text, 'Method not allowed.\n', { Allow: 'GET, HEAD' });
      return;
    }
    // Checked on the decoded segments: `..%2f` and a Windows drive or stream name (`c:`, `x::$DATA`)
    // must be caught as well as a literal `..`.
    if (segments.some((segment) => segment === '..' || /[\\/:\0]/.test(segment))) {
      sendStatic(res, 403, text, 'Forbidden.\n');
      return;
    }
    if (segments.some((segment) => segment.startsWith('.'))) {
      sendStatic(res, 404, text, 'Not found.\n');
      return;
    }
    const root = resolve(this.options.publicDir);
    const index = join(root, 'index.html');
    let file = segments.length === 0 ? index : join(root, ...segments);
    const inside = relative(root, file);
    if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
      sendStatic(res, 403, text, 'Forbidden.\n');
      return;
    }

    let info = await fileInfo(file);
    if (!info && file !== index) {
      if ((segments[segments.length - 1] ?? '').includes('.')) {
        sendStatic(res, 404, text, 'Not found.\n');
        return;
      }
      // The dashboard routes on the address fragment, so this is only a courtesy to hand-typed paths.
      file = index;
      info = await fileInfo(file);
    }
    if (!info) {
      sendStatic(res, 200, CONTENT_TYPES['.html'] as string, NOT_BUILT_PAGE);
      return;
    }

    const headers = {
      ...staticHeaders(),
      'Content-Type': CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
      ETag: info.etag
    };
    if (headerText(req.headers['if-none-match']) === info.etag) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    if (method === 'HEAD') {
      res.writeHead(200, { ...headers, 'Content-Length': info.size });
      res.end();
      return;
    }
    let body: Buffer;
    try {
      body = await readFile(file);
    } catch {
      // Replaced or removed between the two calls, as a rebuild in watch mode does.
      sendStatic(res, 404, text, 'Not found.\n');
      return;
    }
    res.writeHead(200, { ...headers, 'Content-Length': body.length });
    res.end(body);
  }

  // -- API routes ------------------------------------------------------------------

  private async collectorList(): Promise<CollectorStatus[]> {
    try {
      return (await this.options.collectors?.list()) ?? [];
    } catch (error) {
      // The dashboard must still load when the collector runner is unhappy.
      log('warn', 'Could not list collectors', { error: error instanceof Error ? error.message : String(error) });
      return [];
    }
  }

  private buildRoutes(): Route[] {
    const { service, config } = this.options;
    const route = (method: Method, path: string, handle: Route['handle']): Route => ({
      method,
      path: path.split('/'),
      handle
    });
    const first = (params: string[]): string => params[0] as string;

    return [
      route('GET', 'state', async ({ res }) => {
        const state = await service.state();
        sendJson(res, 200, {
          state,
          now: new Date(service.nowMs()).toISOString(),
          timeZone: service.timeZone,
          version: VERSION,
          demo: config.demo,
          collectors: await this.collectorList(),
          warnings: service.store.warnings,
          cli: this.options.cliCommand ?? 'tokengator',
          tokenRequired: config.token !== null
        });
      }),
      route('GET', 'snapshot', async ({ res }) => sendJson(res, 200, await service.snapshot())),
      route('GET', 'brief', async ({ res }) => {
        const body = await service.brief();
        res.writeHead(200, {
          ...apiHeaders(),
          'Content-Type': 'text/markdown; charset=utf-8',
          'Content-Length': Buffer.byteLength(body)
        });
        res.end(body);
      }),
      route('GET', 'catalog', ({ res }) => sendJson(res, 200, { checked: CATALOG_CHECKED, providers: CATALOG })),
      route('GET', 'events', ({ res }) => this.openEvents(res)),

      route('POST', 'accounts', async ({ res, body }) => {
        const input = asObject(body);
        if (input['preset'] !== undefined && input['preset'] !== null) {
          const preset = asObject(input['preset'], 'preset');
          const provider = optionalText(preset, 'provider', 'preset.provider');
          if (!provider) throw new ValidationError('preset.provider', 'preset.provider is required.');
          const overrides: { label?: string; price?: Price | null } = {};
          const label = optionalText(preset, 'label', 'preset.label');
          if (label !== undefined) overrides.label = label;
          if (preset['price'] !== undefined) overrides.price = preset['price'] as Price | null;
          const account = await service.addFromPreset(provider, optionalText(preset, 'plan', 'preset.plan'), overrides);
          sendJson(res, 201, { account });
          return;
        }
        accountShape(input);
        sendJson(res, 201, { account: await service.addAccount(input as unknown as AccountInput) });
      }),
      route('PATCH', 'accounts/:id', async ({ res, params, body }) => {
        sendJson(res, 200, { account: await service.updateAccount(first(params), asObject(body) as AccountPatch) });
      }),
      route('DELETE', 'accounts/:id', async ({ res, params }) => {
        await service.removeAccount(first(params));
        sendNoContent(res);
      }),
      route('POST', 'accounts/:id/meters', async ({ res, params, body }) => {
        const input = asObject(body);
        optionalText(input, 'key');
        sendJson(res, 201, { meter: await service.addMeter(first(params), input as unknown as MeterInput) });
      }),

      route('PATCH', 'meters/:id', async ({ res, params, body }) => {
        sendJson(res, 200, { meter: await service.updateMeter(first(params), asObject(body) as MeterPatch) });
      }),
      route('DELETE', 'meters/:id', async ({ res, params }) => {
        await service.removeMeter(first(params));
        sendNoContent(res);
      }),
      route('POST', 'meters/:id/readings', async ({ res, params, body }) => {
        const input = asObject(body);
        const { account, meter } = await service.report({ meterId: first(params) }, readingOf(input), sourceOf(input));
        sendJson(res, 200, { account, meter });
      }),

      route('POST', 'quick', async ({ res, body }) => {
        const input = asObject(body);
        const text = optionalText(input, 'text');
        if (!text || !text.trim()) throw new ValidationError('text', 'text is required, for example "claude weekly 62%".');
        if (text.length > 500) throw new ValidationError('text', 'text must be at most 500 characters.');
        const dryRun = input['dryRun'] ?? false;
        // A preview that is misread as "save" would write a number the user only wanted to check.
        if (typeof dryRun !== 'boolean') throw new ValidationError('dryRun', 'dryRun must be true or false.');
        if (dryRun) {
          const parsed = await service.previewQuick(text);
          if (!parsed.ok) throw quickError(parsed);
          sendJson(res, 200, {
            preview: parsed.preview,
            accountId: parsed.account.id,
            meterId: parsed.meter.id,
            saved: false
          });
          return;
        }
        const saved = await service.quick(text);
        sendJson(res, 200, { preview: saved.preview, accountId: saved.account.id, meterId: saved.meter.id, saved: true });
      }),

      route('POST', 'spend', async ({ res, body }) => {
        const input = asObject(body);
        optionalText(input, 'providerId');
        sendJson(res, 201, { source: await service.addSpendSource(input as unknown as SpendSourceInput) });
      }),
      route('PATCH', 'spend/:id', async ({ res, params, body }) => {
        const input = asObject(body);
        const patch: Partial<Pick<SpendSourceInput, 'label' | 'currency' | 'monthlyBudget'>> = {};
        const label = optionalText(input, 'label');
        if (label !== undefined) patch.label = label;
        const currency = optionalText(input, 'currency');
        if (currency !== undefined) patch.currency = currency;
        if ('monthlyBudget' in input) patch.monthlyBudget = input['monthlyBudget'] as number | null;
        const id = first(params);
        await service.updateSpendSource(id, patch);
        // Read back by exact id: the service's own lookup also matches labels, which is too loose here.
        const source = (await service.state()).spend.find((candidate) => candidate.id === id);
        if (!source) throw new NotFoundError(`No spend source with id "${id}".`);
        sendJson(res, 200, { source });
      }),
      route('DELETE', 'spend/:id', async ({ res, params }) => {
        await service.removeSpendSource(first(params));
        sendNoContent(res);
      }),
      route('POST', 'spend/:id/entries', async ({ res, params, body }) => {
        const input = asObject(body);
        const mode = input['mode'];
        if (mode !== undefined && mode !== null && mode !== 'set' && mode !== 'add') {
          throw new ValidationError('mode', 'mode must be "set" or "add".');
        }
        const entry: { date?: string; amount: number; mode?: 'set' | 'add' } = { amount: input['amount'] as number };
        const date = optionalText(input, 'date');
        if (date !== undefined) entry.date = date;
        if (mode === 'set' || mode === 'add') entry.mode = mode;
        sendJson(res, 200, { source: await service.recordSpend(first(params), entry) });
      }),

      route('PATCH', 'settings', async ({ res, body }) => {
        const input = asObject(body);
        const patch: Partial<Settings> = {};
        if (input['currency'] !== undefined) patch.currency = input['currency'] as string;
        if (input['enabledCollectors'] !== undefined) patch.enabledCollectors = input['enabledCollectors'] as string[];
        sendJson(res, 200, { settings: await service.updateSettings(patch) });
      }),

      route('GET', 'export', async ({ res }) => {
        sendJson(res, 200, await service.exportState(), {
          'Content-Disposition': 'attachment; filename="tokengator-state.json"'
        });
      }),
      route('POST', 'import', async ({ res, body }) => {
        const document = asObject(body);
        const accounts = document['accounts'];
        if (Array.isArray(accounts)) {
          accounts.forEach((account, index) => {
            if (typeof account === 'object' && account !== null && !Array.isArray(account)) {
              accountShape(account as Record<string, unknown>, `accounts[${index}].`);
            }
          });
        }
        sendJson(res, 200, { state: await service.importState(document) });
      }),

      route('GET', 'collectors', async ({ res }) => sendJson(res, 200, { collectors: await this.collectorList() })),
      route('PATCH', 'collectors/:id', async ({ res, params, body }) => {
        const enabled = asObject(body)['enabled'];
        if (typeof enabled !== 'boolean') throw new ValidationError('enabled', 'enabled must be true or false.');
        const host = this.options.collectors;
        const id = first(params);
        // Looked up first so an unknown id is a 404 whatever the runner would have thrown for it.
        if (!host || !(await host.list()).some((collector) => collector.id === id)) {
          throw new NotFoundError(`No collector with id "${id}".`);
        }
        sendJson(res, 200, { collector: await host.setEnabled(id, enabled) });
      }),
      route('POST', 'refresh', async ({ res, body }) => {
        const ids = body === undefined ? undefined : asObject(body)['ids'];
        if (ids !== undefined && ids !== null && (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string'))) {
          throw new ValidationError('ids', 'ids must be a list of collector ids.');
        }
        const host = this.options.collectors;
        const wanted = Array.isArray(ids) ? (ids as string[]).slice(0, 50) : undefined;
        sendJson(res, 200, { collectors: host ? await host.refresh(wanted) : [] });
      }),

      route('POST', 'session', ({ res, body }) => {
        const expected = config.token;
        if (expected === null) {
          // Nothing to exchange. Answering 204 lets the dashboard call this unconditionally.
          sendNoContent(res);
          return;
        }
        const given = typeof body === 'object' && body !== null ? (body as Record<string, unknown>)['token'] : undefined;
        if (typeof given !== 'string' || !safeEqual(given, expected)) {
          throw new HttpError(401, 'unauthorized', 'That is not the access token of this service.', {
            'WWW-Authenticate': 'Bearer'
          });
        }
        sendNoContent(res, { 'Set-Cookie': sessionCookie(this.sessions.issue()) });
      })
    ];
  }
}

/** Size and validator of a regular file, or null when there is nothing servable at the path. */
async function fileInfo(path: string): Promise<{ size: number; etag: string } | null> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return null;
    return { size: info.size, etag: `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"` };
  } catch {
    return null;
  }
}
