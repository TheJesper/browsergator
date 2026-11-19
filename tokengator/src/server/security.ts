// Request validation for the local service (design D9). A web server on localhost is reachable from every
// page the user visits, so DNS rebinding and cross-site requests are the threats these checks exist for.
// Nothing here touches node:http: each rule is a plain function that can be tested on its own.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'tg_session';

const LOOPBACK_NAMES: readonly string[] = ['localhost', '127.0.0.1', '[::1]'];
const WILDCARD_HOSTS: ReadonlySet<string> = new Set(['0.0.0.0', '[::]']);

// ---------------------------------------------------------------------------
// Host
// ---------------------------------------------------------------------------

export interface HostCheck {
  /** The address the service was told to bind (`config.host`). */
  configHost: string;
  /** The port the connection arrived on. */
  port: number;
  /** The local address of the connection. Only consulted when the service is bound to every interface. */
  localAddress?: string | undefined;
}

/** Lower-cases a host and puts an IPv6 literal in the bracketed form a Host header uses. */
export function hostLiteral(host: string): string {
  const value = host.trim().toLowerCase();
  if (value.startsWith('[')) return value;
  return value.includes(':') ? `[${value}]` : value;
}

/** True for `0.0.0.0` and `::`, which mean "every interface" rather than one address. */
export function isWildcardHost(host: string): boolean {
  return WILDCARD_HOSTS.has(hostLiteral(host));
}

/** The host names (without port) a request may address this service by. */
export function allowedHostNames(configHost: string, localAddress?: string): string[] {
  const names = new Set<string>(LOOPBACK_NAMES);
  const configured = hostLiteral(configHost);
  if (configured) names.add(configured);
  // Bound to every interface, the service has no single name. The address a connection actually arrived
  // on is one of this machine's own and cannot be chosen by a web page, unlike a DNS name pointed here.
  if (WILDCARD_HOSTS.has(configured) && localAddress) {
    names.add(hostLiteral(localAddress.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '')));
  }
  return [...names];
}

/** Splits a Host header into name and port. Null when it is not a plain `name[:port]`. */
export function parseHostHeader(header: string): { name: string; port: number | null } | null {
  const match = /^(\[[0-9a-f:.]+\]|[a-z0-9._-]+)(?::(\d{1,5}))?$/.exec(header.trim().toLowerCase());
  if (!match) return null;
  return { name: match[1] as string, port: match[2] === undefined ? null : Number(match[2]) };
}

/**
 * The DNS-rebinding guard: a page on `evil.example` that re-points its name at 127.0.0.1 still sends
 * `Host: evil.example`, so only requests that name the service by one of its own addresses get through.
 */
export function isAllowedHost(header: string | undefined, check: HostCheck): boolean {
  if (!header) return false;
  const parsed = parseHostHeader(header);
  if (!parsed) return false;
  // A client leaves the port out only for the scheme's default, which is 80 for this plain-HTTP service.
  if ((parsed.port ?? 80) !== check.port) return false;
  return allowedHostNames(check.configHost, check.localAddress).includes(parsed.name);
}

// ---------------------------------------------------------------------------
// Origin
// ---------------------------------------------------------------------------

export interface OriginCheck {
  /** The request's Host header, already validated by `isAllowedHost`. */
  host: string;
  origin?: string | undefined;
  secFetchSite?: string | undefined;
}

/**
 * True unless a browser says the request was made by another site. Requests without either header come
 * from tools (curl, MCP clients, the CLI) and are not what this check is about: they hold no ambient
 * credentials of the user's browser.
 */
export function isSameOrigin(check: OriginCheck): boolean {
  const site = check.secFetchSite?.trim().toLowerCase() ?? '';
  // `none` is the user typing the address or opening a bookmark. Anything else that is not same-origin,
  // including another port on localhost, is some other application.
  if (site !== '' && site !== 'same-origin' && site !== 'none') return false;
  if (check.origin === undefined) return true;
  const origin = check.origin.trim().toLowerCase();
  if (origin === `http://${check.host.trim().toLowerCase()}`) return true;
  // The dashboard is served with `Referrer-Policy: no-referrer`, under which browsers may send
  // `Origin: null` on same-origin writes. Sandboxed frames on other sites send `null` too, so it is only
  // accepted together with the browser's own statement that the request is same-origin.
  return origin === 'null' && site === 'same-origin';
}

// ---------------------------------------------------------------------------
// Token and session
// ---------------------------------------------------------------------------

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  // timingSafeEqual needs equal-length buffers; comparing digests provides that without revealing how
  // long the expected value is.
  const left = createHash('sha256').update(a, 'utf8').digest();
  const right = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(left, right);
}

/** The credential of an `Authorization: Bearer <token>` header, or null. */
export function bearerToken(header: string | undefined): string | null {
  // Lenient about what the credential looks like: the configured token is free text, not a b64token.
  const match = /^Bearer +(\S(?:.*\S)?) *$/i.exec(header ?? '');
  return match ? (match[1] as string) : null;
}

/** Session ids minted by `POST /api/session`. In memory only: a restart signs every browser out. */
export class SessionStore {
  private readonly ids = new Set<string>();

  constructor(private readonly limit = 256) {}

  issue(): string {
    const id = randomBytes(32).toString('base64url');
    this.ids.add(id);
    // Every correct token exchange mints an id; forget the oldest so a reload loop cannot grow the set.
    while (this.ids.size > this.limit) {
      const oldest = this.ids.values().next();
      if (oldest.done) break;
      this.ids.delete(oldest.value);
    }
    return id;
  }

  has(id: string | null | undefined): boolean {
    return typeof id === 'string' && id !== '' && this.ids.has(id);
  }

  get size(): number {
    return this.ids.size;
  }

  clear(): void {
    this.ids.clear();
  }
}

/** The Set-Cookie value for a session id. HttpOnly keeps it from scripts, SameSite=Strict from other sites. */
export function sessionCookie(id: string): string {
  return `${SESSION_COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/`;
}

/** The session id in a Cookie header, or null. */
export function parseSessionCookie(header: string | undefined): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== SESSION_COOKIE) continue;
    const value = part.slice(separator + 1).trim();
    return value || null;
  }
  return null;
}

/** True when the request carries the token as a bearer header or a session cookie minted for it. */
export function isAuthorised(
  headers: { authorization?: string | undefined; cookie?: string | undefined },
  token: string,
  sessions: SessionStore
): boolean {
  const bearer = bearerToken(headers.authorization);
  if (bearer !== null && safeEqual(bearer, token)) return true;
  return sessions.has(parseSessionCookie(headers.cookie));
}

// ---------------------------------------------------------------------------
// Response headers
// ---------------------------------------------------------------------------

/** Same-origin scripts, styles, fonts and images, plus inline styles and data: images. Nothing else. */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ');

/** Headers of every API answer: never cached, never sniffed, never embedded by another origin. */
export function apiHeaders(): Record<string, string> {
  return {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'same-origin'
  };
}

/** Headers of the dashboard's own files. */
export function staticHeaders(): Record<string, string> {
  return {
    // Revalidate every time: a rebuilt bundle must not be masked by a cached one.
    'Cache-Control': 'no-cache',
    'Content-Security-Policy': CONTENT_SECURITY_POLICY,
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'same-origin'
  };
}
