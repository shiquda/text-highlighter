import { browserAPI } from '../shared/browser-api.js';
import { debugLog } from '../shared/logger.js';
import { sendMessageToTab } from '../shared/tab-broadcast.js';
import { SITE_POLICY_KEY } from '../constants/storage-keys.js';
import {
  createDefaultSitePolicy,
  normalizeSitePolicy,
  normalizeHostname,
  setSiteMode,
  addSiteRule as addSiteRuleToPolicy,
  removeSiteRule as removeSiteRuleFromPolicy,
  setSiteRuleSubdomains as setSubdomainsOnPolicy,
  evaluateUrl,
  findMatchingSiteRule,
  buildMatchPatterns,
} from '../shared/site-rules.js';

// The upstream build registered these eight files and styles.css statically on
// <all_urls>, so every page in every browser got them whether or not the user
// wanted that. They are registered dynamically now, per policy. The order is
// load-bearing: combining it would change what the scripts find on `window`.
export const CONTENT_SCRIPT_REGISTRATION_ID = 'marks-local-content';
export const CONTENT_SCRIPT_FILES = [
  'content-scripts/content-common.js',
  'content-scripts/minimap.js',
  'content-scripts/color-core.js',
  'content-scripts/content-core.js',
  'content-scripts/restore-core.js',
  'content-scripts/jump-core.js',
  'content-scripts/controls.js',
  'content-scripts/content.js',
];
export const CONTENT_SCRIPT_CSS = ['styles.css'];

// How many tabs to hot-inject into at once. Adding one site touches one tab, but
// switching an allowlist back to "all sites" touches every tab the user has open,
// and firing all of them at the browser at once is a burst it does not need.
const MAX_CONCURRENT_TAB_JOBS = 4;

const CHANGE_LISTENERS = new Set();
const injectionInFlight = new Map();

let writeQueue = Promise.resolve();

/**
 * Read the policy.
 *
 * Deliberately uncached: the read is one `storage.local.get` and this runs a
 * handful of times a minute (a save, a menu redraw on tab switch), while a
 * cache would need an invalidation path that any future writer - a second
 * background context, an import, a restore - would have to remember to call.
 */
export async function getSitePolicy() {
  let stored = null;
  try {
    const result = await browserAPI.storage.local.get(SITE_POLICY_KEY);
    stored = result[SITE_POLICY_KEY];
  } catch (e) {
    debugLog('Could not read site policy, starting from the default:', e.message);
  }
  return normalizeSitePolicy(stored);
}

export async function getSiteStatus(url) {
  const policy = await getSitePolicy();
  const evaluation = evaluateUrl(url, policy);
  return {
    supported: evaluation.supported,
    allowed: evaluation.allowed,
    hostname: evaluation.hostname,
    mode: policy.mode,
    matchedRule: evaluation.matchedRule,
    reason: evaluation.reason,
  };
}

/**
 * Whether a write is permitted on this URL. Every entry point that can create a
 * highlight asks this - the content script being absent is a convenience, not
 * the enforcement.
 */
export async function isUrlAllowed(url) {
  const policy = await getSitePolicy();
  return evaluateUrl(url, policy).allowed;
}

export function subscribeSitePolicyChanges(listener) {
  CHANGE_LISTENERS.add(listener);
  return () => CHANGE_LISTENERS.delete(listener);
}

async function notifySitePolicyChanges(policy) {
  for (const listener of CHANGE_LISTENERS) {
    try {
      await listener(policy);
    } catch (e) {
      debugLog('Site policy listener failed:', e.message);
    }
  }
}

/**
 * Serialise every mutation. Two writes that raced would each reconcile the
 * registration from their own view of the policy, and the loser would leave the
 * registered matches describing a list that no longer exists.
 */
function enqueue(task) {
  const result = writeQueue.then(task);
  writeQueue = result.then(() => undefined, () => undefined);
  return result;
}

async function persistPolicy(policy) {
  const normalized = normalizeSitePolicy(policy);
  await browserAPI.storage.local.set({ [SITE_POLICY_KEY]: normalized });
  return normalized;
}

function samePolicy(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function sameStringList(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

/**
 * Make the registered content scripts describe this policy.
 *
 * `registerContentScripts` only affects pages loaded afterwards, so this is
 * about new navigations; open tabs are handled separately by
 * `syncOpenTabsToPolicy`.
 *
 * The comparison against what is already registered keeps a settings page that
 * saves twice, or a browser restart that finds its own registrations intact,
 * from unregistering and re-registering the same thing.
 */
async function reconcileRegistration(policy) {
  const scripting = browserAPI.scripting;
  if (!scripting || !scripting.registerContentScripts) {
    // Firefox for Android does not expose the scripting API. There is no static
    // registration to fall back on, so the fork simply does not highlight there.
    debugLog('scripting API unavailable; content scripts will not be registered');
    return;
  }

  const patterns = buildMatchPatterns(policy);
  let registered = [];
  try {
    registered = await scripting.getRegisteredContentScripts();
  } catch (e) {
    debugLog('Could not read registered content scripts:', e.message);
  }
  const ours = registered.filter(script => script.id === CONTENT_SCRIPT_REGISTRATION_ID);

  try {
    if (patterns.length === 0) {
      if (ours.length > 0) {
        await scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_REGISTRATION_ID] });
        debugLog('Unregistered content scripts: the allowlist is empty');
      }
      return;
    }

    if (ours.length === 1 && sameStringList(ours[0].matches, patterns)) return;

    if (ours.length > 0) {
      await scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_REGISTRATION_ID] });
    }
    await scripting.registerContentScripts([{
      id: CONTENT_SCRIPT_REGISTRATION_ID,
      matches: patterns,
      js: CONTENT_SCRIPT_FILES,
      css: CONTENT_SCRIPT_CSS,
      persistAcrossSessions: true,
    }]);
    debugLog('Registered content scripts for', patterns.length, 'pattern(s)');
  } catch (e) {
    debugLog('Failed to reconcile content script registration:', e.message);
  }
}

async function queryHighlightableTabs() {
  let tabs = [];
  try {
    tabs = await browserAPI.tabs.query({});
  } catch (e) {
    debugLog('Could not list tabs for site policy sync:', e.message);
    return [];
  }
  return tabs.filter(tab =>
    typeof tab.id === 'number' &&
    typeof tab.url === 'string' &&
    evaluateUrl(tab.url, createDefaultSitePolicy()).supported
  );
}

/**
 * What the page currently has injected, read from the page itself.
 *
 * `executeScript` runs in the same isolated world as the declared scripts, so
 * `window` here is the same `window` they published their boot flags on.
 */
async function readContentScriptState(tabId) {
  const scripting = browserAPI.scripting;
  if (!scripting || !scripting.executeScript) return null;
  try {
    const results = await scripting.executeScript({
      target: { tabId },
      func: () => ({
        booted: window.__marksLocalContentBooted === true,
        ready: window.__marksLocalContentReady === true,
        disabled: window.__marksLocalContentDisabled === true,
      }),
    });
    const entry = Array.isArray(results) ? results[0] : null;
    return entry && entry.result ? entry.result : null;
  } catch (e) {
    // A page we cannot script at all - a Firefox internal page, a tab that
    // navigated away, a dropped permission. The caller reports a refresh.
    debugLog('Could not read content script state for tab', tabId, e.message);
    return null;
  }
}

async function injectContentScriptsOnce(tabId) {
  const state = await readContentScriptState(tabId);
  if (!state) return 'failed';
  // Ready and not torn down is the only "already there" case. A page that
  // booted and then tore down (or booted but never finished loading) cannot be
  // hot-injected into: re-running the files is a fatal redeclaration inside
  // content-common.js/content.js, which would leave the page running half a
  // script set. Reloading is the only honest fix, so say so.
  if (state.ready && !state.disabled) return 'already';
  if (state.booted) return 'needs-refresh';

  const scripting = browserAPI.scripting;
  try {
    await scripting.executeScript({ target: { tabId }, files: CONTENT_SCRIPT_FILES });
    await scripting.insertCSS({ target: { tabId }, files: CONTENT_SCRIPT_CSS });
    return 'injected';
  } catch (e) {
    debugLog('Hot injection failed for tab', tabId, e.message);
    return 'failed';
  }
}

/**
 * Hot-inject one tab, at most once at a time.
 *
 * The popup, the context menu and a policy change can all decide the same tab
 * needs injecting within the same few milliseconds, and two overlapping
 * `executeScript` calls would both read "not booted" and both inject.
 */
export function hotInjectTab(tabId) {
  const pending = injectionInFlight.get(tabId) || Promise.resolve();
  const next = pending.then(
    () => injectContentScriptsOnce(tabId),
    () => injectContentScriptsOnce(tabId)
  );
  const settled = next.catch(() => 'failed');
  injectionInFlight.set(tabId, settled);
  settled.then(() => {
    if (injectionInFlight.get(tabId) === settled) injectionInFlight.delete(tabId);
  });
  return next;
}

async function forEachLimited(items, limit, task) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length > 0) {
      await task(queue.shift());
    }
  });
  await Promise.all(workers);
}

/**
 * Bring already-open tabs in line with a policy change.
 *
 * Only tabs whose allowed-ness actually changed are touched: `mode: all` with a
 * list attached is the same policy for every page as `mode: all` without one, so
 * a switch that only edits the list under an inactive mode does nothing.
 */
async function syncOpenTabsToPolicy(previous, next) {
  const tabs = await queryHighlightableTabs();
  const toInject = [];
  const toTearDown = [];

  for (const tab of tabs) {
    const wasAllowed = evaluateUrl(tab.url, previous).allowed;
    const isAllowed = evaluateUrl(tab.url, next).allowed;
    if (wasAllowed === isAllowed) continue;
    (isAllowed ? toInject : toTearDown).push(tab.id);
  }

  let injected = 0;
  let needsRefresh = false;

  await forEachLimited(toInject, MAX_CONCURRENT_TAB_JOBS, async (tabId) => {
    const outcome = await hotInjectTab(tabId);
    if (outcome === 'injected') injected += 1;
    else if (outcome === 'needs-refresh' || outcome === 'failed') needsRefresh = true;
  });

  // A tab that keeps its script after the site was removed would still accept a
  // highlight through the message path, so it is told to stand down. One that
  // never had the script has no listener and the message simply goes nowhere.
  await forEachLimited(toTearDown, MAX_CONCURRENT_TAB_JOBS, async (tabId) => {
    await sendMessageToTab(tabId, { action: 'siteDisabled' });
  });

  return { injected, needsRefresh, tornDown: toTearDown.length };
}

async function commitPolicyChange(previous, next, outcome) {
  if (samePolicy(previous, next)) return { ...outcome, policy: previous, injected: 0, needsRefresh: false, tornDown: 0 };

  const policy = await persistPolicy(next);
  await reconcileRegistration(policy);
  const effects = await syncOpenTabsToPolicy(previous, policy);
  await notifySitePolicyChanges(policy);
  return { ...outcome, policy, ...effects };
}

function mutatePolicy(mutator) {
  return enqueue(async () => {
    const previous = await getSitePolicy();
    const outcome = mutator(previous);
    if (!outcome.ok) return { ...outcome, policy: previous };
    return commitPolicyChange(previous, outcome.policy, outcome);
  });
}

export function applySiteMode(mode) {
  return mutatePolicy(policy => ({ ok: true, policy: setSiteMode(policy, mode) }));
}

export function addSite(input, includeSubdomains = false) {
  return mutatePolicy(policy => addSiteRuleToPolicy(policy, input, includeSubdomains));
}

export function removeSite(input) {
  // A user on `www.arxiv.org` clicking "remove" means the rule that is letting
  // them highlight there, which is the rule for `arxiv.org` - asking them to
  // know which entry claims the page would be a worse answer than just
  // resolving it. The settings list passes an exact hostname, which its own
  // rule matches, so both entry points land on the same rule.
  return mutatePolicy(policy => {
    const hostname = normalizeHostname(input);
    if (!hostname) return removeSiteRuleFromPolicy(policy, input);
    const matched = findMatchingSiteRule(hostname, policy.sites);
    return removeSiteRuleFromPolicy(policy, matched ? matched.hostname : hostname);
  });
}

export function updateSiteSubdomains(input, includeSubdomains) {
  return mutatePolicy(policy => setSubdomainsOnPolicy(policy, input, includeSubdomains));
}

/**
 * Make the browser agree with the stored policy.
 *
 * Called once per browser session - the registrations survive a restart
 * (`persistAcrossSessions`), so this is what catches a policy that was edited
 * while an unregistration failed, or a registration a previous version left
 * behind - and again after a restore, which writes the policy key behind this
 * service's back.
 */
export async function initSiteRuleService() {
  const policy = await getSitePolicy();
  await enqueue(() => reconcileRegistration(policy));
  await notifySitePolicyChanges(policy);
  return policy;
}

/**
 * The status of whatever tab the user is looking at, for the context menu and
 * for callers that have no URL of their own.
 */
export async function getActiveTabSiteStatus() {
  const tabs = await browserAPI.tabs.query({ active: true, currentWindow: true });
  const tab = tabs && tabs[0];
  if (!tab) return { tabId: null, url: null, status: null };
  return { tabId: tab.id, url: tab.url, status: tab.url ? await getSiteStatus(tab.url) : null };
}
