import { jest } from '@jest/globals';
import chrome from '../mocks/chrome.js';
import { SITE_POLICY_KEY } from '../constants/storage-keys.js';

const ALL = { version: 1, mode: 'all', sites: [] };
const PAGE = 'https://example.com/article';

/**
 * A fresh service per test: the write queue and the per-tab injection chains
 * are module state, and a shared copy would make the order tests run in matter.
 */
async function freshService() {
  jest.resetModules();
  return import('../background/site-rule-service.js');
}

/**
 * Back storage.local with a real object, so a handler that reads, changes and
 * writes again sees its own writes.
 */
function installLocal(initial = {}) {
  const store = { ...initial };
  chrome.storage.local.get.mockImplementation(async keys => {
    if (keys === null || keys === undefined) return { ...store };
    const wanted = Array.isArray(keys) ? keys : [keys];
    const out = {};
    wanted.forEach(key => { if (key in store) out[key] = store[key]; });
    return out;
  });
  chrome.storage.local.set.mockImplementation(async items => { Object.assign(store, items); });
  chrome.storage.local.remove.mockImplementation(async keys => {
    (Array.isArray(keys) ? keys : [keys]).forEach(key => { delete store[key]; });
  });
  return store;
}

/**
 * The scripting API keeps a list, so "did it register the right thing" is a
 * question about state rather than about call order.
 */
function installRegistrationStore() {
  let registered = [];
  chrome.scripting.getRegisteredContentScripts.mockImplementation(async () => registered.map(script => ({ ...script })));
  chrome.scripting.registerContentScripts.mockImplementation(async scripts => {
    registered = [...registered.filter(existing => !scripts.some(script => script.id === existing.id)), ...scripts];
  });
  chrome.scripting.unregisterContentScripts.mockImplementation(async ({ ids }) => {
    registered = registered.filter(script => !ids.includes(script.id));
  });
  return () => registered;
}

function contentScriptState(state) {
  chrome.scripting.executeScript.mockImplementation(async options => {
    if (options.func) return [{ result: state }];
    return [];
  });
}

function injectedFiles() {
  return chrome.scripting.executeScript.mock.calls
    .filter(([options]) => Array.isArray(options.files))
    .map(([options]) => options.files);
}

const BOOTED = { booted: true, ready: true, disabled: false };
const NOT_BOOTED = { booted: false, ready: false, disabled: false };
const TORN_DOWN = { booted: true, ready: false, disabled: true };

describe('site-rule-service', () => {
  let local;

  beforeEach(() => {
    jest.clearAllMocks();
    local = installLocal();
    chrome.tabs.query.mockResolvedValue([]);
  });

  describe('content script registration', () => {
    it('registers the eight scripts in load order, with their stylesheet, on every http page', async () => {
      const getRegistered = installRegistrationStore();
      const { initSiteRuleService, CONTENT_SCRIPT_REGISTRATION_ID } = await freshService();

      await initSiteRuleService();

      const registered = getRegistered();
      expect(registered).toHaveLength(1);
      expect(registered[0].id).toBe(CONTENT_SCRIPT_REGISTRATION_ID);
      expect(registered[0].matches).toEqual(['*://*/*', 'file:///*']);
      expect(registered[0].js).toEqual([
        'content-scripts/content-common.js',
        'content-scripts/minimap.js',
        'content-scripts/color-core.js',
        'content-scripts/content-core.js',
        'content-scripts/restore-core.js',
        'content-scripts/jump-core.js',
        'content-scripts/controls.js',
        'content-scripts/content.js',
      ]);
      expect(registered[0].css).toEqual(['styles.css']);
      expect(registered[0].persistAcrossSessions).toBe(true);
    });

    it('registers nothing at all while the allowlist is empty', async () => {
      const getRegistered = installRegistrationStore();
      installLocal({ [SITE_POLICY_KEY]: { version: 1, mode: 'allowlist', sites: [] } });
      const { initSiteRuleService } = await freshService();

      await initSiteRuleService();

      expect(getRegistered()).toEqual([]);
      expect(chrome.scripting.registerContentScripts).not.toHaveBeenCalled();
    });

    it('builds the allowlist patterns from the rules, subdomains included', async () => {
      const getRegistered = installRegistrationStore();
      installLocal({
        [SITE_POLICY_KEY]: {
          version: 1,
          mode: 'allowlist',
          sites: [
            { hostname: 'github.com', includeSubdomains: false },
            { hostname: 'arxiv.org', includeSubdomains: true },
          ],
        },
      });
      const { initSiteRuleService } = await freshService();

      await initSiteRuleService();

      expect(getRegistered()[0].matches).toEqual(['*://*.arxiv.org/*', '*://github.com/*']);
    });

    it('leaves an intact registration alone rather than cycling it on every start', async () => {
      const getRegistered = installRegistrationStore();
      const { initSiteRuleService } = await freshService();

      await initSiteRuleService();
      chrome.scripting.registerContentScripts.mockClear();
      chrome.scripting.unregisterContentScripts.mockClear();

      await initSiteRuleService();

      expect(getRegistered()).toHaveLength(1);
      expect(chrome.scripting.registerContentScripts).not.toHaveBeenCalled();
      expect(chrome.scripting.unregisterContentScripts).not.toHaveBeenCalled();
    });

    it('replaces the registration when the policy changes, leaving no duplicate id', async () => {
      const getRegistered = installRegistrationStore();
      local[SITE_POLICY_KEY] = { version: 1, mode: 'allowlist', sites: [{ hostname: 'github.com', includeSubdomains: false }] };
      const { initSiteRuleService, addSite } = await freshService();

      await initSiteRuleService();
      await addSite('arxiv.org');

      const registered = getRegistered();
      expect(registered).toHaveLength(1);
      expect(registered[0].matches).toEqual(['*://arxiv.org/*', '*://github.com/*']);
    });

    it('survives a scripting API that is not there, as on Firefox for Android', async () => {
      const scripting = chrome.scripting;
      delete chrome.scripting;
      const { initSiteRuleService } = await freshService();

      await expect(initSiteRuleService()).resolves.toBeDefined();

      chrome.scripting = scripting;
    });
  });

  describe('policy writes', () => {
    it('serialises concurrent writes so every rule lands and one registration describes them all', async () => {
      const getRegistered = installRegistrationStore();
      local = installLocal({ [SITE_POLICY_KEY]: { version: 1, mode: 'allowlist', sites: [] } });
      const { addSite } = await freshService();

      await Promise.all([addSite('a.example'), addSite('b.example'), addSite('c.example')]);

      expect(local[SITE_POLICY_KEY].sites.map(rule => rule.hostname)).toEqual(['a.example', 'b.example', 'c.example']);
      expect(getRegistered()[0].matches).toEqual(['*://a.example/*', '*://b.example/*', '*://c.example/*']);
    });

    it('reports the outcome of an add and of a repeated add', async () => {
      const { addSite } = await freshService();

      const first = await addSite('arxiv.org');
      const again = await addSite('arxiv.org');

      expect(first).toMatchObject({ ok: true, added: true, hostname: 'arxiv.org' });
      expect(again).toMatchObject({ ok: true, added: false });
      expect(local[SITE_POLICY_KEY].sites).toHaveLength(1);
    });

    it('answers isUrlAllowed from the stored policy', async () => {
      local[SITE_POLICY_KEY] = { version: 1, mode: 'allowlist', sites: [{ hostname: 'arxiv.org', includeSubdomains: false }] };
      const { isUrlAllowed } = await freshService();

      expect(await isUrlAllowed('https://arxiv.org/x')).toBe(true);
      expect(await isUrlAllowed('https://www.arxiv.org/x')).toBe(false);
      expect(await isUrlAllowed('about:config')).toBe(false);
    });
  });

  describe('hot injection', () => {
    it('injects into a page that has nothing yet', async () => {
      installRegistrationStore();
      contentScriptState(NOT_BOOTED);
      const { hotInjectTab } = await freshService();

      expect(await hotInjectTab(3)).toBe('injected');
      expect(injectedFiles()).toEqual([[
        'content-scripts/content-common.js',
        'content-scripts/minimap.js',
        'content-scripts/color-core.js',
        'content-scripts/content-core.js',
        'content-scripts/restore-core.js',
        'content-scripts/jump-core.js',
        'content-scripts/controls.js',
        'content-scripts/content.js',
      ]]);
      expect(chrome.scripting.insertCSS).toHaveBeenCalledWith({ target: { tabId: 3 }, files: ['styles.css'] });
    });

    it('does not inject twice into a page that is already running', async () => {
      installRegistrationStore();
      contentScriptState(BOOTED);
      const { hotInjectTab } = await freshService();

      expect(await hotInjectTab(3)).toBe('already');
      expect(injectedFiles()).toEqual([]);
    });

    it('asks for a reload rather than half-injecting into a page it stopped running on', async () => {
      installRegistrationStore();
      contentScriptState(TORN_DOWN);
      const { hotInjectTab } = await freshService();

      expect(await hotInjectTab(3)).toBe('needs-refresh');
      expect(injectedFiles()).toEqual([]);
    });

    // Two overlapping calls would both read "not booted" and both inject, and
    // the second set of files would throw a redeclaration inside the page.
    it('queues overlapping injections for one tab into a single injection', async () => {
      installRegistrationStore();
      let probeCount = 0;
      chrome.scripting.executeScript.mockImplementation(async options => {
        if (options.func) {
          probeCount += 1;
          // The first probe answers "nothing there"; by the time the queued call
          // probes again the page is running.
          return [{ result: probeCount === 1 ? NOT_BOOTED : BOOTED }];
        }
        return [];
      });
      const { hotInjectTab } = await freshService();

      const [first, second] = await Promise.all([hotInjectTab(3), hotInjectTab(3)]);

      expect([first, second]).toEqual(['injected', 'already']);
      expect(injectedFiles()).toHaveLength(1);
    });

    it('reports a failed injection rather than claiming the page works', async () => {
      installRegistrationStore();
      chrome.scripting.executeScript.mockImplementation(async options => {
        if (options.func) return [{ result: NOT_BOOTED }];
        throw new Error('Cannot access contents of the page');
      });
      const { hotInjectTab } = await freshService();

      expect(await hotInjectTab(3)).toBe('failed');
    });
  });

  describe('open tabs follow the policy', () => {
    it('hot-injects the tabs a newly added site covers, and leaves the others', async () => {
      installRegistrationStore();
      contentScriptState(NOT_BOOTED);
      local[SITE_POLICY_KEY] = { version: 1, mode: 'allowlist', sites: [] };
      chrome.tabs.query.mockResolvedValue([
        { id: 1, url: PAGE },
        { id: 2, url: 'https://other.example/page' },
        { id: 3, url: 'about:config' },
      ]);
      const { addSite } = await freshService();

      const outcome = await addSite('example.com');

      expect(outcome.injected).toBe(1);
      expect(injectedFiles()).toHaveLength(1);
      expect(chrome.scripting.executeScript).toHaveBeenCalledWith({ target: { tabId: 1 }, files: expect.any(Array) });
    });

    it('tells the tabs a removed site covered to stand down, and only those', async () => {
      installRegistrationStore();
      local[SITE_POLICY_KEY] = {
        version: 1,
        mode: 'allowlist',
        sites: [{ hostname: 'example.com', includeSubdomains: false }],
      };
      chrome.tabs.query.mockResolvedValue([
        { id: 1, url: PAGE },
        { id: 2, url: 'https://other.example/page' },
      ]);
      const { removeSite } = await freshService();

      const outcome = await removeSite('example.com');

      expect(outcome.tornDown).toBe(1);
      expect(chrome.tabs.sendMessage).toHaveBeenCalledTimes(1);
      expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(1, { action: 'siteDisabled' });
    });

    it('re-registers from the new mode', async () => {
      const getRegistered = installRegistrationStore();
      installLocal({ [SITE_POLICY_KEY]: { version: 1, mode: 'allowlist', sites: [{ hostname: 'example.com', includeSubdomains: false }] } });
      const { applySiteMode } = await freshService();

      await applySiteMode('all');

      expect(getRegistered()[0].matches).toEqual(['*://*/*', 'file:///*']);

      await applySiteMode('allowlist');

      expect(getRegistered()[0].matches).toEqual(['*://example.com/*']);
    });

    it('notifies subscribers once per committed change', async () => {
      installRegistrationStore();
      const { addSite, subscribeSitePolicyChanges } = await freshService();
      const seen = [];
      subscribeSitePolicyChanges(policy => { seen.push(policy.sites.length); });

      await addSite('example.com');
      await addSite('example.com');

      // The second call is a no-op: same policy, so no write and no notification.
      expect(seen).toEqual([1]);
    });
  });
});
