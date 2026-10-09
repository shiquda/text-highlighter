import { browserAPI } from '../shared/browser-api.js';
import { debugLog } from '../shared/logger.js';
import { broadcastToTabsByUrl } from '../shared/tab-broadcast.js';
import { STORAGE_KEYS, SITE_POLICY_KEY, BACKUP_KEYS, BACKED_UP_SETTING_KEYS, isPageStorageKey } from '../constants/storage-keys.js';
import {
  BACKUP_ALARM_NAME,
  BACKUP_ALARM_PERIOD_MINUTES,
  BACKUP_RETRY_ALARM_NAME,
  BACKUP_RETRY_DELAYS_MS,
  MAX_BACKUP_RETRIES,
  RETRYABLE_BACKUP_CODES,
} from '../constants/backup-config.js';
import {
  BACKUP_FILENAME,
  serializeSnapshot,
  isBackupEnvelope,
  buildBackupSnapshot,
  validateBackupSnapshot,
  describeBackupSnapshot,
  computeSnapshotFingerprint,
} from '../shared/backup-schema.js';
import { sealBackupToText, openBackupFromText, generateRecoveryCode, normalizeRecoveryCode } from '../shared/backup-crypto.js';
import { BACKUP_ERRORS } from './backup-providers/errors.js';
import * as gistProvider from './backup-providers/gist.js';
import * as webdavProvider from './backup-providers/webdav.js';
import { getSitePolicy, initSiteRuleService } from './site-rule-service.js';

const PROVIDERS = {
  gist: gistProvider,
  webdav: webdavProvider,
};

const DEPLOYED_DESTINATIONS = Object.keys(PROVIDERS);

const DEFAULT_CONFIG = Object.freeze({
  version: 1,
  destination: 'none',
  autoEnabled: false,
  // Off by default: a backup is a copy of everything the user has read and
  // highlighted, and the recovery code is friction they have to accept before
  // the payload stops being readable on the other end.
  encrypt: false,
  gist: { token: '', gistId: '', filename: BACKUP_FILENAME },
  webdav: { url: '', username: '', password: '', allowInsecureHttp: false },
  // The remote revision this device last read or wrote, per destination. It is
  // what makes "the remote changed under me" detectable at all: without it the
  // only options are to refuse every second write or to clobber blindly.
  remote: { gist: { version: null }, webdav: { version: null } },
  retryCount: 0,
  updatedAt: 0,
});

// One upload at a time. Two overlapping runs would both read the same remote
// revision, both decide they are the last writer, and the second would clobber
// whatever the first just wrote.
let runInFlight = null;

function failure(code, message) {
  return { ok: false, code, message };
}

function normalizeConfig(raw) {
  const config = {
    ...DEFAULT_CONFIG,
    gist: { ...DEFAULT_CONFIG.gist },
    webdav: { ...DEFAULT_CONFIG.webdav },
    remote: { gist: { ...DEFAULT_CONFIG.remote.gist }, webdav: { ...DEFAULT_CONFIG.remote.webdav } },
  };
  if (!raw || typeof raw !== 'object') return config;

  if (typeof raw.destination === 'string' && (raw.destination === 'none' || DEPLOYED_DESTINATIONS.includes(raw.destination))) {
    config.destination = raw.destination;
  }
  config.autoEnabled = raw.autoEnabled === true;
  config.encrypt = raw.encrypt === true;
  config.retryCount = Number.isInteger(raw.retryCount) && raw.retryCount > 0 ? raw.retryCount : 0;
  config.updatedAt = Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0;

  if (raw.gist && typeof raw.gist === 'object') {
    config.gist.token = typeof raw.gist.token === 'string' ? raw.gist.token : '';
    config.gist.gistId = typeof raw.gist.gistId === 'string' ? raw.gist.gistId : '';
    config.gist.filename = typeof raw.gist.filename === 'string' && raw.gist.filename ? raw.gist.filename : BACKUP_FILENAME;
  }
  if (raw.webdav && typeof raw.webdav === 'object') {
    config.webdav.url = typeof raw.webdav.url === 'string' ? raw.webdav.url : '';
    config.webdav.username = typeof raw.webdav.username === 'string' ? raw.webdav.username : '';
    config.webdav.password = typeof raw.webdav.password === 'string' ? raw.webdav.password : '';
    config.webdav.allowInsecureHttp = raw.webdav.allowInsecureHttp === true;
  }
  for (const destination of DEPLOYED_DESTINATIONS) {
    const stored = raw.remote && raw.remote[destination];
    if (stored && typeof stored === 'object' && typeof stored.version === 'string') {
      config.remote[destination].version = stored.version;
    }
  }

  return config;
}

export async function getBackupConfig() {
  const result = await browserAPI.storage.local.get(BACKUP_KEYS.CONFIG);
  return normalizeConfig(result[BACKUP_KEYS.CONFIG]);
}

async function writeBackupConfig(patch) {
  const current = await getBackupConfig();
  const next = normalizeConfig({
    ...current,
    ...patch,
    gist: { ...current.gist, ...(patch.gist || {}) },
    webdav: { ...current.webdav, ...(patch.webdav || {}) },
    remote: {
      gist: { ...current.remote.gist, ...((patch.remote && patch.remote.gist) || {}) },
      webdav: { ...current.remote.webdav, ...((patch.remote && patch.remote.webdav) || {}) },
    },
    updatedAt: Date.now(),
  });
  await browserAPI.storage.local.set({ [BACKUP_KEYS.CONFIG]: next });
  return next;
}

async function readLocal(key) {
  const result = await browserAPI.storage.local.get(key);
  return result[key];
}

export async function getRecoveryCode() {
  const stored = await readLocal(BACKUP_KEYS.RECOVERY_CODE);
  return typeof stored === 'string' && stored ? stored : null;
}

function providerFor(destination) {
  return PROVIDERS[destination] || null;
}

function providerConfig(config) {
  if (config.destination === 'gist') return config.gist;
  if (config.destination === 'webdav') return config.webdav;
  return null;
}

function isConfigured(config) {
  if (config.destination === 'gist') return Boolean(config.gist.token);
  if (config.destination === 'webdav') return Boolean(config.webdav.url);
  return false;
}

async function buildLocalSnapshot() {
  const [storage, sitePolicy] = await Promise.all([
    browserAPI.storage.local.get(null),
    getSitePolicy(),
  ]);
  return buildBackupSnapshot({ storage, sitePolicy });
}

/**
 * The state the settings page renders.
 *
 * The recovery code and the `hasPassword`/`hasToken` booleans instead of the
 * secrets themselves: the page needs to show the code (that is the whole point
 * of copying it down) and needs to know whether a credential is stored, but
 * nothing outside the background ever needs the credential back.
 */
export async function getBackupState() {
  const [config, code, lastSuccessAt, lastFingerprint, lastError] = await Promise.all([
    getBackupConfig(),
    getRecoveryCode(),
    readLocal(BACKUP_KEYS.LAST_SUCCESS_AT),
    readLocal(BACKUP_KEYS.LAST_FINGERPRINT),
    readLocal(BACKUP_KEYS.LAST_ERROR),
  ]);

  const snapshot = await buildLocalSnapshot();
  const localFingerprint = await computeSnapshotFingerprint(snapshot);

  return {
    destination: config.destination,
    autoEnabled: config.autoEnabled,
    encrypt: config.encrypt,
    hasRecoveryCode: Boolean(code),
    recoveryCode: code,
    gist: {
      hasToken: Boolean(config.gist.token),
      gistId: config.gist.gistId || '',
      filename: config.gist.filename,
    },
    webdav: {
      url: config.webdav.url,
      username: config.webdav.username,
      hasPassword: Boolean(config.webdav.password),
      allowInsecureHttp: config.webdav.allowInsecureHttp,
    },
    lastSuccessAt: Number.isFinite(lastSuccessAt) ? lastSuccessAt : 0,
    lastError: lastError && typeof lastError === 'object' ? lastError : null,
    localFingerprint,
    upToDate: Boolean(lastFingerprint) && lastFingerprint === localFingerprint,
    configured: isConfigured(config) && (!config.encrypt || Boolean(code)),
  };
}

/**
 * Point the backup at a destination.
 *
 * No recovery code here: with encryption off there is nothing for it to do,
 * and a code the user is told to save but never needs is how the one that does
 * matter gets ignored.
 */
export async function setBackupDestination(destination) {
  if (destination !== 'none' && !DEPLOYED_DESTINATIONS.includes(destination)) {
    return { ok: false, code: BACKUP_ERRORS.NOT_CONFIGURED, message: `Unknown backup destination: ${destination}` };
  }

  const config = await writeBackupConfig({ destination });
  await scheduleAutomaticBackup(config);
  return { ok: true };
}

/**
 * Turn encryption on or off.
 *
 * Turning it on is when a recovery code appears, so that is where it is minted;
 * an existing code is kept, because the backups it already opened would
 * otherwise become unreadable the moment the toggle is flipped. Either
 * direction forgets the last fingerprint: the payload's shape changed, so the
 * next run has to upload even though the local data did not move.
 */
export async function setBackupEncryption(enabled) {
  const encrypt = enabled === true;

  let generatedRecoveryCode = null;
  if (encrypt && !(await getRecoveryCode())) {
    generatedRecoveryCode = generateRecoveryCode();
    await browserAPI.storage.local.set({ [BACKUP_KEYS.RECOVERY_CODE]: generatedRecoveryCode });
  }

  await writeBackupConfig({ encrypt });
  await browserAPI.storage.local.set({ [BACKUP_KEYS.LAST_FINGERPRINT]: null });
  return { ok: true, encrypt, generatedRecoveryCode };
}

export async function setBackupAutoEnabled(enabled) {
  const config = await writeBackupConfig({ autoEnabled: enabled === true, retryCount: 0 });
  await scheduleAutomaticBackup(config);
  if (enabled === true) {
    await runBackup({ automatic: true, force: false }).catch(e => debugLog('Initial automatic backup failed:', e.message));
  }
  return { ok: true };
}

export async function saveGistConfig(patch) {
  const clean = {};
  if (typeof patch.token === 'string') clean.token = patch.token.trim();
  if (typeof patch.gistId === 'string') clean.gistId = patch.gistId.trim();
  if (typeof patch.filename === 'string') clean.filename = patch.filename.trim() || BACKUP_FILENAME;

  // A new credential or a different gist is a different remote, so what this
  // device thought the remote revision was no longer means anything.
  const current = await getBackupConfig();
  const remoteChanged = ('gistId' in clean && clean.gistId !== current.gist.gistId)
    || ('token' in clean && clean.token !== current.gist.token);
  await writeBackupConfig({
    gist: clean,
    ...(remoteChanged ? { remote: { gist: { version: null } } } : {}),
  });
  return { ok: true };
}

export async function saveWebdavConfig(patch) {
  const clean = {};
  if (typeof patch.url === 'string') clean.url = patch.url.trim();
  if (typeof patch.username === 'string') clean.username = patch.username.trim();
  if (typeof patch.password === 'string') clean.password = patch.password;
  if (patch.allowInsecureHttp !== undefined) clean.allowInsecureHttp = patch.allowInsecureHttp === true;

  const current = await getBackupConfig();
  const remoteChanged = ('url' in clean && clean.url !== current.webdav.url)
    || ('username' in clean && clean.username !== current.webdav.username);
  await writeBackupConfig({
    webdav: clean,
    ...(remoteChanged ? { remote: { webdav: { version: null } } } : {}),
  });
  return { ok: true };
}

export async function generateBackupRecoveryCode() {
  const code = generateRecoveryCode();
  await browserAPI.storage.local.set({ [BACKUP_KEYS.RECOVERY_CODE]: code });
  return { ok: true, code };
}

export async function saveBackupRecoveryCode(rawCode) {
  let code;
  try {
    code = normalizeRecoveryCode(rawCode);
  } catch {
    return failure(BACKUP_ERRORS.INVALID_FORMAT, 'That recovery code is not valid.');
  }
  await browserAPI.storage.local.set({ [BACKUP_KEYS.RECOVERY_CODE]: code });
  return { ok: true, code };
}

async function rememberRemoteVersion(destination, version) {
  if (typeof version !== 'string') return;
  const config = await writeBackupConfig({ remote: { [destination]: { version } } });
  return config;
}

export async function testBackupConnection() {
  const config = await getBackupConfig();
  const provider = providerFor(config.destination);
  if (!provider) return failure(BACKUP_ERRORS.NOT_CONFIGURED, 'Choose a backup destination first.');
  if (!isConfigured(config)) return failure(BACKUP_ERRORS.NOT_CONFIGURED, 'Fill in the destination settings first.');

  const result = await provider.testConnection(providerConfig(config));
  if (!result.ok) return result;

  // A successful read is where the remote revision comes from, so record it:
  // otherwise the next upload would refuse to touch a remote it has just been
  // talking to.
  const remote = await provider.readRemote(providerConfig(config));
  if (remote.ok && remote.exists) await rememberRemoteVersion(config.destination, remote.version);

  return result;
}

function retryable(code) {
  return RETRYABLE_BACKUP_CODES.includes(code);
}

async function recordFailure(code, message) {
  await browserAPI.storage.local.set({
    [BACKUP_KEYS.LAST_ERROR]: { code, message, at: Date.now() },
    [BACKUP_KEYS.LAST_ATTEMPT_AT]: Date.now(),
  });
  return failure(code, message);
}

async function scheduleRetry(config) {
  if (!browserAPI.alarms) return;
  const attempt = config.retryCount + 1;
  if (attempt > MAX_BACKUP_RETRIES) {
    debugLog('Giving up on the automatic backup after', MAX_BACKUP_RETRIES, 'retries');
    return;
  }
  await writeBackupConfig({ retryCount: attempt });
  const delay = BACKUP_RETRY_DELAYS_MS[Math.min(attempt, MAX_BACKUP_RETRIES) - 1];
  browserAPI.alarms.create(BACKUP_RETRY_ALARM_NAME, { when: Date.now() + delay });
}

async function clearRetry() {
  if (browserAPI.alarms && browserAPI.alarms.clear) await browserAPI.alarms.clear(BACKUP_RETRY_ALARM_NAME);
  const config = await getBackupConfig();
  if (config.retryCount !== 0) await writeBackupConfig({ retryCount: 0 });
}

async function uploadOnce({ force, automatic }) {
  const config = await getBackupConfig();
  const provider = providerFor(config.destination);
  if (!provider) return recordFailure(BACKUP_ERRORS.NOT_CONFIGURED, 'Choose a backup destination first.');
  if (!isConfigured(config)) return recordFailure(BACKUP_ERRORS.NOT_CONFIGURED, 'Fill in the destination settings first.');

  let code = null;
  if (config.encrypt) {
    code = await getRecoveryCode();
    if (!code) return recordFailure(BACKUP_ERRORS.NO_RECOVERY_CODE, 'No backup recovery code is set on this device.');
  }

  const snapshot = await buildLocalSnapshot();
  const fingerprint = await computeSnapshotFingerprint(snapshot);
  const lastFingerprint = await readLocal(BACKUP_KEYS.LAST_FINGERPRINT);

  if (!force && fingerprint === lastFingerprint) {
    return { ok: true, uploaded: false, fingerprint, message: 'Nothing has changed since the last backup.' };
  }

  const text = config.encrypt ? await sealBackupToText(snapshot, code) : serializeSnapshot(snapshot);
  const knownVersion = config.remote[config.destination].version;
  const write = await provider.writeRemote(providerConfig(config), { text }, {
    expectedVersion: knownVersion === null ? undefined : knownVersion,
    force: force === true,
  });

  if (!write.ok) {
    debugLog('Backup upload failed:', write.code, write.message);
    if (automatic && retryable(write.code)) await scheduleRetry(config);
    return recordFailure(write.code, write.message);
  }

  if (write.details && typeof write.details.gistId === 'string' && write.details.gistId) {
    await writeBackupConfig({ gist: { gistId: write.details.gistId } });
  }
  await rememberRemoteVersion(config.destination, write.version);

  await browserAPI.storage.local.set({
    [BACKUP_KEYS.LAST_SUCCESS_AT]: Date.now(),
    [BACKUP_KEYS.LAST_FINGERPRINT]: fingerprint,
    [BACKUP_KEYS.LAST_ERROR]: null,
    [BACKUP_KEYS.LAST_ATTEMPT_AT]: Date.now(),
  });
  await clearRetry();

  return { ok: true, uploaded: true, fingerprint, message: 'Backup uploaded.' };
}

/**
 * Upload the current local data.
 *
 * Concurrent callers share one run rather than queueing: the second would be
 * uploading the same payload, and the answer it wants is the one the first is
 * already getting.
 */
export function runBackup(options = {}) {
  if (runInFlight) return runInFlight;
  runInFlight = uploadOnce({ force: options.force === true, automatic: options.automatic === true })
    .catch(e => {
      debugLog('Backup run failed:', e.message);
      return recordFailure(BACKUP_ERRORS.GENERIC, e.message);
    })
    .finally(() => { runInFlight = null; });
  return runInFlight;
}

/**
 * A URL the browser will actually download from.
 *
 * Firefox refuses a `data:` URL here outright - "Access denied for URL
 * data:application/json;base64,..." - so the background, which is a real page
 * there, hands out a blob URL instead. A Chrome MV3 service worker has no
 * `createObjectURL`, which leaves it the data URL; that is the one branch that
 * cannot be picked by choice.
 */
function downloadUrlFor(text) {
  if (typeof Blob === 'function' && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    return { url, revoke: () => URL.revokeObjectURL(url) };
  }

  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return { url: `data:application/json;base64,${btoa(binary)}`, revoke: null };
}

async function downloadText(text, filename) {
  if (!browserAPI.downloads || !browserAPI.downloads.download) {
    throw new Error('Downloads are not available in this browser.');
  }

  const { url, revoke } = downloadUrlFor(text);
  try {
    await browserAPI.downloads.download({ url, filename, saveAs: false });
  } catch (error) {
    if (revoke) revoke();
    throw error;
  }

  // The download reads the blob after `download` resolves, so the URL outlives
  // this call. Revoking it on a timer rather than on completion keeps the whole
  // thing free of a listener that a service worker would drop anyway.
  if (revoke) setTimeout(revoke, 60_000);
  return filename;
}

function timestampSuffix() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

export async function exportLocalBackup() {
  const config = await getBackupConfig();
  const code = config.encrypt ? await getRecoveryCode() : null;
  if (config.encrypt && !code) {
    return failure(BACKUP_ERRORS.NO_RECOVERY_CODE, 'Generate a recovery code before exporting.');
  }

  try {
    const snapshot = await buildLocalSnapshot();
    const text = config.encrypt ? await sealBackupToText(snapshot, code) : serializeSnapshot(snapshot);
    const suffix = config.encrypt ? '.enc.json' : '.json';
    const filename = `marks-local-backup-${timestampSuffix()}${suffix}`;
    await downloadText(text, filename);
    return { ok: true, filename, encrypted: config.encrypt };
  } catch (e) {
    return recordFailure(BACKUP_ERRORS.DOWNLOAD_FAILED, e.message);
  }
}

async function readAndOpenRemote() {
  const config = await getBackupConfig();
  const provider = providerFor(config.destination);
  if (!provider) return failure(BACKUP_ERRORS.NOT_CONFIGURED, 'Choose a backup destination first.');
  if (!isConfigured(config)) return failure(BACKUP_ERRORS.NOT_CONFIGURED, 'Fill in the destination settings first.');

  const remote = await provider.readRemote(providerConfig(config));
  if (!remote.ok) return remote;
  if (!remote.exists) return failure(BACKUP_ERRORS.NOT_FOUND, 'There is no backup at that destination yet.');
  await rememberRemoteVersion(config.destination, remote.version);

  let parsed;
  try {
    parsed = JSON.parse(remote.text);
  } catch {
    return failure(BACKUP_ERRORS.INVALID_FORMAT, 'The remote backup is not JSON.');
  }

  // A sealed envelope needs the code; a snapshot that arrives as plain JSON is
  // used as it is, because that is what the unencrypted mode uploaded. The
  // answer remembers which one it was so the preview can say so out loud.
  const encrypted = isBackupEnvelope(parsed);
  let snapshot = parsed;
  if (encrypted) {
    const code = await getRecoveryCode();
    if (!code) return failure(BACKUP_ERRORS.NO_RECOVERY_CODE, 'No backup recovery code is set on this device.');
    const opened = await openBackupFromText(remote.text, code);
    if (!opened.ok) return opened;
    snapshot = opened.snapshot;
  }

  const validation = validateBackupSnapshot(snapshot);
  if (!validation.valid) {
    const code_ = validation.reason === 'unsupported-version' ? BACKUP_ERRORS.UNSUPPORTED_VERSION : BACKUP_ERRORS.INVALID_FORMAT;
    return failure(code_, `The remote backup could not be read: ${validation.reason}`);
  }

  return { ok: true, snapshot: validation.snapshot, source: config.destination, encrypted };
}

export async function previewRemoteBackup() {
  const opened = await readAndOpenRemote();
  if (!opened.ok) return recordFailure(opened.code, opened.message);

  return {
    ok: true,
    source: opened.source,
    encrypted: opened.encrypted,
    preview: describeBackupSnapshot(opened.snapshot),
  };
}

async function applySnapshot(snapshot) {
  const before = await browserAPI.storage.local.get(null);

  const writes = {};
  for (const page of snapshot.pages) {
    writes[page.url] = page.highlights;
    writes[`${page.url}${STORAGE_KEYS.META_SUFFIX}`] = {
      title: page.title || '',
      lastUpdated: page.meta.lastUpdated || '',
      deletedGroupIds: page.meta.deletedGroupIds || {},
    };
  }
  for (const key of BACKED_UP_SETTING_KEYS) {
    if (key in snapshot.settings) writes[key] = snapshot.settings[key];
  }
  writes[SITE_POLICY_KEY] = snapshot.sitePolicy;

  // Overwriting means the restored page set replaces the current one, so a page
  // this profile has and the backup does not is removed rather than left behind
  // as a highlight the backup never knew about.
  const restoredKeys = new Set(Object.keys(writes));
  const stale = Object.keys(before).filter(key =>
    !restoredKeys.has(key) &&
    (isPageStorageKey(key, before[key]) || key.endsWith(STORAGE_KEYS.META_SUFFIX))
  );

  const previousValues = {};
  for (const key of [...restoredKeys, ...stale]) {
    if (key in before) previousValues[key] = before[key];
  }

  try {
    if (stale.length > 0) await browserAPI.storage.local.remove(stale);
    await browserAPI.storage.local.set(writes);
  } catch (e) {
    // Half a restore is worse than none: put back what was there and say so.
    const written = [...restoredKeys, ...stale];
    try {
      await browserAPI.storage.local.remove(written);
      if (Object.keys(previousValues).length > 0) await browserAPI.storage.local.set(previousValues);
    } catch (rollbackError) {
      debugLog('Rollback after a failed restore also failed:', rollbackError.message);
    }
    throw e;
  }

  return { pages: snapshot.pages.length, stale: stale.length };
}

export async function restoreFromRemoteBackup({ acceptMissingSnapshot = false } = {}) {
  const opened = await readAndOpenRemote();
  if (!opened.ok) return recordFailure(opened.code, opened.message);

  // Refuse before overwriting anything if the safety copy cannot even be
  // written: a restore that the user cannot undo has to be their choice.
  const config = await getBackupConfig();
  const code = config.encrypt ? await getRecoveryCode() : null;
  if (config.encrypt && !code) {
    return recordFailure(BACKUP_ERRORS.NO_RECOVERY_CODE, 'No backup recovery code is set on this device.');
  }

  let safetySnapshot = { ok: true };
  try {
    const current = await buildLocalSnapshot();
    const text = config.encrypt ? await sealBackupToText(current, code) : serializeSnapshot(current);
    const suffix = config.encrypt ? '.enc.json' : '.json';
    const filename = `marks-local-safety-${timestampSuffix()}${suffix}`;
    await downloadText(text, filename);
    safetySnapshot = { ok: true, filename };
  } catch (e) {
    debugLog('Safety snapshot before restore failed:', e.message);
    safetySnapshot = { ok: false, code: BACKUP_ERRORS.SAFETY_SNAPSHOT_FAILED, message: e.message };
  }

  // The user is about to lose the current data either way. Losing it with no way
  // back is a decision, not an accident, so it takes a second explicit consent.
  if (!safetySnapshot.ok && acceptMissingSnapshot !== true) {
    return failure(
      BACKUP_ERRORS.SAFETY_SNAPSHOT_FAILED,
      `Could not save a safety copy of the current data first: ${safetySnapshot.message}`
    );
  }

  let applied;
  try {
    applied = await applySnapshot(opened.snapshot);
  } catch (e) {
    return recordFailure(BACKUP_ERRORS.STORAGE_ERROR, e.message);
  }

  // The restored policy was written straight to storage; the registration and
  // the context menus describe the old one until this runs.
  await initSiteRuleService();
  await Promise.all(opened.snapshot.pages.map(page =>
    broadcastToTabsByUrl(page.url, { action: 'refreshHighlights', highlights: page.highlights })
  ));

  return {
    ok: true,
    encrypted: opened.encrypted,
    summary: {
      ...describeBackupSnapshot(opened.snapshot),
      restoredPages: applied.pages,
      removedPages: applied.stale,
    },
    safetySnapshot,
  };
}

async function scheduleAutomaticBackup(config) {
  if (!browserAPI.alarms) return;
  if (config.autoEnabled) {
    browserAPI.alarms.create(BACKUP_ALARM_NAME, { periodInMinutes: BACKUP_ALARM_PERIOD_MINUTES });
  } else if (browserAPI.alarms.clear) {
    await browserAPI.alarms.clear(BACKUP_ALARM_NAME);
    await browserAPI.alarms.clear(BACKUP_RETRY_ALARM_NAME);
  }
}

/**
 * Register the alarm listener and bring the schedule up to date.
 *
 * Called at the top level of the background script: a Chrome MV3 service worker
 * that a backup alarm wakes has to have its listener registered by the time the
 * event arrives, which means synchronously, before any await.
 */
export function initBackupService() {
  if (browserAPI.alarms && browserAPI.alarms.onAlarm) {
    browserAPI.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name !== BACKUP_ALARM_NAME && alarm.name !== BACKUP_RETRY_ALARM_NAME) return;
      runBackup({ automatic: true }).catch(e => debugLog('Automatic backup failed:', e.message));
    });
  }

  (async () => {
    try {
      const config = await getBackupConfig();
      await scheduleAutomaticBackup(config);
      if (!config.autoEnabled) return;

      const lastSuccessAt = await readLocal(BACKUP_KEYS.LAST_SUCCESS_AT);
      const overdue = !Number.isFinite(lastSuccessAt) || Date.now() - lastSuccessAt >= BACKUP_ALARM_PERIOD_MINUTES * 60 * 1000;
      // A browser that was closed for a week fires no alarms while it is shut,
      // so the first start after a gap is where the missed day is made up. The
      // fingerprint check inside the run is what stops this being an upload
      // every single time the browser opens.
      if (overdue) await runBackup({ automatic: true });
    } catch (e) {
      debugLog('Backup initialisation failed:', e.message);
    }
  })();
}
