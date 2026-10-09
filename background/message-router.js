import { browserAPI } from '../shared/browser-api.js';
import { DEBUG_MODE, debugLog } from '../shared/logger.js';
import { broadcastToAllTabs, broadcastToTabsByUrl } from '../shared/tab-broadcast.js';
import { STORAGE_KEYS, isPageStorageKey } from '../constants/storage-keys.js';
import {
  getPlatformInfo,
  getCurrentColors,
  addCustomColor,
  clearCustomColors,
  broadcastSettingsToTabs,
  createOrUpdateContextMenus,
  updateCustomColor,
  updateCustomColorName,
  removeCustomColor,
  getShortcutColorMap,
  saveShortcutColorMap,
  ensureCustomColorsLoaded,
} from './settings-service.js';
import {
  getSitePolicy,
  getSiteStatus,
  isUrlAllowed,
  applySiteMode,
  addSite,
  removeSite,
  updateSiteSubdomains,
} from './site-rule-service.js';
import {
  getBackupState,
  setBackupDestination,
  setBackupEncryption,
  setBackupAutoEnabled,
  saveGistConfig,
  saveWebdavConfig,
  generateBackupRecoveryCode,
  saveBackupRecoveryCode,
  testBackupConnection,
  runBackup,
  previewRemoteBackup,
  restoreFromRemoteBackup,
  exportLocalBackup,
} from './backup-service.js';
import { openExtensionPage } from './extension-pages.js';

function successResponse(data = {}) { return { success: true, ...data }; }
function errorResponse(message, code = 'generic_error', extra = {}) {
  return { success: false, code, error: message, ...extra };
}

const EXTENSION_PAGE_SCHEMES = [
  'moz-extension://',
  'chrome-extension://',
  'safari-web-extension://',
  'ms-browser-extension://',
];

/**
 * Backup actions answer only the pages that ship with the extension.
 *
 * A content script is an extension context, and `getBackupState` answers with
 * the recovery code - the one secret that turns a stolen remote file back into
 * the user's browsing history. The sender's URL is what separates the two: a
 * content script carries the page's own http(s) URL, while the settings page
 * carries the extension's scheme. A `sender.tab` cannot be that test on its
 * own, because opening settings puts it in a tab like any other page.
 */
function forExtensionPages(handler) {
  return (message, sender) => {
    const url = (sender && (sender.url || (sender.tab && sender.tab.url))) || '';
    if (!EXTENSION_PAGE_SCHEMES.some(scheme => url.startsWith(scheme))) {
      return Promise.resolve(errorResponse(
        'Backup actions are only available from the extension pages.',
        'backup_forbidden'
      ));
    }
    return handler(message, sender);
  };
}

// Merged-away group ids are kept as tombstones so a restore from a backup taken
// before the merge does not bring the merged groups back, and so the page itself
// can tell "removed" from "not in this export". They are small, but they only
// ever grow, so anything older than the retention window goes.
const DELETED_GROUP_ID_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function pruneDeletedGroupIds(deletedGroupIds) {
  const now = Date.now();
  for (const key of Object.keys(deletedGroupIds)) {
    if (now - deletedGroupIds[key] > DELETED_GROUP_ID_RETENTION_MS) delete deletedGroupIds[key];
  }
  return deletedGroupIds;
}

// ===================================================================
// Write authorization
// ===================================================================

/**
 * The URL the content scripts report is `location.href` with the
 * `#selection-<n>-<m>` fragment their own controls add stripped off, so a save
 * arrives under a URL that differs from the tab's by that fragment alone.
 */
function normalizePageUrl(url) {
  return typeof url === 'string' ? url.replace(/#selection-\d+-\d+$/, '') : url;
}

/**
 * Whether this sender may create a highlight for the URL it named.
 *
 * The tab URL is the authority, never the message: a content script can put
 * anything in `message.url`, so trusting it would make the site rules
 * advisory. A message that does not come from a page at all - the popup and the
 * settings page have no `sender.tab` - is refused outright, because neither of
 * them has any business creating a highlight.
 */
async function authorizeHighlightWrite(message, sender) {
  const senderUrl = sender && sender.tab ? sender.tab.url : null;
  if (!senderUrl) return { ok: false, code: 'site_not_allowed', error: 'Highlighting is not enabled on this site.' };

  const pageUrl = normalizePageUrl(senderUrl);
  if (normalizePageUrl(message.url) !== pageUrl) {
    return { ok: false, code: 'site_not_allowed', error: 'Highlighting is not enabled on this site.' };
  }
  if (!(await isUrlAllowed(pageUrl))) {
    return { ok: false, code: 'site_not_allowed', error: 'Highlighting is not enabled on this site.' };
  }
  return { ok: true, url: pageUrl };
}

// ===================================================================
// Action handlers
// ===================================================================

async function handleGetDebugMode(_message) {
  return { debugMode: DEBUG_MODE };
}

async function handleGetPlatformInfo(_message) {
  return getPlatformInfo();
}

async function handleOpenExtensionPage(message) {
  return openExtensionPage(message.page);
}

async function handleGetColors(_message) {
  await ensureCustomColorsLoaded();
  debugLog('Content script requested COLORS.');
  return { colors: getCurrentColors() };
}

async function handleSaveSettings(message) {
  const settings = {};
  if (message.minimapVisible !== undefined) settings.minimapVisible = message.minimapVisible;
  if (message.selectionControlsVisible !== undefined) settings.selectionControlsVisible = message.selectionControlsVisible;
  if (message.oneClickHighlightEnabled !== undefined) settings.oneClickHighlightEnabled = message.oneClickHighlightEnabled;

  const keys = Object.keys(settings);
  if (keys.length === 0) return successResponse();

  const previous = await browserAPI.storage.local.get(keys);
  const changedSettings = {};
  for (const key of keys) {
    if (previous[key] !== settings[key]) changedSettings[key] = settings[key];
  }

  await browserAPI.storage.local.set(settings);
  await broadcastSettingsToTabs(changedSettings);

  debugLog('Settings saved locally and broadcasted:', settings, 'changed:', changedSettings);
  return successResponse();
}

async function handleGetHighlights(message) {
  const result = await browserAPI.storage.local.get([message.url]);
  debugLog('Sending highlights for URL:', message.url, result[message.url] || []);
  return { highlights: result[message.url] || [] };
}

async function handleClearCustomColors(_message) {
  const { hadColors, colors } = await clearCustomColors();
  if (!hadColors) return successResponse({ noCustomColors: true, colors });

  await createOrUpdateContextMenus();
  await broadcastToAllTabs({ action: 'colorsUpdated', colors });
  return successResponse({ colors });
}

async function handleAddColor(message) {
  if (!message.color) return errorResponse('No color value provided');

  const { exists, colors } = await addCustomColor(message.color);
  if (!exists) {
    await createOrUpdateContextMenus();
    await broadcastToAllTabs({ action: 'colorsUpdated', colors });
  }
  return successResponse({ exists, colors });
}

async function handleUpdateCustomColor(message) {
  if (!message.id || !message.color) return errorResponse('Missing id or color');
  const result = await updateCustomColor(message.id, message.color);
  if (result.notFound) return errorResponse('Color not found');
  if (result.exists) return successResponse({ exists: true, colors: result.colors });
  await createOrUpdateContextMenus();
  await broadcastToAllTabs({ action: 'colorsUpdated', colors: result.colors });
  return successResponse({ colors: result.colors });
}

async function handleUpdateCustomColorName(message) {
  if (!message.id || !message.name) return errorResponse('Missing id or name');
  await ensureCustomColorsLoaded();
  const result = await updateCustomColorName(message.id, message.name);
  if (result.notFound) return errorResponse('Color not found');
  if (result.exists) return successResponse({ exists: true, colors: result.colors });
  await createOrUpdateContextMenus();
  await broadcastToAllTabs({ action: 'colorsUpdated', colors: result.colors });
  return successResponse({ colors: result.colors });
}

async function handleRemoveCustomColor(message) {
  if (!message.id) return errorResponse('Missing id');
  const result = await removeCustomColor(message.id);
  if (result.notFound) return errorResponse('Color not found');
  await createOrUpdateContextMenus();
  await broadcastToAllTabs({ action: 'colorsUpdated', colors: result.colors });
  return successResponse({ colors: result.colors });
}

async function handleGetShortcutColorMap(_message) {
  await ensureCustomColorsLoaded();
  return successResponse({ shortcutColorMap: getShortcutColorMap() });
}

async function handleSaveShortcutColorMap(message) {
  if (!message.shortcutColorMap) return errorResponse('Missing shortcutColorMap');
  await saveShortcutColorMap(message.shortcutColorMap);
  await createOrUpdateContextMenus();
  return successResponse();
}

async function handleSaveHighlights(message, sender) {
  const authorization = await authorizeHighlightWrite(message, sender);
  if (!authorization.ok) return errorResponse(authorization.error, authorization.code);
  const url = authorization.url;

  if (message.highlights.length > 0) {
    const metaKey = `${url}${STORAGE_KEYS.META_SUFFIX}`;
    const result = await browserAPI.storage.local.get([metaKey]);
    const metaData = result[metaKey] || {};
    if (sender && sender.tab) metaData.title = sender.tab.title;

    // Groups this save merged away. Their tombstones go into the same
    // storage.local.set as the list without them: a save from another tab on
    // this url that lands between two separate writes would read the new list
    // with the old metadata and write the tombstones away again.
    if (Array.isArray(message.deletedGroupIds) && message.deletedGroupIds.length > 0) {
      const deletedGroupIds = metaData.deletedGroupIds || {};
      const deletedAt = Date.now();
      message.deletedGroupIds.forEach(groupId => {
        deletedGroupIds[groupId] = deletedAt;
      });
      metaData.deletedGroupIds = pruneDeletedGroupIds(deletedGroupIds);
    }
    metaData.lastUpdated = new Date().toISOString();

    await browserAPI.storage.local.set({
      [url]: message.highlights,
      [metaKey]: metaData,
    });
    debugLog('Saved highlights for URL:', url, message.highlights.length);
    return successResponse();
  }

  await browserAPI.storage.local.remove([url, `${url}${STORAGE_KEYS.META_SUFFIX}`]);
  return successResponse();
}

// The tab that asked for the delete has already taken the group off its page,
// so it is left out of the refresh. A refresh there would replace the whole
// page with the storage state as of this delete - and a highlight the user made
// in the meantime is in that tab and in the save behind this one, but not in
// that state, so it would vanish until the next reload.
async function handleDeleteHighlight(message, sender) {
  const { url, groupId } = message;
  const excludeTabId = sender && sender.tab ? sender.tab.id : undefined;
  const result = await browserAPI.storage.local.get([url, `${url}${STORAGE_KEYS.META_SUFFIX}`]);
  const highlights = result[url] || [];
  const meta = result[`${url}${STORAGE_KEYS.META_SUFFIX}`] || {};

  const deletedGroupIds = meta.deletedGroupIds || {};
  deletedGroupIds[groupId] = Date.now();
  pruneDeletedGroupIds(deletedGroupIds);

  const updatedHighlights = highlights.filter(g => g.groupId !== groupId);

  if (updatedHighlights.length > 0) {
    const lastUpdated = new Date().toISOString();
    await browserAPI.storage.local.set({
      [url]: updatedHighlights,
      [`${url}${STORAGE_KEYS.META_SUFFIX}`]: { ...meta, deletedGroupIds, lastUpdated },
    });
    debugLog('Highlight group deleted:', groupId, 'from URL:', url);

    if (message.notifyRefresh) {
      await broadcastToTabsByUrl(url, { action: 'refreshHighlights', highlights: updatedHighlights }, { excludeTabId });
    }
    return successResponse({ highlights: updatedHighlights });
  }

  await browserAPI.storage.local.remove([url, `${url}${STORAGE_KEYS.META_SUFFIX}`]);
  if (message.notifyRefresh) {
    await broadcastToTabsByUrl(url, { action: 'refreshHighlights', highlights: [] }, { excludeTabId });
  }
  return successResponse({ highlights: [] });
}

async function handleClearAllHighlights(message) {
  const { url } = message;
  await browserAPI.storage.local.remove([url, `${url}${STORAGE_KEYS.META_SUFFIX}`]);
  if (message.notifyRefresh) {
    await broadcastToTabsByUrl(url, { action: 'refreshHighlights', highlights: [] });
  }
  return successResponse();
}

async function handleGetAllHighlightedPages(_message) {
  const result = await browserAPI.storage.local.get(null);
  const pages = [];

  for (const key in result) {
    if (!isPageStorageKey(key, result[key]) || result[key].length === 0) continue;
    const metadata = result[`${key}${STORAGE_KEYS.META_SUFFIX}`] || {};
    pages.push({
      url: key,
      highlights: result[key],
      highlightCount: result[key].length,
      title: metadata.title || '',
      lastUpdated: metadata.lastUpdated || '',
    });
  }

  debugLog('Retrieved all highlighted pages:', pages.length);

  pages.sort((a, b) => {
    if (!a.lastUpdated) return 1;
    if (!b.lastUpdated) return -1;
    return new Date(b.lastUpdated) - new Date(a.lastUpdated);
  });

  return successResponse({ pages });
}

async function handleDeleteAllHighlightedPages(_message) {
  const result = await browserAPI.storage.local.get(null);
  const keysToDelete = [];

  for (const key in result) {
    if (!isPageStorageKey(key, result[key]) || result[key].length === 0) continue;
    keysToDelete.push(key, `${key}${STORAGE_KEYS.META_SUFFIX}`);
  }

  if (keysToDelete.length > 0) {
    await browserAPI.storage.local.remove(keysToDelete);
    debugLog('All highlighted pages deleted:', keysToDelete.length / 2);
  }

  return successResponse({ deletedCount: keysToDelete.length / 2 });
}

// --- Site rules ----------------------------------------------------

async function handleGetSitePolicy(_message) {
  return successResponse({ policy: await getSitePolicy() });
}

async function handleSetSitePolicyMode(message) {
  const outcome = await applySiteMode(message.mode);
  return successResponse({ policy: outcome.policy, injected: outcome.injected, needsRefresh: outcome.needsRefresh });
}

async function handleAddSiteRule(message) {
  const outcome = await addSite(message.hostname, message.includeSubdomains === true);
  if (!outcome.ok) return errorResponse('Enter a website address such as example.org.', 'site_invalid_hostname');
  return successResponse({
    policy: outcome.policy,
    added: outcome.added,
    hostname: outcome.hostname,
    injected: outcome.injected || 0,
    needsRefresh: outcome.needsRefresh === true,
  });
}

async function handleRemoveSiteRule(message) {
  const outcome = await removeSite(message.hostname);
  if (!outcome.ok) return errorResponse('Enter a website address such as example.org.', 'site_invalid_hostname');
  return successResponse({
    policy: outcome.policy,
    removed: outcome.removed,
    hostname: outcome.hostname,
    tornDown: outcome.tornDown || 0,
  });
}

async function handleSetSiteRuleSubdomains(message) {
  const outcome = await updateSiteSubdomains(message.hostname, message.includeSubdomains === true);
  if (!outcome.ok) {
    const notFound = outcome.reason === 'not-found';
    return errorResponse(
      notFound ? 'That site is not in the list.' : 'Enter a website address such as example.org.',
      notFound ? 'site_not_found' : 'site_invalid_hostname'
    );
  }
  return successResponse({
    policy: outcome.policy,
    hostname: outcome.hostname,
    updated: outcome.updated,
    injected: outcome.injected || 0,
    needsRefresh: outcome.needsRefresh === true,
    tornDown: outcome.tornDown || 0,
  });
}

async function handleGetSiteStatus(message) {
  let url = message.url;
  if (!url) {
    const tabs = await browserAPI.tabs.query({ active: true, currentWindow: true });
    url = tabs && tabs[0] ? tabs[0].url : null;
  }
  if (!url) return successResponse({ status: { supported: false, allowed: false, hostname: null, mode: 'all', matchedRule: null, reason: 'unsupported-url' } });
  return successResponse({ status: await getSiteStatus(url) });
}

// --- Backup and restore --------------------------------------------

async function handleGetBackupState(_message) {
  return successResponse({ state: await getBackupState() });
}

async function handleSetBackupDestination(message) {
  const result = await setBackupDestination(message.destination);
  if (!result.ok) return errorResponse(result.message, result.code);
  return successResponse({
    state: await getBackupState(),
    generatedRecoveryCode: result.generatedRecoveryCode || null,
  });
}

async function handleSetBackupEncryption(message) {
  const result = await setBackupEncryption(message.enabled === true);
  return successResponse({
    state: await getBackupState(),
    generatedRecoveryCode: result.generatedRecoveryCode || null,
  });
}

async function handleSetBackupAutoEnabled(message) {
  await setBackupAutoEnabled(message.enabled === true);
  return successResponse({ state: await getBackupState() });
}

async function handleSaveGistConfig(message) {
  const result = await saveGistConfig(message);
  if (!result.ok) return errorResponse(result.message, result.code);
  return successResponse({ state: await getBackupState() });
}

async function handleSaveWebdavConfig(message) {
  const result = await saveWebdavConfig(message);
  if (!result.ok) return errorResponse(result.message, result.code);
  return successResponse({ state: await getBackupState() });
}

async function handleGenerateBackupRecoveryCode(_message) {
  const result = await generateBackupRecoveryCode();
  return successResponse({ state: await getBackupState(), code: result.code });
}

async function handleSaveBackupRecoveryCode(message) {
  const result = await saveBackupRecoveryCode(message.code);
  if (!result.ok) return errorResponse(result.message, result.code);
  return successResponse({ state: await getBackupState() });
}

async function handleTestBackupConnection(_message) {
  const result = await testBackupConnection();
  const state = await getBackupState();
  if (!result.ok) return errorResponse(result.message, result.code, { state, details: result.details });
  return successResponse({ state, details: result.details || null });
}

async function handleRunBackupNow(message) {
  const result = await runBackup({ force: message.force === true });
  return successResponse({ state: await getBackupState(), result });
}

async function handlePreviewRemoteBackup(_message) {
  const result = await previewRemoteBackup();
  if (!result.ok) return errorResponse(result.message, result.code, { state: await getBackupState() });
  return successResponse({
    preview: result.preview,
    source: result.source,
    encrypted: result.encrypted,
    state: await getBackupState(),
  });
}

async function handleRestoreFromRemoteBackup(message) {
  if (message.confirm !== true) {
    return errorResponse('A restore has to be confirmed first.', 'backup_confirm_required');
  }
  const result = await restoreFromRemoteBackup({ acceptMissingSnapshot: message.acceptMissingSnapshot === true });
  if (!result.ok) return errorResponse(result.message, result.code, { state: await getBackupState() });

  // The restored site rules were written straight to storage; the menus the
  // user is about to look at describe the old ones until this runs.
  await createOrUpdateContextMenus();
  return successResponse({
    summary: result.summary,
    safetySnapshot: result.safetySnapshot,
    encrypted: result.encrypted,
    state: await getBackupState(),
  });
}

async function handleExportLocalBackup(_message) {
  const result = await exportLocalBackup();
  if (!result.ok) return errorResponse(result.message, result.code);
  return successResponse({ filename: result.filename, encrypted: result.encrypted, state: await getBackupState() });
}

// ===================================================================
// Action handler map
// ===================================================================

const ACTION_HANDLERS = {
  getDebugMode:              handleGetDebugMode,
  getPlatformInfo:           handleGetPlatformInfo,
  openExtensionPage:         handleOpenExtensionPage,
  getColors:                 handleGetColors,
  saveSettings:              handleSaveSettings,
  getHighlights:             handleGetHighlights,
  clearCustomColors:         handleClearCustomColors,
  addColor:                  handleAddColor,
  updateCustomColor:         handleUpdateCustomColor,
  updateCustomColorName:     handleUpdateCustomColorName,
  removeCustomColor:         handleRemoveCustomColor,
  getShortcutColorMap:       handleGetShortcutColorMap,
  saveShortcutColorMap:      handleSaveShortcutColorMap,
  saveHighlights:            handleSaveHighlights,
  deleteHighlight:           handleDeleteHighlight,
  clearAllHighlights:        handleClearAllHighlights,
  getAllHighlightedPages:    handleGetAllHighlightedPages,
  deleteAllHighlightedPages: handleDeleteAllHighlightedPages,
  getSitePolicy:             handleGetSitePolicy,
  setSitePolicyMode:         handleSetSitePolicyMode,
  addSiteRule:               handleAddSiteRule,
  removeSiteRule:            handleRemoveSiteRule,
  setSiteRuleSubdomains:     handleSetSiteRuleSubdomains,
  getSiteStatus:             handleGetSiteStatus,
  getBackupState:            forExtensionPages(handleGetBackupState),
  setBackupDestination:      forExtensionPages(handleSetBackupDestination),
  setBackupEncryption:       forExtensionPages(handleSetBackupEncryption),
  setBackupAutoEnabled:      forExtensionPages(handleSetBackupAutoEnabled),
  saveGistConfig:            forExtensionPages(handleSaveGistConfig),
  saveWebdavConfig:          forExtensionPages(handleSaveWebdavConfig),
  generateBackupRecoveryCode: forExtensionPages(handleGenerateBackupRecoveryCode),
  saveBackupRecoveryCode:    forExtensionPages(handleSaveBackupRecoveryCode),
  testBackupConnection:      forExtensionPages(handleTestBackupConnection),
  runBackupNow:              forExtensionPages(handleRunBackupNow),
  previewRemoteBackup:       forExtensionPages(handlePreviewRemoteBackup),
  restoreFromRemoteBackup:   forExtensionPages(handleRestoreFromRemoteBackup),
  exportLocalBackup:         forExtensionPages(handleExportLocalBackup),
};

// Messages one extension page sends to another. runtime.sendMessage reaches the
// background too, and an error reply from here could answer the sender before
// the page it was meant for does, so the router leaves them unanswered.
const PAGE_TO_PAGE_ACTIONS = new Set([
  'refreshPagesList',
]);

/**
 * Register the runtime.onMessage listener.
 * Call once at service worker startup (top-level, before any async code).
 */
export function registerMessageRouter() {
  browserAPI.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (PAGE_TO_PAGE_ACTIONS.has(message.action)) return false;

    const handler = ACTION_HANDLERS[message.action];
    if (!handler) {
      sendResponse(errorResponse(`Unknown action: ${message.action}`, 'unknown_action'));
      return true;
    }

    handler(message, sender)
      .then(result => sendResponse(result))
      .catch(e => {
        debugLog('Error in message handler:', e);
        sendResponse(errorResponse(e.message, 'handler_error'));
      });

    return true; // Keep message channel open for async response
  });
}
