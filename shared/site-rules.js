// Site rules: which hostnames the highlighting content scripts may run on.
//
// Pure by construction - no extension API, no storage, no DOM. Every entry
// point that has to answer "may I highlight here?" (background message
// authorization, context menus, dynamic script registration, the popup and the
// settings page, all through the background) resolves it here, so there is one
// matching implementation rather than one per caller.

export const SITE_POLICY_VERSION = 1;

export const SITE_MODES = Object.freeze({
  ALL: 'all',
  ALLOWLIST: 'allowlist',
});

// The pages highlighting is defined for at all. Everything else - about:,
// moz-extension:, chrome:, view-source: - is "not a page you can highlight",
// which is a different answer from "not on this site's allowlist".
//
// `file:` is here for the same reason `http:` is: a local page the reader
// opened is a page they can highlight. It has no hostname, which is why it can
// only ever be allowed by `all` mode - see `evaluateUrl`.
export const SUPPORTED_PROTOCOLS = Object.freeze(['http:', 'https:', 'file:']);

// Schemes whose authority can become a stored rule. `file://` has an empty
// host, so it is not one of them whatever the input looks like.
const RULE_PROTOCOLS = Object.freeze(['http:', 'https:']);

const MAX_HOSTNAME_LENGTH = 253;

// A hostname is a dot-separated list of alphanumeric/hyphen labels, or a
// bracketed IPv6 literal. `new URL` has already lowercased and punycoded it by
// the time this runs, so `xn--` labels and numeric IPv4 pass as ordinary labels.
const HOSTNAME_LABEL = /^[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?$/;
const IPV6_LITERAL = /^\[[0-9a-f:.]+\]$/;

/**
 * Whether a policy mode is one we know. Anything else reads as `all`, which is
 * the pre-existing behaviour of the extension.
 */
export function normalizeSiteMode(mode) {
  return mode === SITE_MODES.ALLOWLIST ? SITE_MODES.ALLOWLIST : SITE_MODES.ALL;
}

export function createDefaultSitePolicy() {
  return { version: SITE_POLICY_VERSION, mode: SITE_MODES.ALL, sites: [] };
}

function isAcceptableHostname(hostname) {
  if (!hostname || hostname.length > MAX_HOSTNAME_LENGTH) return false;
  if (hostname.startsWith('[')) return IPV6_LITERAL.test(hostname);
  return hostname.split('.').every(label => HOSTNAME_LABEL.test(label));
}

/**
 * Turn user input - a bare hostname, a host with a port, or a full page URL -
 * into a stored hostname. Returns null when the input cannot be one, which is
 * the answer for wildcards, `javascript:` URLs, credentials, and anything that
 * does not survive URL parsing.
 *
 * The parse is what does the normalising: lowercasing, trailing-dot removal,
 * IDN-to-punycode, and rejecting `*`. A trailing dot is stripped rather than
 * parsed, because `new URL('http://example.org./')` happily keeps it.
 */
export function normalizeHostname(rawInput) {
  if (typeof rawInput !== 'string') return null;

  let input = rawInput.trim();
  if (!input) return null;
  // Whitespace and control characters never appear in a hostname, and they are
  // how a value smuggled into a match pattern would try to break out of it.
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f]/.test(input)) return null;
  if (input.includes('*')) return null;

  const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\//i.exec(input);
  if (schemeMatch) {
    const scheme = `${schemeMatch[1].toLowerCase()}:`;
    if (!RULE_PROTOCOLS.includes(scheme)) return null;
    input = input.slice(schemeMatch[0].length);
  }

  // Drop the path, query and fragment. What is left is the authority, which
  // `new URL` will accept a port on and drop from `hostname`.
  const authority = input.split(/[/?#]/)[0];
  const hostPart = authority.trim();
  if (!hostPart) return null;

  let parsed;
  try {
    parsed = new URL(`http://${hostPart}/`);
  } catch {
    return null;
  }
  // A credential in the authority is not a hostname: storing the host it points
  // at would be a rule the user never typed.
  if (parsed.username || parsed.password) return null;

  const hostname = parsed.hostname.replace(/\.$/, '').toLowerCase();
  if (!isAcceptableHostname(hostname)) return null;
  return hostname;
}

/**
 * Split a stored rule into its two fields and validate them. Returns null for
 * anything that is not a usable rule, so callers can drop it silently rather
 * than keep a value that could never match.
 */
export function normalizeSiteRule(rawRule) {
  if (!rawRule || typeof rawRule !== 'object') return null;
  const hostname = normalizeHostname(typeof rawRule.hostname === 'string' ? rawRule.hostname : '');
  if (!hostname) return null;
  return { hostname, includeSubdomains: rawRule.includeSubdomains === true };
}

/**
 * Coerce anything read back from storage into a usable policy: known mode,
 * valid rules only, no duplicate hostnames, stable ordering.
 */
export function normalizeSitePolicy(rawPolicy) {
  const policy = createDefaultSitePolicy();
  if (!rawPolicy || typeof rawPolicy !== 'object') return policy;

  policy.mode = normalizeSiteMode(rawPolicy.mode);

  const byHostname = new Map();
  const sites = Array.isArray(rawPolicy.sites) ? rawPolicy.sites : [];
  for (const rawSite of sites) {
    const rule = normalizeSiteRule(rawSite);
    if (!rule) continue;
    const existing = byHostname.get(rule.hostname);
    // A duplicate entry is one rule: the wider of the two wins, because that is
    // the one the user asked about most recently if they ticked the box on
    // either copy.
    if (!existing) {
      byHostname.set(rule.hostname, rule);
    } else if (rule.includeSubdomains) {
      existing.includeSubdomains = true;
    }
  }

  policy.sites = [...byHostname.values()].sort((a, b) => a.hostname.localeCompare(b.hostname));
  return policy;
}

/**
 * Does one rule claim this hostname?
 *
 * `includeSubdomains` uses a dot boundary on purpose: `fakearxiv.org` must not
 * match a rule for `arxiv.org`, and a bare `endsWith(hostname)` would let it.
 */
export function matchesSiteRule(hostname, rule) {
  if (typeof hostname !== 'string' || !hostname) return false;
  if (!rule || typeof rule.hostname !== 'string') return false;
  if (hostname === rule.hostname) return true;
  return rule.includeSubdomains === true && hostname.endsWith(`.${rule.hostname}`);
}

/**
 * The rule that claims this hostname, or null. Used to answer "which entry do I
 * remove?" from the popup and the context menu.
 */
export function findMatchingSiteRule(hostname, sites) {
  if (!Array.isArray(sites)) return null;
  return sites.find(rule => matchesSiteRule(hostname, rule)) || null;
}

export function isHostAllowed(hostname, policy) {
  if (normalizeSiteMode(policy && policy.mode) === SITE_MODES.ALL) return true;
  return findMatchingSiteRule(hostname, policy && policy.sites) !== null;
}

/**
 * The one entry point for "what may happen on this URL".
 *
 * `supported` false is the about:/chrome:/view-source: case; `allowed` false
 * with supported true is the allowlist case. Callers that render a status need
 * both, because "not a page" and "not enabled here" are different sentences.
 *
 * `reason` is one of: 'mode-all', 'matched', 'not-listed', 'empty-allowlist',
 * 'unsupported-url'.
 */
export function evaluateUrl(url, policy) {
  let parsed = null;
  try {
    parsed = new URL(url);
  } catch {
    parsed = null;
  }

  if (!parsed || !SUPPORTED_PROTOCOLS.includes(parsed.protocol)) {
    return { supported: false, allowed: false, hostname: null, matchedRule: null, reason: 'unsupported-url' };
  }

  const normalized = normalizeSitePolicy(policy);

  // A local file has no hostname to put in an allowlist rule, so `all` is the
  // only mode that can allow it. Saying that plainly beats listing it as
  // "not-listed", which would send the reader looking for a rule to add.
  if (parsed.protocol === 'file:') {
    return {
      supported: true,
      allowed: normalized.mode === SITE_MODES.ALL,
      hostname: null,
      matchedRule: null,
      reason: normalized.mode === SITE_MODES.ALL ? 'mode-all' : 'file-not-allowlistable',
    };
  }

  const hostname = parsed.hostname.replace(/\.$/, '').toLowerCase();

  if (normalized.mode === SITE_MODES.ALL) {
    return { supported: true, allowed: true, hostname, matchedRule: null, reason: 'mode-all' };
  }

  const matchedRule = findMatchingSiteRule(hostname, normalized.sites);
  if (matchedRule) {
    return { supported: true, allowed: true, hostname, matchedRule, reason: 'matched' };
  }

  return {
    supported: true,
    allowed: false,
    hostname,
    matchedRule: null,
    reason: normalized.sites.length === 0 ? 'empty-allowlist' : 'not-listed',
  };
}

/**
 * Content-script match patterns for a policy.
 *
 * An empty allowlist registers nothing at all, which is the whole point of that
 * state: there is no pattern that could express it.
 *
 * `*` as the scheme means http and https only, so Firefox/Chrome internal pages
 * are excluded without a separate exclusion list. `file:///*` is the one extra
 * pattern `all` mode carries, because a local page is a page the reader can
 * highlight and no hostname rule could ever name it.
 */
export function buildMatchPatterns(policy) {
  const normalized = normalizeSitePolicy(policy);
  if (normalized.mode === SITE_MODES.ALL) return ['*://*/*', 'file:///*'];

  const patterns = [];
  for (const rule of normalized.sites) {
    // `*.example.org` matches example.org itself as well as its subdomains, so
    // one pattern covers both cases; the exact rule needs the bare host.
    patterns.push(rule.includeSubdomains ? `*://*.${rule.hostname}/*` : `*://${rule.hostname}/*`);
  }
  return patterns;
}

function withSites(policy, sites) {
  return normalizeSitePolicy({ ...policy, sites });
}

/**
 * Add a site rule. `added` is false when the hostname was already listed, which
 * makes repeat clicks from the popup and the context menu idempotent; ticking
 * "include subdomains" on an existing exact rule widens it instead of adding a
 * second entry.
 */
export function addSiteRule(policy, rawInput, includeSubdomains = false) {
  const normalized = normalizeSitePolicy(policy);
  const hostname = normalizeHostname(rawInput);
  if (!hostname) return { ok: false, reason: 'invalid-hostname', policy: normalized };

  const existing = normalized.sites.find(rule => rule.hostname === hostname);
  if (existing) {
    const widened = includeSubdomains === true && !existing.includeSubdomains;
    if (!widened) return { ok: true, added: false, hostname, policy: normalized };
    const sites = normalized.sites.map(rule =>
      rule.hostname === hostname ? { ...rule, includeSubdomains: true } : rule
    );
    return { ok: true, added: true, hostname, policy: withSites(normalized, sites) };
  }

  const sites = [...normalized.sites, { hostname, includeSubdomains: includeSubdomains === true }];
  return { ok: true, added: true, hostname, policy: withSites(normalized, sites) };
}

export function removeSiteRule(policy, rawInput) {
  const normalized = normalizeSitePolicy(policy);
  const hostname = normalizeHostname(rawInput);
  if (!hostname) return { ok: false, reason: 'invalid-hostname', removed: false, policy: normalized };

  const sites = normalized.sites.filter(rule => rule.hostname !== hostname);
  const removed = sites.length !== normalized.sites.length;
  return { ok: true, removed, hostname, policy: withSites(normalized, sites) };
}

export function setSiteRuleSubdomains(policy, rawInput, includeSubdomains) {
  const normalized = normalizeSitePolicy(policy);
  const hostname = normalizeHostname(rawInput);
  if (!hostname) return { ok: false, reason: 'invalid-hostname', updated: false, policy: normalized };

  let updated = false;
  const sites = normalized.sites.map(rule => {
    if (rule.hostname !== hostname) return rule;
    updated = true;
    return { ...rule, includeSubdomains: includeSubdomains === true };
  });
  if (!updated) return { ok: false, reason: 'not-found', updated: false, policy: normalized };

  return { ok: true, updated: true, hostname, policy: withSites(normalized, sites) };
}

export function setSiteMode(policy, mode) {
  return { ...normalizeSitePolicy(policy), mode: normalizeSiteMode(mode) };
}

/**
 * Render a policy for storage/backup equality checks and for the settings list.
 */
export function describeSiteRule(rule) {
  return rule.includeSubdomains ? `*.${rule.hostname}` : rule.hostname;
}
