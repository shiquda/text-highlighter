// Pure backup snapshot schema, normalisation, and envelope validation.
//
// The backup format captures highlighting state across all sites, the site
// allowlist policy, and backed-up user settings into a self-contained JSON
// document sealed with client-side cryptography.

import {
  STORAGE_KEYS,
  BACKED_UP_SETTING_KEYS,
  NON_PAGE_STORAGE_KEYS,
  isPageStorageKey,
} from '../constants/storage-keys.js';
import { validateImportPayload } from './import-export-schema.js';
import { normalizeSitePolicy, normalizeSiteMode } from './site-rules.js';

export const BACKUP_SCHEMA_VERSION = 1;
export const BACKUP_APP_ID = 'marks-local';
// The name the backup is stored under remotely. It does not carry the mode: a
// mode change that renamed the file would leave the previous one behind at the
// destination, and the payload already says which shape it is.
export const BACKUP_FILENAME = 'marks-local-backup.json';
export const BACKUP_FORMAT = 'marks-local-backup';

export const DEFAULT_BACKUP_SETTINGS = Object.freeze({
  [STORAGE_KEYS.CUSTOM_COLORS]: [],
  [STORAGE_KEYS.MINIMAP_VISIBLE]: true,
  [STORAGE_KEYS.SELECTION_CONTROLS_VISIBLE]: true,
  [STORAGE_KEYS.ONE_CLICK_HIGHLIGHT]: false,
  [STORAGE_KEYS.SHORTCUT_COLOR_MAP]: {},
});

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isHttpOrHttpsUrl(url) {
  if (typeof url !== 'string' || !url.trim()) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Normalise settings for backup: absent settings become explicit defaults
 * so that an untouched setting and an explicitly disabled setting never collide.
 */
function extractBackupSettings(storage = {}) {
  const settings = {};
  for (const key of BACKED_UP_SETTING_KEYS) {
    const value = storage[key];
    if (key === STORAGE_KEYS.CUSTOM_COLORS) {
      settings[key] = Array.isArray(value) ? [...value] : [];
    } else if (key === STORAGE_KEYS.MINIMAP_VISIBLE) {
      settings[key] = typeof value === 'boolean' ? value : true;
    } else if (key === STORAGE_KEYS.SELECTION_CONTROLS_VISIBLE) {
      settings[key] = typeof value === 'boolean' ? value : true;
    } else if (key === STORAGE_KEYS.ONE_CLICK_HIGHLIGHT) {
      settings[key] = typeof value === 'boolean' ? value : false;
    } else if (key === STORAGE_KEYS.SHORTCUT_COLOR_MAP) {
      settings[key] = isPlainObject(value) ? { ...value } : {};
    } else {
      settings[key] = value !== undefined ? value : false;
    }
  }
  return settings;
}

/**
 * Build a plaintext backup snapshot from storage.local and active policy.
 */
export function buildBackupSnapshot({ storage = {}, sitePolicy, exportedAt } = {}) {
  const safeStorage = isPlainObject(storage) ? storage : {};
  const effectiveSitePolicy = normalizeSitePolicy(sitePolicy ?? safeStorage.sitePolicy);

  const pageKeys = Object.keys(safeStorage)
    .filter(key => isPageStorageKey(key, safeStorage[key]))
    .sort();

  const pages = pageKeys.map(url => {
    const highlights = Array.isArray(safeStorage[url]) ? safeStorage[url] : [];
    const metaKey = `${url}${STORAGE_KEYS.META_SUFFIX}`;
    const rawMeta = safeStorage[metaKey];
    const metaObj = isPlainObject(rawMeta) ? rawMeta : {};

    const title = typeof metaObj.title === 'string' ? metaObj.title : '';
    const lastUpdated = typeof metaObj.lastUpdated === 'string' ? metaObj.lastUpdated : '';
    const deletedGroupIds = isPlainObject(metaObj.deletedGroupIds)
      ? { ...metaObj.deletedGroupIds }
      : {};

    return {
      url,
      title,
      highlights,
      meta: {
        lastUpdated,
        deletedGroupIds,
      },
    };
  });

  return {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    app: BACKUP_APP_ID,
    exportedAt: typeof exportedAt === 'string' ? exportedAt : new Date().toISOString(),
    sitePolicy: effectiveSitePolicy,
    settings: extractBackupSettings(safeStorage),
    pages,
  };
}

/**
 * Validate a parsed snapshot payload, filtering corrupted highlight groups
 * and ensuring structural invariants before restoring.
 */
export function validateBackupSnapshot(raw) {
  if (!isPlainObject(raw)) {
    return { valid: false, reason: 'snapshot must be an object', snapshot: null, stats: null };
  }

  if (raw.app !== BACKUP_APP_ID) {
    return { valid: false, reason: 'invalid-app', snapshot: null, stats: null };
  }

  if (typeof raw.schemaVersion !== 'number' || raw.schemaVersion < 1 || raw.schemaVersion > BACKUP_SCHEMA_VERSION) {
    const reason = typeof raw.schemaVersion === 'number' && raw.schemaVersion > BACKUP_SCHEMA_VERSION
      ? 'unsupported-version'
      : 'invalid-schema-version';
    return { valid: false, reason, snapshot: null, stats: null };
  }

  if (!Array.isArray(raw.pages)) {
    return { valid: false, reason: 'pages must be an array', snapshot: null, stats: null };
  }

  const stats = {
    inputPages: raw.pages.length,
    acceptedPages: 0,
    rejectedPages: 0,
    inputHighlights: 0,
    acceptedHighlights: 0,
    rejectedHighlights: 0,
    inputSpans: 0,
    acceptedSpans: 0,
    rejectedSpans: 0,
  };

  const acceptedPages = [];

  for (let i = 0; i < raw.pages.length; i += 1) {
    const rawPage = raw.pages[i];

    if (isPlainObject(rawPage) && Array.isArray(rawPage.highlights)) {
      stats.inputHighlights += rawPage.highlights.length;
      for (const group of rawPage.highlights) {
        if (isPlainObject(group) && Array.isArray(group.spans)) {
          stats.inputSpans += group.spans.length;
        }
      }
    }

    if (!isPlainObject(rawPage) || !isHttpOrHttpsUrl(rawPage.url)) {
      stats.rejectedPages += 1;
      if (isPlainObject(rawPage) && Array.isArray(rawPage.highlights)) {
        stats.rejectedHighlights += rawPage.highlights.length;
        for (const group of rawPage.highlights) {
          if (isPlainObject(group) && Array.isArray(group.spans)) {
            stats.rejectedSpans += group.spans.length;
          }
        }
      }
      continue;
    }

    const payloadResult = validateImportPayload({
      pages: [{
        url: rawPage.url,
        title: typeof rawPage.title === 'string' ? rawPage.title : '',
        highlights: Array.isArray(rawPage.highlights) ? rawPage.highlights : [],
      }],
    });

    if (payloadResult.pages.length === 0) {
      stats.rejectedPages += 1;
      stats.rejectedHighlights += payloadResult.stats.rejectedHighlights;
      stats.rejectedSpans += payloadResult.stats.rejectedSpans;
      continue;
    }

    const normalizedHighlights = payloadResult.pages[0].highlights;
    stats.acceptedPages += 1;
    stats.acceptedHighlights += normalizedHighlights.length;
    stats.rejectedHighlights += payloadResult.stats.rejectedHighlights;
    stats.rejectedSpans += payloadResult.stats.rejectedSpans;

    for (const group of normalizedHighlights) {
      stats.acceptedSpans += group.spans.length;
    }

    const rawMeta = isPlainObject(rawPage.meta) ? rawPage.meta : {};
    const title = typeof rawPage.title === 'string'
      ? rawPage.title
      : (typeof payloadResult.pages[0].title === 'string' ? payloadResult.pages[0].title : '');
    const lastUpdated = typeof rawMeta.lastUpdated === 'string'
      ? rawMeta.lastUpdated
      : (typeof rawPage.lastUpdated === 'string' ? rawPage.lastUpdated : '');
    const deletedGroupIds = isPlainObject(rawMeta.deletedGroupIds)
      ? { ...rawMeta.deletedGroupIds }
      : {};

    acceptedPages.push({
      url: rawPage.url,
      title,
      highlights: normalizedHighlights,
      meta: {
        lastUpdated,
        deletedGroupIds,
      },
    });
  }

  const snapshot = {
    schemaVersion: raw.schemaVersion,
    app: raw.app,
    exportedAt: typeof raw.exportedAt === 'string' ? raw.exportedAt : new Date().toISOString(),
    sitePolicy: normalizeSitePolicy(raw.sitePolicy),
    settings: extractBackupSettings(isPlainObject(raw.settings) ? raw.settings : {}),
    pages: acceptedPages,
  };

  return {
    valid: true,
    reason: null,
    snapshot,
    stats,
  };
}

/**
 * Restore preview descriptor: quick counts and mode for preview modal.
 */
export function describeBackupSnapshot(snapshot) {
  const pages = Array.isArray(snapshot?.pages) ? snapshot.pages : [];
  let highlightCount = 0;
  for (const page of pages) {
    if (Array.isArray(page?.highlights)) {
      highlightCount += page.highlights.length;
    }
  }

  const sitePolicy = snapshot?.sitePolicy;
  const sites = Array.isArray(sitePolicy?.sites) ? sitePolicy.sites : [];
  const mode = typeof sitePolicy?.mode === 'string' ? sitePolicy.mode : 'all';

  return {
    exportedAt: typeof snapshot?.exportedAt === 'string' ? snapshot.exportedAt : '',
    pageCount: pages.length,
    highlightCount,
    siteCount: sites.length,
    mode,
  };
}

function sortObjectKeysRecursively(val) {
  if (val === null || typeof val !== 'object') {
    return val;
  }
  if (Array.isArray(val)) {
    return val.map(sortObjectKeysRecursively);
  }
  const sorted = {};
  const keys = Object.keys(val).sort();
  for (const k of keys) {
    sorted[k] = sortObjectKeysRecursively(val[k]);
  }
  return sorted;
}

/**
 * Deterministic JSON representation for change detection.
 * Excludes volatile fields (exportedAt, timestamps) and enforces strict sorting.
 */
export function canonicalizeSnapshot(snapshot) {
  const rawSettings = isPlainObject(snapshot?.settings) ? snapshot.settings : {};
  const canonicalSettings = {
    customColors: Array.isArray(rawSettings.customColors)
      ? rawSettings.customColors.map(sortObjectKeysRecursively)
      : [],
    minimapVisible: typeof rawSettings.minimapVisible === 'boolean' ? rawSettings.minimapVisible : true,
    oneClickHighlightEnabled: typeof rawSettings.oneClickHighlightEnabled === 'boolean' ? rawSettings.oneClickHighlightEnabled : false,
    selectionControlsVisible: typeof rawSettings.selectionControlsVisible === 'boolean' ? rawSettings.selectionControlsVisible : true,
    shortcutColorMap: isPlainObject(rawSettings.shortcutColorMap)
      ? sortObjectKeysRecursively(rawSettings.shortcutColorMap)
      : {},
  };

  const rawSites = Array.isArray(snapshot?.sitePolicy?.sites) ? snapshot.sitePolicy.sites : [];
  const sortedSites = rawSites
    .map(s => ({
      hostname: typeof s.hostname === 'string' ? s.hostname : '',
      includeSubdomains: s.includeSubdomains === true,
    }))
    .sort((a, b) => a.hostname.localeCompare(b.hostname));

  const rawPages = Array.isArray(snapshot?.pages) ? snapshot.pages : [];
  const sortedPages = rawPages
    .slice()
    .sort((a, b) => (a.url || '').localeCompare(b.url || ''))
    .map(page => {
      const highlights = (Array.isArray(page.highlights) ? page.highlights : []).map(sortObjectKeysRecursively);
      const rawMeta = isPlainObject(page.meta) ? page.meta : {};
      const deletedGroupIds = isPlainObject(rawMeta.deletedGroupIds)
        ? sortObjectKeysRecursively(rawMeta.deletedGroupIds)
        : {};

      return {
        highlights,
        meta: {
          deletedGroupIds,
        },
        title: typeof page.title === 'string' ? page.title : '',
        url: typeof page.url === 'string' ? page.url : '',
      };
    });

  const canonicalObj = {
    app: snapshot?.app || BACKUP_APP_ID,
    pages: sortedPages,
    schemaVersion: snapshot?.schemaVersion || BACKUP_SCHEMA_VERSION,
    settings: canonicalSettings,
    sitePolicy: {
      mode: normalizeSiteMode(snapshot?.sitePolicy?.mode),
      sites: sortedSites,
      version: snapshot?.sitePolicy?.version || 1,
    },
  };

  return JSON.stringify(sortObjectKeysRecursively(canonicalObj));
}

/**
 * SHA-256 fingerprint of the canonical snapshot.
 */
export async function computeSnapshotFingerprint(snapshot) {
  const canonical = canonicalizeSnapshot(snapshot);
  const data = new TextEncoder().encode(canonical);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(digest);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Check whether a value matches the sealed backup envelope shape.
 */
export function isBackupEnvelope(value) {
  if (!isPlainObject(value)) {
    return false;
  }
  return value.format === BACKUP_FORMAT &&
    typeof value.version === 'number' &&
    typeof value.iv === 'string' &&
    typeof value.ciphertext === 'string' &&
    typeof value.alg === 'string' &&
    typeof value.kdf === 'string';
}

/**
 * Serialize a snapshot as the plaintext backup payload.
 *
 * This is the unencrypted twin of `sealBackupToText`: the same snapshot, no
 * envelope around it. What it writes is readable by anyone holding the file, so
 * it is only ever produced when the user turned encryption off.
 */
export function serializeSnapshot(snapshot) {
  return JSON.stringify(snapshot, null, 2);
}

/**
 * Read envelope metadata without decrypting the payload.
 */
export function readEnvelopeMeta(value) {
  if (!isPlainObject(value)) {
    return null;
  }
  return {
    format: typeof value.format === 'string' ? value.format : '',
    version: typeof value.version === 'number' ? value.version : 0,
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : '',
    alg: typeof value.alg === 'string' ? value.alg : '',
    kdf: typeof value.kdf === 'string' ? value.kdf : '',
  };
}
