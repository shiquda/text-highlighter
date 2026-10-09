import { browserAPI } from '../shared/browser-api.js';
import { debugLog, errorLog } from '../shared/logger.js';
import { sendMessageToTab } from '../shared/tab-broadcast.js';
import { STORAGE_KEYS } from '../constants/storage-keys.js';
import { SITE_MODES, buildMatchPatterns } from '../shared/site-rules.js';
import { getSitePolicy, getActiveTabSiteStatus } from './site-rule-service.js';

// Context menu ids the site rules own. The click handler in context-menu.js
// matches on these, so they are named here rather than spelled out twice.
export const SITE_MENU_ENABLE = 'marks-site-enable';
export const SITE_MENU_REMOVE = 'marks-site-remove';

const COLORS = [
  { id: 'yellow', nameKey: 'yellowColor', color: '#FFFF00' },
  { id: 'green',  nameKey: 'greenColor',  color: '#AAFFAA' },
  { id: 'blue',   nameKey: 'blueColor',   color: '#AAAAFF' },
  { id: 'pink',   nameKey: 'pinkColor',   color: '#FFAAFF' },
  { id: 'orange', nameKey: 'orangeColor', color: '#FFAA55' },
];

const DEFAULT_SHORTCUT_COLOR_MAP = {
  command_slot_1: 'yellow',
  command_slot_2:  'green',
  command_slot_3:   'blue',
  command_slot_4:   'pink',
  command_slot_5: 'orange',
};

let currentColors = [...COLORS];
let platformInfo = { os: 'unknown' };
let storedShortcuts = {};
let shortcutColorMap = { ...DEFAULT_SHORTCUT_COLOR_MAP };
let hasLoadedCustomColors = false;
let customColorsLoadInFlight = null;

function isValidCustomColorNumber(value) {
  return Number.isInteger(value) && value > 0;
}

function normalizeCustomColorNumbers(customColors) {
  const usedNumbers = new Set();
  let maxNumber = 0;
  let needsUpdate = false;

  customColors.forEach((colorObj) => {
    if (isValidCustomColorNumber(colorObj.colorNumber) && !usedNumbers.has(colorObj.colorNumber)) {
      usedNumbers.add(colorObj.colorNumber);
      maxNumber = Math.max(maxNumber, colorObj.colorNumber);
      return;
    }

    let nextNumber = maxNumber + 1;
    while (usedNumbers.has(nextNumber)) {
      nextNumber += 1;
    }

    colorObj.colorNumber = nextNumber;
    usedNumbers.add(nextNumber);
    maxNumber = nextNumber;
    needsUpdate = true;
  });

  return { maxNumber, needsUpdate };
}

function getMessage(key) {
  return browserAPI.i18n.getMessage(key);
}

function getCustomColorBaseName() {
  return getMessage('customColor') || 'Custom Color';
}

function isCustomColor(color) {
  return color && typeof color.id === 'string' && color.id.startsWith('custom_');
}

function getColorDisplayName(color) {
  if (color.customName) return color.customName;

  if (isCustomColor(color)) {
    const baseName = getCustomColorBaseName();
    return color.colorNumber ? `${baseName} ${color.colorNumber}` : baseName;
  }

  if (color.nameKey) {
    return getMessage(color.nameKey) || color.nameKey;
  }

  return color.color || '';
}

function sanitizeCustomColors(customColors) {
  let needsUpdate = false;

  customColors.forEach((colorObj) => {
    if (Object.prototype.hasOwnProperty.call(colorObj, 'nameKey')) {
      delete colorObj.nameKey;
      needsUpdate = true;
    }
  });

  const normalized = normalizeCustomColorNumbers(customColors);
  return { ...normalized, needsUpdate: needsUpdate || normalized.needsUpdate };
}

// The worker registers its message listener before startup has detected the
// platform, so the message that wakes it can be handled first. getPlatformInfo
// waits for the detection in flight rather than answering from the 'unknown'
// starting state.
let platformDetectionInFlight = null;

async function detectPlatform() {
  try {
    platformInfo = await browserAPI.runtime.getPlatformInfo();
    debugLog('Platform detected:', platformInfo);
    return true;
  } catch (e) {
    debugLog('Platform detection failed:', e);
    return false;
  }
}

export function initializePlatform() {
  const detection = detectPlatform();
  platformDetectionInFlight = detection;
  detection.then((detected) => {
    // A failed detection is not kept: the next question asks again instead of
    // being told "not mobile" for the life of the worker.
    if (!detected && platformDetectionInFlight === detection) {
      platformDetectionInFlight = null;
    }
  });
  return detection;
}

export function isMobile() {
  return platformInfo.os === 'android';
}

// Content scripts ask this once, and decide their mobile UI from the answer for
// the life of the tab, so it waits for the detection.
export async function getPlatformInfo() {
  await (platformDetectionInFlight || initializePlatform());
  return { platform: platformInfo, isMobile: isMobile() };
}

export function getCurrentColors() {
  return currentColors;
}

export function getStoredShortcuts() {
  return storedShortcuts;
}

export function getShortcutColorMap() {
  return shortcutColorMap;
}

export async function saveShortcutColorMap(newMap) {
  shortcutColorMap = { ...newMap };
  await browserAPI.storage.local.set({ [STORAGE_KEYS.SHORTCUT_COLOR_MAP]: shortcutColorMap });
}

async function loadShortcutColorMap() {
  const result = await browserAPI.storage.local.get([STORAGE_KEYS.SHORTCUT_COLOR_MAP]);
  shortcutColorMap = result[STORAGE_KEYS.SHORTCUT_COLOR_MAP] || { ...DEFAULT_SHORTCUT_COLOR_MAP };
}

export async function getCurrentShortcuts() {
  if (!browserAPI.commands) return {};
  const commands = await browserAPI.commands.getAll();
  const shortcuts = {};
  commands.forEach(command => {
    if (command.name.startsWith('command_') && command.shortcut) {
      shortcuts[command.name] = ` (${command.shortcut})`;
    }
  });
  return shortcuts;
}

async function createContextMenu(options) {
  try {
    await browserAPI.contextMenus.create(options);
  } catch (error) {
    if (!error.message.includes('duplicate id')) {
      debugLog('Error creating context menu:', options.id, error);
    }
  }
}

export async function createOrUpdateContextMenus() {
  if (isMobile() || !browserAPI.contextMenus) return;
  debugLog('Creating/updating context menus...');

  try {
    await browserAPI.contextMenus.removeAll();
  } catch (error) {
    debugLog('Error removing context menus:', error);
    return;
  }

  const policy = await getSitePolicy();
  const patterns = buildMatchPatterns(policy);
  const { status } = await getActiveTabSiteStatus();

  // Both site items are always present, with the inapplicable one greyed rather
  // than absent, so the menu does not reshuffle itself under the cursor.
  await createContextMenu({
    id: SITE_MENU_ENABLE,
    title: getMessage('contextMenuEnableSite'),
    contexts: ['page'],
    enabled: Boolean(status && status.supported && status.mode === SITE_MODES.ALLOWLIST && !status.allowed),
  });
  await createContextMenu({
    id: SITE_MENU_REMOVE,
    title: getMessage('contextMenuRemoveSite'),
    contexts: ['page'],
    enabled: Boolean(status && status.matchedRule),
  });

  const commandShortcuts = await getCurrentShortcuts();
  storedShortcuts = { ...commandShortcuts };

  // An empty allowlist matches nothing, so there is no page to offer a colour
  // on and the items are left off entirely. On every other page the pattern
  // list is what keeps the colour items out of the menu where the user is not
  // allowed to highlight; the background refuses the write as well, because a
  // menu is not an authorization check.
  if (patterns.length > 0) {
    await createContextMenu({
      id: 'highlight-text',
      title: getMessage('highlightText'),
      contexts: ['selection'],
      documentUrlPatterns: patterns,
    });

    for (const color of currentColors) {
      const slotName = Object.keys(shortcutColorMap).find(key => shortcutColorMap[key] === color.id);
      const shortcutDisplay = (slotName && commandShortcuts[slotName]) || '';

      let title;
      if (color.customName) {
        title = `${color.customName}${shortcutDisplay}`;
      } else {
        title = `${getColorDisplayName(color)}${shortcutDisplay}`;
      }

      await createContextMenu({
        id: `highlight-${color.id}`,
        parentId: 'highlight-text',
        title,
        contexts: ['selection'],
        documentUrlPatterns: patterns,
      });
    }
  }

  debugLog('Context menus created with shortcuts:', storedShortcuts);
}

async function loadCustomColorsFromStorage() {
  const result = await browserAPI.storage.local.get([STORAGE_KEYS.CUSTOM_COLORS]);
  const customColors = result.customColors || [];

  const { needsUpdate } = sanitizeCustomColors(customColors);
  currentColors = [...COLORS];
  customColors.forEach((c) => {
    if (!currentColors.some(existing => existing.color.toLowerCase() === c.color.toLowerCase())) {
      currentColors.push(c);
    }
  });

  if (needsUpdate) {
    await browserAPI.storage.local.set({ customColors });
    debugLog('Updated custom colors with numbers:', customColors);
  }

  if (customColors.length) {
    debugLog('Loaded custom colors:', customColors);
  }

  await loadShortcutColorMap();
}

export async function loadCustomColors() {
  if (hasLoadedCustomColors) return;
  if (customColorsLoadInFlight) {
    await customColorsLoadInFlight;
    return;
  }

  customColorsLoadInFlight = (async () => {
    try {
      await loadCustomColorsFromStorage();
      hasLoadedCustomColors = true;
    } catch (e) {
      errorLog('Error loading custom colors', e);
      throw e;
    } finally {
      customColorsLoadInFlight = null;
    }
  })();

  await customColorsLoadInFlight;
}

export async function ensureCustomColorsLoaded() {
  if (hasLoadedCustomColors) return;
  await loadCustomColors();
}

// Every change to the palette starts here. A worker that a message woke up is
// still loading the colours when it handles that message; a change made before
// the load lands is overwritten by it, and the palette the tabs were sent
// differs from the one the worker keeps until it next restarts. Waiting for
// the load first means a change always lands on top of the loaded list.
//
// A load that failed is not a reason to refuse the change: the colours it was
// going to read are read again by the change itself.
async function settleLoadBeforeChange() {
  try {
    await ensureCustomColorsLoaded();
  } catch (e) {
    debugLog('Custom colours could not be loaded before a change; changing anyway:', e);
  }
}

export async function updateCustomColorName(id, newName) {
  await settleLoadBeforeChange();
  const stored = await browserAPI.storage.local.get([STORAGE_KEYS.CUSTOM_COLORS]);
  const customColors = stored.customColors || [];

  const idx = customColors.findIndex(c => c.id === id);
  if (idx === -1) return { notFound: true, colors: currentColors };

  // Check for duplicates in custom names or generated default names
  const duplicate = [...COLORS, ...customColors].some((c) => {
    if (c.id === id) return false;
    const currentName = getColorDisplayName(c);
    return currentName.toLowerCase() === newName.toLowerCase();
  });

  if (duplicate) return { exists: true, colors: currentColors };

  const finalName = newName.substring(0, 50);

  customColors[idx] = { ...customColors[idx], customName: finalName };
  await browserAPI.storage.local.set({ customColors });

  const globalIdx = currentColors.findIndex(c => c.id === id);
  if (globalIdx !== -1) currentColors[globalIdx] = { ...currentColors[globalIdx], customName: finalName };

  return { exists: false, colors: currentColors };
}

export async function updateCustomColor(id, newColorValue) {
  await settleLoadBeforeChange();
  const stored = await browserAPI.storage.local.get([STORAGE_KEYS.CUSTOM_COLORS]);
  const customColors = stored.customColors || [];

  const idx = customColors.findIndex(c => c.id === id);
  if (idx === -1) return { notFound: true, colors: currentColors };

  // Check for duplicates
  const duplicate = [...COLORS, ...customColors].some(
    (c, i) => c.color.toLowerCase() === newColorValue.toLowerCase() && c.id !== id
  );
  if (duplicate) return { exists: true, colors: currentColors };

  customColors[idx] = { ...customColors[idx], color: newColorValue };
  await browserAPI.storage.local.set({ customColors });

  const globalIdx = currentColors.findIndex(c => c.id === id);
  if (globalIdx !== -1) currentColors[globalIdx] = { ...currentColors[globalIdx], color: newColorValue };

  return { exists: false, colors: currentColors };
}

export async function removeCustomColor(id) {
  await settleLoadBeforeChange();
  const stored = await browserAPI.storage.local.get([STORAGE_KEYS.CUSTOM_COLORS]);
  let customColors = stored.customColors || [];

  const before = customColors.length;
  customColors = customColors.filter(c => c.id !== id);
  if (customColors.length === before) return { notFound: true, colors: currentColors };

  await browserAPI.storage.local.set({ customColors });
  currentColors = currentColors.filter(c => c.id !== id);

  return { colors: currentColors };
}

/**
 * Add a new custom color.
 * @returns {{ exists: boolean, colors: object[] }}
 */
export async function addCustomColor(newColorValue) {
  if (!newColorValue) return { exists: true, colors: currentColors };

  await settleLoadBeforeChange();
  const stored = await browserAPI.storage.local.get([STORAGE_KEYS.CUSTOM_COLORS]);
  let customColors = stored.customColors || [];

  const exists = [...currentColors, ...customColors].some(
    c => c.color.toLowerCase() === newColorValue.toLowerCase()
  );
  if (exists) return { exists: true, colors: currentColors };

  const { maxNumber } = normalizeCustomColorNumbers(customColors);
  const newColorObj = {
    id: `custom_${Date.now()}`,
    colorNumber: maxNumber + 1,
    color: newColorValue,
  };

  customColors.push(newColorObj);
  currentColors.push(newColorObj);
  await browserAPI.storage.local.set({ customColors });
  debugLog('Added custom color:', newColorObj);

  return { exists: false, colors: currentColors };
}

/**
 * Clear all custom colors.
 * @returns {{ hadColors: boolean, colors: object[] }}
 */
export async function clearCustomColors() {
  await settleLoadBeforeChange();
  const result = await browserAPI.storage.local.get([STORAGE_KEYS.CUSTOM_COLORS]);
  const customColors = result.customColors || [];

  if (customColors.length === 0) {
    debugLog('No custom colors to clear');
    return { hadColors: false, colors: currentColors };
  }

  await browserAPI.storage.local.set({ customColors: [] });
  currentColors = currentColors.filter(c => !c.id.startsWith('custom_'));
  debugLog('Cleared all custom colors');

  return { hadColors: true, colors: currentColors };
}

export async function broadcastSettingsToTabs(changedSettings) {
  if (!changedSettings || Object.keys(changedSettings).length === 0) return;

  const tabs = await browserAPI.tabs.query({});
  for (const tab of tabs) {
    if (changedSettings.minimapVisible !== undefined) {
      await sendMessageToTab(tab.id, {
        action: 'setMinimapVisibility',
        visible: changedSettings.minimapVisible,
      });
    }
    if (changedSettings.selectionControlsVisible !== undefined) {
      await sendMessageToTab(tab.id, {
        action: 'setSelectionControlsVisibility',
        visible: changedSettings.selectionControlsVisible,
      });
    }
    if (changedSettings.oneClickHighlightEnabled !== undefined) {
      await sendMessageToTab(tab.id, {
        action: 'setOneClickHighlight',
        enabled: changedSettings.oneClickHighlightEnabled,
      });
    }
  }
}
