import { describe, expect, it } from 'vitest';

import {
  CONTENT_SECURITY_POLICY,
  SESSION_COOKIE,
  SessionStore,
  allowedHostNames,
  apiHeaders,
  bearerToken,
  hostLiteral,
  isAllowedHost,
  isAuthorised,
  isSameOrigin,
  isWildcardHost,
  parseHostHeader,
  parseSessionCookie,
  safeEqual,
  sessionCookie,
  staticHeaders
} from '../src/server/security.js';

const loopback = { configHost: '127.0.0.1', port: 4777 };

describe('Host header', () => {
  it('normalises host literals', () => {
    expect(hostLiteral(' LocalHost ')).toBe('localhost');
    expect(hostLiteral('::1')).toBe('[::1]');
    expect(hostLiteral('[::1]')).toBe('[::1]');
    expect(isWildcardHost('0.0.0.0')).toBe(true);
    expect(isWildcardHost('::')).toBe(true);
    expect(isWildcardHost('127.0.0.1')).toBe(false);
  });

  it('parses name and port', () => {
    expect(parseHostHeader('localhost:4777')).toEqual({ name: 'localhost', port: 4777 });
    expect(parseHostHeader('[::1]:4777')).toEqual({ name: '[::1]', port: 4777 });
    expect(parseHostHeader('Example.COM')).toEqual({ name: 'example.com', port: null });
    expect(parseHostHeader('localhost:4777/path')).toBeNull();
    expect(parseHostHeader('user@localhost:4777')).toBeNull();
    expect(parseHostHeader('localhost:port')).toBeNull();
    expect(parseHostHeader('')).toBeNull();
  });

  it('accepts every loopback name with the service port', () => {
    for (const host of ['localhost:4777', '127.0.0.1:4777', '[::1]:4777', 'LOCALHOST:4777']) {
      expect(isAllowedHost(host, loopback), host).toBe(true);
    }
  });

  it('rejects a foreign name, which is what a DNS rebinding attack sends', () => {
    for (const host of ['evil.example', 'evil.example:4777', 'localhost.evil.example:4777', '127.0.0.1.evil.example:4777']) {
      expect(isAllowedHost(host, loopback), host).toBe(false);
    }
  });

  it('rejects a missing or malformed header', () => {
    expect(isAllowedHost(undefined, loopback)).toBe(false);
    expect(isAllowedHost('', loopback)).toBe(false);
    expect(isAllowedHost('localhost:4777@evil.example', loopback)).toBe(false);
    expect(isAllowedHost('localhost:4777, evil.example', loopback)).toBe(false);
  });

  it('rejects the right name on another port', () => {
    expect(isAllowedHost('localhost:4778', loopback)).toBe(false);
    expect(isAllowedHost('localhost', loopback)).toBe(false);
  });

  it('treats a missing port as port 80', () => {
    expect(isAllowedHost('localhost', { configHost: '127.0.0.1', port: 80 })).toBe(true);
    expect(isAllowedHost('localhost:80', { configHost: '127.0.0.1', port: 80 })).toBe(true);
  });

  it('adds the configured host when the service is exposed on one', () => {
    const exposed = { configHost: '192.168.1.20', port: 4777 };
    expect(isAllowedHost('192.168.1.20:4777', exposed)).toBe(true);
    expect(isAllowedHost('localhost:4777', exposed)).toBe(true);
    expect(isAllowedHost('192.168.1.21:4777', exposed)).toBe(false);
    expect(isAllowedHost('192.168.1.20:4777', loopback)).toBe(false);
    expect(isAllowedHost('[fd00::5]:4777', { configHost: 'fd00::5', port: 4777 })).toBe(true);
  });

  it('on a wildcard bind accepts only the address the connection arrived on', () => {
    const wildcard = { configHost: '0.0.0.0', port: 4777, localAddress: '::ffff:192.168.1.20' };
    expect(allowedHostNames('0.0.0.0', '::ffff:192.168.1.20')).toContain('192.168.1.20');
    expect(isAllowedHost('192.168.1.20:4777', wildcard)).toBe(true);
    expect(isAllowedHost('127.0.0.1:4777', wildcard)).toBe(true);
    expect(isAllowedHost('192.168.1.99:4777', wildcard)).toBe(false);
    expect(isAllowedHost('evil.example:4777', wildcard)).toBe(false);
    // The local address means nothing when the service is bound to one address.
    expect(isAllowedHost('192.168.1.20:4777', { ...loopback, localAddress: '192.168.1.20' })).toBe(false);
  });
});

describe('Origin', () => {
  const host = '127.0.0.1:4777';

  it('lets requests without browser headers through', () => {
    expect(isSameOrigin({ host })).toBe(true);
  });

  it('accepts the service own origin', () => {
    expect(isSameOrigin({ host, origin: 'http://127.0.0.1:4777' })).toBe(true);
    expect(isSameOrigin({ host: 'LocalHost:4777', origin: 'http://localhost:4777', secFetchSite: 'same-origin' })).toBe(true);
    expect(isSameOrigin({ host, secFetchSite: 'none' })).toBe(true);
  });

  it('rejects any other origin', () => {
    for (const origin of [
      'https://evil.example',
      'http://evil.example:4777',
      'http://127.0.0.1:4778',
      'http://localhost:4777',
      'https://127.0.0.1:4777',
      'http://127.0.0.1:4777.evil.example',
      'null',
      ''
    ]) {
      expect(isSameOrigin({ host, origin }), origin).toBe(false);
    }
  });

  it('rejects what the browser itself calls cross-site or same-site', () => {
    expect(isSameOrigin({ host, secFetchSite: 'cross-site' })).toBe(false);
    expect(isSameOrigin({ host, secFetchSite: 'Cross-Site' })).toBe(false);
    expect(isSameOrigin({ host, secFetchSite: 'same-site' })).toBe(false);
    expect(isSameOrigin({ host, origin: 'http://127.0.0.1:4777', secFetchSite: 'cross-site' })).toBe(false);
  });

  it('accepts a null origin only when the browser vouches for same-origin', () => {
    expect(isSameOrigin({ host, origin: 'null', secFetchSite: 'same-origin' })).toBe(true);
    expect(isSameOrigin({ host, origin: 'null', secFetchSite: 'cross-site' })).toBe(false);
    expect(isSameOrigin({ host, origin: 'null', secFetchSite: 'none' })).toBe(false);
    expect(isSameOrigin({ host, origin: 'null' })).toBe(false);
  });
});

describe('Token', () => {
  it('compares without caring about length', () => {
    expect(safeEqual('correct horse battery', 'correct horse battery')).toBe(true);
    expect(safeEqual('correct horse battery', 'correct horse batterz')).toBe(false);
    expect(safeEqual('short', 'a much longer candidate value')).toBe(false);
    expect(safeEqual('', 'x')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
  });

  it('extracts a bearer credential', () => {
    expect(bearerToken('Bearer abc.def-123')).toBe('abc.def-123');
    expect(bearerToken('bearer   abc')).toBe('abc');
    expect(bearerToken('Basic abc')).toBeNull();
    expect(bearerToken('Bearer a passphrase with spaces ')).toBe('a passphrase with spaces');
    expect(bearerToken('Bearer')).toBeNull();
    expect(bearerToken('Bearer   ')).toBeNull();
    expect(bearerToken('Bearertoken')).toBeNull();
    expect(bearerToken(undefined)).toBeNull();
  });
});

describe('Session', () => {
  it('issues unguessable ids and recognises only those', () => {
    const sessions = new SessionStore();
    const first = sessions.issue();
    const second = sessions.issue();
    // 32 random bytes in base64url.
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second).not.toBe(first);
    expect(sessions.has(first)).toBe(true);
    expect(sessions.has(`${first}x`)).toBe(false);
    expect(sessions.has('')).toBe(false);
    expect(sessions.has(null)).toBe(false);
    sessions.clear();
    expect(sessions.has(first)).toBe(false);
  });

  it('forgets the oldest id beyond its limit', () => {
    const sessions = new SessionStore(2);
    const [a, b, c] = [sessions.issue(), sessions.issue(), sessions.issue()];
    expect(sessions.size).toBe(2);
    expect(sessions.has(a)).toBe(false);
    expect(sessions.has(b)).toBe(true);
    expect(sessions.has(c)).toBe(true);
  });

  it('writes a cookie scripts and other sites cannot use', () => {
    const cookie = sessionCookie('abc123');
    expect(cookie.startsWith(`${SESSION_COOKIE}=abc123`)).toBe(true);
    const attributes = cookie.split('; ').slice(1);
    expect(attributes).toEqual(expect.arrayContaining(['HttpOnly', 'SameSite=Strict', 'Path=/']));
    expect(SESSION_COOKIE).toBe('tg_session');
  });

  it('reads the session id out of a Cookie header', () => {
    expect(parseSessionCookie('tg_session=abc')).toBe('abc');
    expect(parseSessionCookie('theme=dark; tg_session=abc; other=1')).toBe('abc');
    expect(parseSessionCookie('xtg_session=abc')).toBeNull();
    expect(parseSessionCookie('tg_session=')).toBeNull();
    expect(parseSessionCookie('theme=dark')).toBeNull();
    expect(parseSessionCookie(undefined)).toBeNull();
  });

  it('authorises a bearer header or a minted cookie, nothing else', () => {
    const sessions = new SessionStore();
    const token = 'a-long-enough-test-token';
    const id = sessions.issue();
    expect(isAuthorised({ authorization: `Bearer ${token}` }, token, sessions)).toBe(true);
    expect(isAuthorised({ cookie: `tg_session=${id}` }, token, sessions)).toBe(true);
    expect(isAuthorised({ authorization: 'Bearer wrong-token-value-here' }, token, sessions)).toBe(false);
    expect(isAuthorised({ authorization: `Basic ${token}` }, token, sessions)).toBe(false);
    // The token itself is not a session id.
    expect(isAuthorised({ cookie: `tg_session=${token}` }, token, sessions)).toBe(false);
    expect(isAuthorised({}, token, sessions)).toBe(false);
  });
});

describe('Response headers', () => {
  it('keeps API answers out of caches and sniffers', () => {
    expect(apiHeaders()).toMatchObject({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  });

  it('locks the dashboard down to its own origin', () => {
    const headers = staticHeaders();
    expect(headers['Content-Security-Policy']).toBe(CONTENT_SECURITY_POLICY);
    expect(headers).toMatchObject({
      'Cache-Control': 'no-cache',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff'
    });
    expect(CONTENT_SECURITY_POLICY.split('; ')).toEqual([
      "default-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'none'"
    ]);
    // Scripts may only come from the service itself: no inline, no eval.
    expect(CONTENT_SECURITY_POLICY).not.toMatch(/script-src|unsafe-eval/);
  });
});
