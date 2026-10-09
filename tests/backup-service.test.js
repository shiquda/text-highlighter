import { jest } from '@jest/globals';
import chrome from '../mocks/chrome.js';
import { SITE_POLICY_KEY, BACKUP_KEYS } from '../constants/storage-keys.js';
import { BACKUP_ALARM_NAME } from '../constants/backup-config.js';
import { openBackupFromText, generateRecoveryCode } from '../shared/backup-crypto.js';
import { buildMatchPatterns, normalizeSitePolicy } from '../shared/site-rules.js';

const PAGE = 'https://example.com/article';
const OTHER_PAGE = 'https://example.com/other';
const GIST_API = 'https://api.github.com';
const TOKEN = 'ghp_test_token';

// The shape a highlight group has to survive the import validator: a colour
// plus at least one span with text.
const HIGHLIGHT = {
  groupId: 'h1',
  color: 'yellow',
  text: 'a secret sentence',
  updatedAt: '2026-01-01T00:00:00.000Z',
  spans: [{ text: 'a secret', position: 0 }],
};

/**
 * A fresh module graph per test: the backup run lock is module state, so a
 * shared copy would leak one test's in-flight run into the next.
 */
async function freshService() {
  jest.resetModules();
  return import('../background/backup-service.js');
}

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

function response(body, status = 200, headers = {}) {
  const headerMap = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    headers: headerMap,
    json: async () => JSON.parse(JSON.stringify(body)),
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

/**
 * A fake remote that speaks enough of the Gist and WebDAV protocols for the
 * real providers to talk to it. The providers are what the service is built on,
 * so testing through them is what makes this a test of the service rather than
 * of a mock.
 */
function installRemote() {
  const remote = {
    gist: null,
    webdav: { text: null, etag: null },
    calls: [],
    webdavCalls: [],
    failNext: null,
  };
  let revision = 0;

  globalThis.fetch = jest.fn(async (url, options = {}) => {
    const method = options.method || 'GET';
    remote.calls.push({ url, method });

    if (remote.failNext && remote.calls.length >= remote.failNext.after) {
      const error = new Error(remote.failNext.message);
      remote.failNext = null;
      throw error;
    }

    if (url.startsWith(GIST_API)) {
      const path = url.slice(GIST_API.length);
      if (method === 'POST' && path === '/gists') {
        const files = JSON.parse(options.body).files;
        const filename = Object.keys(files)[0];
        remote.gist = { id: 'gist-1', filename, text: files[filename].content, version: `g${++revision}` };
        return response({ id: remote.gist.id, updated_at: remote.gist.version });
      }
      if (method === 'GET' && /^\/gists\//.test(path)) {
        if (!remote.gist) return response({ message: 'Not Found' }, 404);
        return response({
          updated_at: remote.gist.version,
          files: { [remote.gist.filename]: { content: remote.gist.text } },
        });
      }
      if (method === 'PATCH') {
        remote.gist.text = JSON.parse(options.body).files[remote.gist.filename].content;
        remote.gist.version = `g${++revision}`;
        return response({ updated_at: remote.gist.version });
      }
      return response({ message: 'Not Found' }, 404);
    }

    if (url.startsWith('https://dav.example.com') || url.startsWith('http://dav.example.com')) {
      remote.webdavCalls.push({ method, url, headers: options.headers || {}, body: options.body });
      const ifMatch = options.headers && options.headers['If-Match'];
      if (method === 'PUT' && ifMatch && ifMatch !== remote.webdav.etag) return response('Precondition Failed', 412);
      if (method === 'PUT') {
        remote.webdav.text = options.body;
        remote.webdav.etag = `w${++revision}`;
        return response('', 201, { etag: remote.webdav.etag });
      }
      if (!remote.webdav.text) return response('Not Found', 404);
      if (method === 'HEAD') return response('', 200, { etag: remote.webdav.etag });
      if (method === 'GET') return response(remote.webdav.text, 200, { etag: remote.webdav.etag });
      return response('Method Not Allowed', 405);
    }

    return response({ message: 'Not Found' }, 404);
  });

  return remote;
}

async function configureGist(api, patch = { token: TOKEN }) {
  await api.setBackupDestination('gist');
  await api.saveGistConfig(patch);
  return api.getRecoveryCode();
}

function downloadedFilenames() {
  return chrome.downloads.download.mock.calls.map(([options]) => options.filename);
}

function decodeDownloaded(index = -1) {
  const options = chrome.downloads.download.mock.calls.at(index)[0];
  const base64 = options.url.replace(/^data:application\/json;base64,/, '');
  return Buffer.from(base64, 'base64').toString('utf-8');
}

describe('backup-service', () => {
  let local;
  let remote;

  beforeEach(() => {
    jest.clearAllMocks();
    local = installLocal();
    remote = installRemote();
    chrome.tabs.query.mockResolvedValue([]);
    // `clearAllMocks` drops recorded calls but keeps an implementation, so a
    // test that made downloads fail would otherwise fail every test after it.
    chrome.downloads.download.mockReset();
    chrome.downloads.download.mockImplementation(async () => 1);
    chrome.scripting.getRegisteredContentScripts.mockResolvedValue([]);
    chrome.scripting.executeScript.mockResolvedValue([{ result: { booted: false, ready: false, disabled: false } }]);
  });

  describe('unconfigured state', () => {
    it('reports nothing configured and never reaches the network', async () => {
      const api = await freshService();

      const state = await api.getBackupState();
      expect(state).toMatchObject({
        destination: 'none',
        autoEnabled: false,
        hasRecoveryCode: false,
        configured: false,
        upToDate: false,
      });

      const result = await api.runBackup();
      expect(result).toMatchObject({ ok: false, code: 'backup_not_configured' });
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('refuses to upload a destination that has no credential yet', async () => {
      const api = await freshService();
      await api.setBackupDestination('gist');

      const result = await api.runBackup();
      expect(result).toMatchObject({ ok: false, code: 'backup_not_configured' });

      const state = await api.getBackupState();
      expect(state.hasRecoveryCode).toBe(true);
      expect(state.configured).toBe(false);
    });
  });

  describe('first configuration', () => {
    it('mints a recovery code once and keeps it', async () => {
      const api = await freshService();

      const first = await api.setBackupDestination('gist');
      expect(first.ok).toBe(true);
      expect(typeof first.generatedRecoveryCode).toBe('string');
      expect(local[BACKUP_KEYS.RECOVERY_CODE]).toBe(first.generatedRecoveryCode);

      const second = await api.setBackupDestination('gist');
      expect(second.generatedRecoveryCode).toBeNull();
      expect(local[BACKUP_KEYS.RECOVERY_CODE]).toBe(first.generatedRecoveryCode);
    });

    it('catches up the alarm schedule when automatic backup is switched on', async () => {
      const api = await freshService();
      await api.setBackupDestination('webdav');
      await api.saveWebdavConfig({ url: 'https://dav.example.com/marks.json' });
      chrome.alarms.create.mockClear();

      await api.setBackupAutoEnabled(true);

      expect(chrome.alarms.create).toHaveBeenCalledWith('backupDailyAlarm', { periodInMinutes: 24 * 60 });

      await api.setBackupAutoEnabled(false);
      expect(chrome.alarms.clear).toHaveBeenCalledWith('backupDailyAlarm');
    });
  });

  describe('uploading', () => {
    it('creates the remote file and never uploads plaintext', async () => {
      local[PAGE] = [HIGHLIGHT];
      local[`${PAGE}_meta`] = { title: 'Article title', lastUpdated: '2026-01-01T00:00:00.000Z' };
      const api = await freshService();
      const code = await configureGist(api);

      const result = await api.runBackup();

      expect(result).toMatchObject({ ok: true, uploaded: true });
      expect(remote.gist).not.toBeNull();
      expect(remote.gist.text).not.toContain('a secret sentence');
      expect(remote.gist.text).not.toContain(PAGE);

      const reopened = await openBackupFromText(remote.gist.text, code);
      expect(reopened.ok).toBe(true);
      expect(reopened.snapshot.pages.map(page => page.url)).toContain(PAGE);

      // The gist id the provider created has to be remembered, or the next
      // upload would create a second gist instead of updating this one.
      expect((await api.getBackupConfig()).gist.gistId).toBe('gist-1');
    });

    it('skips the upload when the local data has not changed, and forces it on request', async () => {
      local[PAGE] = [HIGHLIGHT];
      const api = await freshService();
      await configureGist(api);

      await api.runBackup();
      const second = await api.runBackup();
      expect(second).toMatchObject({ ok: true, uploaded: false });
      expect(remote.calls.filter(call => call.method === 'PATCH')).toHaveLength(0);

      const forced = await api.runBackup({ force: true });
      expect(forced).toMatchObject({ ok: true, uploaded: true });
      expect(remote.calls.filter(call => call.method === 'PATCH')).toHaveLength(1);
    });

    it('runs one upload for concurrent callers', async () => {
      local[PAGE] = [HIGHLIGHT];
      const api = await freshService();
      await configureGist(api);

      const [a, b] = await Promise.all([api.runBackup(), api.runBackup()]);

      expect(a).toBe(b);
      expect(remote.calls.filter(call => call.method === 'POST')).toHaveLength(1);
    });

    it('refuses to overwrite a remote that changed elsewhere', async () => {
      local[PAGE] = [HIGHLIGHT];
      const api = await freshService();
      await configureGist(api);
      await api.runBackup();

      remote.gist.version = 'g-external';
      local[OTHER_PAGE] = [HIGHLIGHT];

      const result = await api.runBackup();

      expect(result).toMatchObject({ ok: false, code: 'backup_conflict' });
      expect(remote.gist.version).toBe('g-external');
      expect((await api.getBackupState()).lastError.code).toBe('backup_conflict');
    });

    it('schedules a bounded retry when an automatic run fails on the network', async () => {
      const api = await freshService();
      await configureGist(api);
      remote.failNext = { after: 1, message: 'network is unreachable' };

      const result = await api.runBackup({ automatic: true });

      expect(result).toMatchObject({ ok: false, code: 'backup_network' });
      expect(chrome.alarms.create).toHaveBeenCalledWith('backupRetryAlarm', { when: expect.any(Number) });
      expect((await api.getBackupConfig()).retryCount).toBe(1);
    });

    it('does not retry a failure the user has to fix', async () => {
      const api = await freshService();
      await api.setBackupDestination('gist');
      await api.saveGistConfig({ token: 'ghp_bad' });
      globalThis.fetch = jest.fn(async () => response({ message: 'Bad credentials' }, 401));

      const result = await api.runBackup({ automatic: true });

      expect(result).toMatchObject({ ok: false, code: 'backup_auth_failed' });
      expect(chrome.alarms.create).not.toHaveBeenCalledWith('backupRetryAlarm', expect.anything());
    });
  });

  describe('webdav destination', () => {
    it('writes, verifies and reads back through WebDAV', async () => {
      local[PAGE] = [HIGHLIGHT];
      const api = await freshService();
      await api.setBackupDestination('webdav');
      await api.saveWebdavConfig({ url: 'https://dav.example.com/marks.json', username: 'u', password: 'p' });

      const result = await api.runBackup();
      expect(result).toMatchObject({ ok: true, uploaded: true });

      const put = remote.webdavCalls.find(call => call.method === 'PUT');
      expect(put.headers.Authorization).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`);

      const preview = await api.previewRemoteBackup();
      expect(preview.ok).toBe(true);
      expect(preview.preview).toMatchObject({ pageCount: 1, highlightCount: 1 });
    });

    it('blocks a plain HTTP destination unless the user opted in', async () => {
      const api = await freshService();
      await api.setBackupDestination('webdav');
      await api.saveWebdavConfig({ url: 'http://dav.example.com/marks.json' });

      const blocked = await api.runBackup();
      expect(blocked).toMatchObject({ ok: false, code: 'backup_insecure_http_blocked' });

      await api.saveWebdavConfig({ allowInsecureHttp: true });
      const allowed = await api.runBackup();
      expect(allowed).toMatchObject({ ok: true, uploaded: true });
    });
  });

  describe('restoring', () => {
    /**
     * Upload a snapshot, then hand back a service that can read it back.
     *
     * The test then changes the page data in place: the destination, the
     * recovery code and the known gist id are the same session, and a test that
     * replaced the whole store would be testing a profile that had never been
     * configured.
     */
    async function seedRemoteBackup(localSeed) {
      local = installLocal(localSeed);
      const maker = await freshService();
      const code = await configureGist(maker);
      expect(await maker.runBackup()).toMatchObject({ ok: true, uploaded: true });

      const api = await freshService();
      return { api, code };
    }

    it('reports a wrong recovery code without touching local data', async () => {
      const { api } = await seedRemoteBackup({ [PAGE]: [HIGHLIGHT] });

      await api.saveBackupRecoveryCode(generateRecoveryCode());
      const result = await api.restoreFromRemoteBackup({});

      expect(result).toMatchObject({ ok: false, code: 'backup_decrypt_failed' });
      expect(local[PAGE]).toEqual([HIGHLIGHT]);
    });

    it('replaces the page set, restores settings and site rules, and keeps a safety copy', async () => {
      const policy = { version: 1, mode: 'allowlist', sites: [{ hostname: 'restored.example', includeSubdomains: true }] };
      const { api, code } = await seedRemoteBackup({
        [PAGE]: [HIGHLIGHT],
        [`${PAGE}_meta`]: { title: 'Article title', lastUpdated: '2026-01-01T00:00:00.000Z' },
        minimapVisible: false,
        [SITE_POLICY_KEY]: policy,
      });

      // Local data that has to give way to the backup, in a profile that knows
      // nothing about the snapshot it is about to fetch.
      delete local[PAGE];
      delete local[`${PAGE}_meta`];
      local[OTHER_PAGE] = [HIGHLIGHT];
      local.minimapVisible = true;
      local[SITE_POLICY_KEY] = { version: 1, mode: 'all', sites: [] };
      chrome.tabs.query.mockResolvedValue([{ id: 7, url: PAGE }]);

      const result = await api.restoreFromRemoteBackup({});

      expect(result.ok).toBe(true);
      expect(result.summary).toMatchObject({ pageCount: 1, highlightCount: 1, restoredPages: 1, removedPages: 1 });
      expect(local[PAGE]).toHaveLength(1);
      expect(local[`${PAGE}_meta`]).toMatchObject({ title: 'Article title' });
      expect(local[OTHER_PAGE]).toBeUndefined();
      expect(local.minimapVisible).toBe(false);

      // The safety copy is the data the restore is about to overwrite, sealed
      // with the same recovery code.
      const safety = decodeDownloaded();
      expect(safety).not.toContain(PAGE);
      const safetyOpened = await openBackupFromText(safety, code);
      expect(safetyOpened.ok).toBe(true);
      expect(safetyOpened.snapshot.pages.map(page => page.url)).toEqual([OTHER_PAGE]);
      expect(downloadedFilenames().some(name => name.startsWith('marks-local-safety-'))).toBe(true);

      // The policy went into storage behind the site-rule service's back, so the
      // content-script registration is only right if the restore re-synced it.
      const restoredPolicy = local[SITE_POLICY_KEY];
      expect(restoredPolicy).toEqual(normalizeSitePolicy(policy));
      expect(chrome.scripting.registerContentScripts).toHaveBeenCalledWith([
        expect.objectContaining({ matches: buildMatchPatterns(restoredPolicy) }),
      ]);
      expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(7, expect.objectContaining({ action: 'refreshHighlights' }));
    });

    it('refuses to restore when no safety copy can be saved, and writes nothing', async () => {
      const { api } = await seedRemoteBackup({ [PAGE]: [HIGHLIGHT] });
      chrome.downloads.download.mockRejectedValue(new Error('downloads unavailable'));

      const result = await api.restoreFromRemoteBackup({});

      expect(result).toMatchObject({ ok: false, code: 'backup_safety_snapshot_failed' });
      expect(local[PAGE]).toEqual([HIGHLIGHT]);
      expect(chrome.storage.local.remove).not.toHaveBeenCalled();
    });

    it('lets an explicit consent override the missing safety copy', async () => {
      const { api } = await seedRemoteBackup({ [PAGE]: [HIGHLIGHT] });
      delete local[PAGE];
      chrome.downloads.download.mockRejectedValue(new Error('downloads unavailable'));

      const result = await api.restoreFromRemoteBackup({ acceptMissingSnapshot: true });

      expect(result.ok).toBe(true);
      expect(result.safetySnapshot.ok).toBe(false);
      expect(local[PAGE]).toHaveLength(1);
    });

    it('rolls the storage back when a write fails halfway through', async () => {
      const { api } = await seedRemoteBackup({ [PAGE]: [HIGHLIGHT] });
      delete local[PAGE];
      local[OTHER_PAGE] = [HIGHLIGHT];

      const realSet = chrome.storage.local.set.getMockImplementation();
      chrome.storage.local.set.mockImplementation(async items => {
        if (Object.prototype.hasOwnProperty.call(items, PAGE)) throw new Error('quota exceeded');
        return realSet(items);
      });

      const result = await api.restoreFromRemoteBackup({});

      expect(result).toMatchObject({ ok: false, code: 'backup_storage_error' });
      expect(local[OTHER_PAGE]).toEqual([HIGHLIGHT]);
      expect(local[PAGE]).toBeUndefined();
    });
  });

  describe('automatic backup', () => {
    /**
     * The runs are fired and forgotten, so the assertion has to wait for one.
     * Any request is the signal: even a run that ends in a conflict has started.
     */
    async function waitForRun(timeoutMs = 1000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (remote.calls.length > 0) return true;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      return false;
    }

    it('starts the daily alarm when automatic backup is on and clears it when off', async () => {
      const api = await freshService();

      await api.setBackupAutoEnabled(true);
      expect(chrome.alarms.create).toHaveBeenCalledWith(BACKUP_ALARM_NAME, { periodInMinutes: 24 * 60 });

      chrome.alarms.clear.mockClear();
      await api.setBackupAutoEnabled(false);
      expect(chrome.alarms.clear).toHaveBeenCalledWith(BACKUP_ALARM_NAME);
      expect(chrome.alarms.clear).toHaveBeenCalledWith('backupRetryAlarm');
    });

    it('runs a backup when the alarm fires', async () => {
      local[PAGE] = [HIGHLIGHT];
      const api = await freshService();
      await configureGist(api);
      api.initBackupService();

      const listener = chrome.alarms.onAlarm.addListener.mock.calls.at(-1)[0];
      listener({ name: BACKUP_ALARM_NAME });

      expect(await waitForRun()).toBe(true);
    });

    it('ignores an alarm that is not its own', async () => {
      local[PAGE] = [HIGHLIGHT];
      const api = await freshService();
      await configureGist(api);
      api.initBackupService();

      const listener = chrome.alarms.onAlarm.addListener.mock.calls.at(-1)[0];
      listener({ name: 'someOtherAlarm' });

      expect(await waitForRun(150)).toBe(false);
    });

    it('catches up a missed day on start-up, but not a run from today', async () => {
      const seeded = {
        [PAGE]: [HIGHLIGHT],
        [BACKUP_KEYS.CONFIG]: {
          version: 1,
          destination: 'gist',
          autoEnabled: true,
          gist: { token: TOKEN, gistId: 'gist-1', filename: 'marks-local-backup.enc.json' },
        },
        [BACKUP_KEYS.RECOVERY_CODE]: generateRecoveryCode(),
        [BACKUP_KEYS.LAST_SUCCESS_AT]: Date.now(),
      };

      local = installLocal(seeded);
      (await freshService()).initBackupService();
      expect(await waitForRun(150)).toBe(false);

      local = installLocal({ ...seeded, [BACKUP_KEYS.LAST_SUCCESS_AT]: 0 });
      (await freshService()).initBackupService();
      expect(await waitForRun()).toBe(true);
    });
  });

  describe('local export', () => {
    it('downloads an encrypted snapshot of the current data', async () => {
      local[PAGE] = [HIGHLIGHT];
      const api = await freshService();
      await api.setBackupDestination('gist');
      await api.saveGistConfig({ token: TOKEN });
      const code = await api.getRecoveryCode();

      const result = await api.exportLocalBackup();

      expect(result).toMatchObject({ ok: true, encrypted: true });
      const text = decodeDownloaded();
      expect(text).not.toContain('a secret sentence');
      expect(text).not.toContain(PAGE);
      expect((await openBackupFromText(text, code)).ok).toBe(true);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('needs a recovery code first', async () => {
      const api = await freshService();
      const result = await api.exportLocalBackup();
      expect(result).toMatchObject({ ok: false, code: 'backup_no_recovery_code' });
      expect(chrome.downloads.download).not.toHaveBeenCalled();
    });
  });
});
