import { browserAPI } from '../shared/browser-api.js';
import { debugLog } from '../shared/logger.js';
import { sendMessageToTab } from '../shared/tab-broadcast.js';
import {
  isMobile,
  getCurrentColors,
  getCurrentShortcuts,
  getStoredShortcuts,
  createOrUpdateContextMenus,
  getShortcutColorMap,
  SITE_MENU_ENABLE,
  SITE_MENU_REMOVE,
} from './settings-service.js';
import { addSite, removeSite, isUrlAllowed } from './site-rule-service.js';

// Shortcut commands that move between highlights, and the direction each sends.
const NAVIGATION_COMMANDS = {
  navigate_next_highlight: 'next',
  navigate_previous_highlight: 'previous',
};

async function enableSiteForTab(tab) {
  if (!tab || typeof tab.url !== 'string') return;
  // The whole URL goes in rather than a hostname parsed here: normalising a
  // page URL into a rule is the site service's job, and a second parser in the
  // menu would be a second answer to the same question.
  const outcome = await addSite(tab.url, false);
  if (!outcome.ok) {
    debugLog('Could not enable the site from the context menu:', outcome.reason);
    return;
  }
  debugLog('Site enabled from the context menu:', outcome.hostname, 'injected into', outcome.injected, 'tab(s)');
}

async function removeSiteForTab(tab) {
  if (!tab || typeof tab.url !== 'string') return;
  const outcome = await removeSite(tab.url);
  if (!outcome.ok) {
    debugLog('Could not remove the site from the context menu:', outcome.reason);
    return;
  }
  debugLog('Site removed from the context menu:', outcome.hostname, 'torn down in', outcome.tornDown, 'tab(s)');
}

/**
 * Register context menu, shortcut, and tab activation listeners.
 * Call once at service worker startup.
 */
export function initContextMenus() {
  // Context menu click handler (desktop only)
  if (browserAPI.contextMenus) {
    browserAPI.contextMenus.onClicked.addListener(async (info, tab) => {
      const menuId = info.menuItemId;
      debugLog('Context menu clicked:', menuId);

      if (menuId === SITE_MENU_ENABLE) {
        await enableSiteForTab(tab);
        return;
      }
      if (menuId === SITE_MENU_REMOVE) {
        await removeSiteForTab(tab);
        return;
      }

      if (menuId.startsWith('highlight-') && menuId !== 'highlight-text') {
        const colorId = menuId.replace('highlight-', '');
        const color = getCurrentColors().find(c => c.id === colorId);
        if (!color) return;

        // The menu items are already restricted to allowed pages, but a menu is
        // a hint, not a gate: the tab may have navigated between the right-click
        // and the click, and the popup's own buttons come through this path too.
        if (!tab || !(await isUrlAllowed(tab.url))) {
          debugLog('Refused a highlight from the context menu on a site that is not allowed');
          return;
        }

        debugLog('Sending highlight action to tab:', tab.id);
        const response = await sendMessageToTab(tab.id, {
          action: 'highlight',
          color: color.color,
          text: info.selectionText,
        });
        debugLog('Highlight action response:', response);
      }
    });
  }

  // Shortcut command handler (desktop only)
  if (browserAPI.commands) {
    browserAPI.commands.onCommand.addListener(async (command) => {
      debugLog('Command received:', command);
      const tabs = await browserAPI.tabs.query({ active: true, currentWindow: true });
      const activeTab = tabs[0];

      if (activeTab) {
        let targetColor = null;
        if (NAVIGATION_COMMANDS[command]) {
          await sendMessageToTab(activeTab.id, {
            action: 'jumpToAdjacentHighlight',
            direction: NAVIGATION_COMMANDS[command],
          });
          return;
        }
        if (command.startsWith('command_slot_')) {
          const colorMap = getShortcutColorMap();
          const colorId = colorMap[command] ?? null;
          targetColor = colorId ? getCurrentColors().find(c => c.id === colorId)?.color : null;
        }

        if (targetColor) {
          // Keyboard shortcuts have no menu to grey out, so this is the only
          // thing standing between a shortcut and a site the user excluded.
          if (!(await isUrlAllowed(activeTab.url))) {
            debugLog('Refused a highlight from a shortcut on a site that is not allowed');
            return;
          }

          debugLog('Sending highlight action to tab:', activeTab.id, 'with color:', targetColor);
          const response = await sendMessageToTab(activeTab.id, {
            action: 'highlight',
            color: targetColor,
          });
          debugLog('Highlight action response:', response);
        }
      }
    });
  }

  // The site items in the menu describe the page on screen, so they are rebuilt
  // when that page changes. Recreating is a handful of items and keeps one code
  // path - "what should the menu look like right now" - instead of a diff.
  const refreshMenus = () => {
    createOrUpdateContextMenus().catch(error => debugLog('Could not refresh context menus:', error.message));
  };

  browserAPI.tabs.onActivated.addListener(async () => {
    if (isMobile()) return;

    if (browserAPI.commands) {
      const currentShortcuts = await getCurrentShortcuts();
      const stored = getStoredShortcuts();
      let hasChanged = false;

      for (const commandName in currentShortcuts) {
        if (stored[commandName] !== currentShortcuts[commandName]) {
          hasChanged = true;
          break;
        }
      }
      if (!hasChanged) {
        for (const commandName in stored) {
          if (!currentShortcuts[commandName]) {
            hasChanged = true;
            break;
          }
        }
      }

      if (hasChanged) {
        debugLog('Shortcut changes detected, updating context menus');
      }
    }

    refreshMenus();
  });

  if (browserAPI.tabs.onUpdated) {
    browserAPI.tabs.onUpdated.addListener((_tabId, changeInfo) => {
      if (isMobile()) return;
      if (!changeInfo || !changeInfo.url) return;
      refreshMenus();
    });
  }
}
