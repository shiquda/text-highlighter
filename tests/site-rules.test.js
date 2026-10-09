import { describe, test, expect } from '@jest/globals';
import {
  SITE_MODES,
  createDefaultSitePolicy,
  normalizeSiteMode,
  normalizeHostname,
  normalizeSitePolicy,
  matchesSiteRule,
  findMatchingSiteRule,
  isHostAllowed,
  evaluateUrl,
  buildMatchPatterns,
  addSiteRule,
  removeSiteRule,
  setSiteRuleSubdomains,
  setSiteMode,
  describeSiteRule,
} from '../shared/site-rules.js';

const ALLOWLIST_EMPTY = { version: 1, mode: SITE_MODES.ALLOWLIST, sites: [] };

function allowlist(hostname, includeSubdomains = false) {
  return { version: 1, mode: SITE_MODES.ALLOWLIST, sites: [{ hostname, includeSubdomains }] };
}

describe('normalizeHostname', () => {
  test('takes the hostname out of a full page URL', () => {
    expect(normalizeHostname('https://arxiv.org/abs/2401.00001?tab=1#top')).toBe('arxiv.org');
    expect(normalizeHostname('http://example.org/a/b')).toBe('example.org');
  });

  test('accepts a bare hostname, with or without a path', () => {
    expect(normalizeHostname('arxiv.org')).toBe('arxiv.org');
    expect(normalizeHostname('arxiv.org/abs/1')).toBe('arxiv.org');
    expect(normalizeHostname('  arxiv.org  ')).toBe('arxiv.org');
  });

  test('lowercases and drops the trailing dot', () => {
    expect(normalizeHostname('EXAMPLE.ORG.')).toBe('example.org');
  });

  test('converts an internationalised domain to its punycode form', () => {
    expect(normalizeHostname('例え.jp')).toBe('xn--r8jz45g.jp');
    expect(normalizeHostname('https://例え.jp/path')).toBe('xn--r8jz45g.jp');
  });

  test('keeps localhost and IP literals as hostnames', () => {
    expect(normalizeHostname('localhost')).toBe('localhost');
    expect(normalizeHostname('localhost:8080')).toBe('localhost');
    expect(normalizeHostname('192.168.1.10:3000/path')).toBe('192.168.1.10');
    expect(normalizeHostname('[::1]:8080')).toBe('[::1]');
  });

  test('refuses wildcards, credentials and non-http(s) schemes', () => {
    expect(normalizeHostname('*.arxiv.org')).toBeNull();
    expect(normalizeHostname('arxiv.*')).toBeNull();
    expect(normalizeHostname('http://user:pw@evil.example/')).toBeNull();
    expect(normalizeHostname('ftp://example.org')).toBeNull();
    expect(normalizeHostname('javascript:alert(1)')).toBeNull();
    expect(normalizeHostname('file:///etc/hosts')).toBeNull();
  });

  test('refuses values that are not hostnames at all', () => {
    expect(normalizeHostname('')).toBeNull();
    expect(normalizeHostname('   ')).toBeNull();
    expect(normalizeHostname('exam ple.org')).toBeNull();
    expect(normalizeHostname('example.org\n/api')).toBeNull();
    expect(normalizeHostname(null)).toBeNull();
    expect(normalizeHostname(42)).toBeNull();
    expect(normalizeHostname('-leading.example')).toBeNull();
  });
});

describe('matchesSiteRule', () => {
  test('an exact rule matches only its own host', () => {
    const rule = { hostname: 'arxiv.org', includeSubdomains: false };
    expect(matchesSiteRule('arxiv.org', rule)).toBe(true);
    expect(matchesSiteRule('www.arxiv.org', rule)).toBe(false);
  });

  test('includeSubdomains matches subdomains and the host itself', () => {
    const rule = { hostname: 'arxiv.org', includeSubdomains: true };
    expect(matchesSiteRule('arxiv.org', rule)).toBe(true);
    expect(matchesSiteRule('www.arxiv.org', rule)).toBe(true);
    expect(matchesSiteRule('a.b.arxiv.org', rule)).toBe(true);
  });

  test('a hostname that merely ends with the rule is not a subdomain', () => {
    const rule = { hostname: 'arxiv.org', includeSubdomains: true };
    expect(matchesSiteRule('fakearxiv.org', rule)).toBe(false);
    expect(matchesSiteRule('notarxiv.org', rule)).toBe(false);
  });
});

describe('normalizeSitePolicy', () => {
  test('falls back to a usable policy for junk input', () => {
    expect(normalizeSitePolicy(undefined)).toEqual(createDefaultSitePolicy());
    expect(normalizeSitePolicy('nonsense')).toEqual(createDefaultSitePolicy());
    expect(normalizeSitePolicy({ mode: 'whatever', sites: 'no' })).toEqual(createDefaultSitePolicy());
  });

  test('drops rules it cannot use and de-duplicates the rest by hostname', () => {
    const policy = normalizeSitePolicy({
      mode: 'allowlist',
      sites: [
        { hostname: 'B.org' },
        { hostname: 'b.org', includeSubdomains: true },
        { hostname: '*.wild.example' },
        { hostname: '' },
        { hostname: 'a.org' },
      ],
    });
    expect(policy.sites).toEqual([
      { hostname: 'a.org', includeSubdomains: false },
      { hostname: 'b.org', includeSubdomains: true },
    ]);
  });

  test('an unknown mode reads as all', () => {
    expect(normalizeSiteMode('allowlist')).toBe('allowlist');
    expect(normalizeSiteMode('ALLOWLIST')).toBe('all');
    expect(normalizeSiteMode(undefined)).toBe('all');
  });
});

describe('evaluateUrl', () => {
  test('all mode allows every ordinary page', () => {
    expect(evaluateUrl('https://anything.example/x', createDefaultSitePolicy()).allowed).toBe(true);
    expect(evaluateUrl('http://anything.example/x', createDefaultSitePolicy()).reason).toBe('mode-all');
  });

  test('an empty allowlist allows nothing, and says why', () => {
    const evaluation = evaluateUrl('https://arxiv.org/x', ALLOWLIST_EMPTY);
    expect(evaluation.allowed).toBe(false);
    expect(evaluation.supported).toBe(true);
    expect(evaluation.reason).toBe('empty-allowlist');
  });

  test('a listed host is allowed over both http and https, on any port and path', () => {
    const policy = allowlist('arxiv.org');
    expect(evaluateUrl('https://arxiv.org/abs/1', policy).allowed).toBe(true);
    expect(evaluateUrl('http://arxiv.org:8080/abs/1?q=1', policy).allowed).toBe(true);
  });

  test('subdomain rules widen exactly one level of matching, never a suffix match', () => {
    const policy = allowlist('arxiv.org', true);
    expect(evaluateUrl('https://www.arxiv.org/x', policy).allowed).toBe(true);
    expect(evaluateUrl('https://fakearxiv.org/x', policy).allowed).toBe(false);
  });

  test('browser-internal and non-page URLs are unsupported, not merely disallowed', () => {
    for (const url of ['about:config', 'moz-extension://abc/popup.html', 'view-source:https://example.com/', 'not a url']) {
      const evaluation = evaluateUrl(url, createDefaultSitePolicy());
      expect(evaluation.supported).toBe(false);
      expect(evaluation.allowed).toBe(false);
      expect(evaluation.reason).toBe('unsupported-url');
    }
  });

  test('a local file is highlightable in all mode and in no allowlist', () => {
    const file = 'file:///Users/reader/notes.html';

    const everywhere = evaluateUrl(file, createDefaultSitePolicy());
    expect(everywhere).toMatchObject({ supported: true, allowed: true, hostname: null, reason: 'mode-all' });

    // It has no hostname, so no rule could name it. Saying that is better than
    // reporting the empty allowlist as the reason.
    const listed = evaluateUrl(file, allowlist('example.com'));
    expect(listed).toMatchObject({ supported: true, allowed: false, hostname: null, reason: 'file-not-allowlistable' });
    expect(evaluateUrl(file, ALLOWLIST_EMPTY).allowed).toBe(false);
  });

  test('reports the rule that matched, so the popup can offer to remove it', () => {
    const policy = allowlist('arxiv.org', true);
    expect(evaluateUrl('https://www.arxiv.org/x', policy).matchedRule).toEqual({
      hostname: 'arxiv.org',
      includeSubdomains: true,
    });
    expect(evaluateUrl('https://other.example/x', policy).matchedRule).toBeNull();
  });
});

describe('buildMatchPatterns', () => {
  test('all mode covers http, https and local files without an exclusion list', () => {
    expect(buildMatchPatterns(createDefaultSitePolicy())).toEqual(['*://*/*', 'file:///*']);
  });

  test('an empty allowlist registers nothing', () => {
    expect(buildMatchPatterns(ALLOWLIST_EMPTY)).toEqual([]);
  });

  test('a subdomain rule uses one pattern for the host and its subdomains', () => {
    expect(buildMatchPatterns(allowlist('arxiv.org', true))).toEqual(['*://*.arxiv.org/*']);
    expect(buildMatchPatterns(allowlist('arxiv.org', false))).toEqual(['*://arxiv.org/*']);
  });

  test('rules keep the policy order, which is sorted by hostname', () => {
    const policy = {
      mode: 'allowlist',
      sites: [
        { hostname: 'github.com', includeSubdomains: false },
        { hostname: 'arxiv.org', includeSubdomains: true },
      ],
    };
    expect(buildMatchPatterns(policy)).toEqual(['*://*.arxiv.org/*', '*://github.com/*']);
  });
});

describe('rule edits', () => {
  test('adding normalises the input and is idempotent', () => {
    const first = addSiteRule(ALLOWLIST_EMPTY, 'https://arxiv.org/abs/1');
    expect(first.ok).toBe(true);
    expect(first.added).toBe(true);
    expect(first.hostname).toBe('arxiv.org');

    const again = addSiteRule(first.policy, 'arxiv.org');
    expect(again.added).toBe(false);
    expect(again.policy.sites).toHaveLength(1);
  });

  test('ticking include subdomains on an existing exact rule widens it instead of adding a row', () => {
    const added = addSiteRule(ALLOWLIST_EMPTY, 'arxiv.org', false);
    const widened = addSiteRule(added.policy, 'arxiv.org', true);
    expect(widened.added).toBe(true);
    expect(widened.policy.sites).toEqual([{ hostname: 'arxiv.org', includeSubdomains: true }]);
  });

  test('an unusable input changes nothing and says why', () => {
    const outcome = addSiteRule(ALLOWLIST_EMPTY, '*.example.org');
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('invalid-hostname');
    expect(outcome.policy.sites).toEqual([]);
  });

  test('removing takes the rule out and leaves the mode alone', () => {
    const added = addSiteRule(ALLOWLIST_EMPTY, 'arxiv.org', true);
    const removed = removeSiteRule(added.policy, 'www.arxiv.org');
    expect(removed.ok).toBe(true);
    // A subdomain page removes the rule it matched, which is the rule for the
    // registered host, but only when the caller passes that host. Passing the
    // page's own subdomain is not the same hostname, so nothing is removed.
    expect(removed.removed).toBe(false);

    const removedHost = removeSiteRule(added.policy, 'arxiv.org');
    expect(removedHost.removed).toBe(true);
    expect(removedHost.policy.sites).toEqual([]);
    expect(removedHost.policy.mode).toBe(SITE_MODES.ALLOWLIST);
  });

  test('flipping the subdomain flag on a missing rule reports not-found', () => {
    const outcome = setSiteRuleSubdomains(ALLOWLIST_EMPTY, 'arxiv.org', true);
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('not-found');
  });

  test('switching mode keeps the list, which is what makes it reversible', () => {
    const listed = addSiteRule(ALLOWLIST_EMPTY, 'arxiv.org', false).policy;
    const all = setSiteMode(listed, 'all');
    expect(all.mode).toBe('all');
    expect(all.sites).toHaveLength(1);
    expect(evaluateUrl('https://other.example/', all).allowed).toBe(true);

    const back = setSiteMode(all, 'allowlist');
    expect(evaluateUrl('https://arxiv.org/', back).allowed).toBe(true);
    expect(evaluateUrl('https://other.example/', back).allowed).toBe(false);
  });
});

describe('describeSiteRule', () => {
  test('renders the subdomain form the settings list shows', () => {
    expect(describeSiteRule({ hostname: 'arxiv.org', includeSubdomains: false })).toBe('arxiv.org');
    expect(describeSiteRule({ hostname: 'arxiv.org', includeSubdomains: true })).toBe('*.arxiv.org');
  });

  test('isHostAllowed and findMatchingSiteRule agree with evaluateUrl', () => {
    const policy = allowlist('arxiv.org', true);
    expect(isHostAllowed('www.arxiv.org', policy)).toBe(true);
    expect(isHostAllowed('fakearxiv.org', policy)).toBe(false);
    expect(findMatchingSiteRule('www.arxiv.org', policy.sites).hostname).toBe('arxiv.org');
    expect(findMatchingSiteRule('fakearxiv.org', policy.sites)).toBeNull();
    expect(isHostAllowed('anything.example', createDefaultSitePolicy())).toBe(true);
  });
});
