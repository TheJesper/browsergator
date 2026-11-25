import { describe, expect, it } from 'vitest';

import { loadConfig, resolveSiteAuth } from '../src/config.js';
import { siteAuthRuleFor } from '../src/cdp/websocket-cdp-driver.js';

const rules = [{ origin: 'https://wiki.example', authorization: 'Bearer secret-token' }];

describe('site auth', () => {
  it('resolves only configured env vars and never needs the token in config', () => {
    const resolved = resolveSiteAuth(['https://wiki.example=WIKI_TOKEN', 'https://jira.example=MISSING_TOKEN'], { WIKI_TOKEN: ' abc ' });
    expect(resolved).toEqual([{ origin: 'https://wiki.example', authorization: 'Bearer abc' }]);
    const config = loadConfig({ BROWSER_GATEWAY_TOKEN: 'x'.repeat(32), BROWSER_GATEWAY_SITE_AUTH: 'https://wiki.example=WIKI_TOKEN' });
    expect(config.siteAuth).toEqual(['https://wiki.example=WIKI_TOKEN']);
    expect(() => loadConfig({ BROWSER_GATEWAY_TOKEN: 'x'.repeat(32), BROWSER_GATEWAY_SITE_AUTH: 'http://wiki.example=TOKEN' }))
      .toThrow(/https:\/\/host=ENV_VAR_NAME/);
  });

  it('adds the header to navigations and same-origin page requests only', () => {
    expect(siteAuthRuleFor(rules, 'https://wiki.example/pages/1', 'Document', 'about:blank')).toBe(rules[0]);
    expect(siteAuthRuleFor(rules, 'https://wiki.example/rest/api/content', 'XHR', 'https://wiki.example/pages/1')).toBe(rules[0]);
    expect(siteAuthRuleFor(rules, 'https://wiki.example/rest/api/content', 'Fetch', 'https://evil.example/')).toBeUndefined();
    expect(siteAuthRuleFor(rules, 'https://wiki.example.evil/x', 'Document', 'about:blank')).toBeUndefined();
    expect(siteAuthRuleFor(rules, 'https://other.example/x', 'Document', 'https://wiki.example/')).toBeUndefined();
    expect(siteAuthRuleFor(rules, 'https://wiki.example/x', 'Document', undefined, { Authorization: 'Basic own' })).toBeUndefined();
  });
});
