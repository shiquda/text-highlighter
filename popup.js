import { browserAPI } from './shared/browser-api.js';
import { debugLog } from './shared/logger.js';
import { createLocalizedModalHelpers } from './shared/modal.js';
import { initializeThemeWatcher } from './shared/theme.js';
import { sendMessageToTab } from './shared/tab-broadcast.js';
import { sendToBackground } from './shared/runtime-message.js';

const URL_PARAMS  = new URLSearchParams(window.location.search);

// Safety stop for the poll that waits out a page's restore, so a page reporting
// a restore that never arrives cannot leave a timer running for the life of the
// popup. It is not a deadline for deciding: reaching it means the answer is
// still unknown, and an unknown entry is left alone. So it can afford to be well
// past any real restore, cold service worker included.
const PENDING_RESTORE_POLL_LIMIT_MS = 15000;

async function getActiveTab() {
  // Open popup.html?tab=5 to use tab ID 5, etc.
  if (URL_PARAMS.has("tab")) {
    const tabId = parseInt(URL_PARAMS.get("tab"));
    return await browserAPI.tabs.get(tabId);
  }

  const tabs = await browserAPI.tabs.query({
    active: true,
    currentWindow: true
  });

  return tabs[0];
}

// Internationalization helper
function initializeI18n() {
  // Get all elements with data-i18n attribute
  const elements = document.querySelectorAll('[data-i18n]');

  elements.forEach(element => {
    const key = element.getAttribute('data-i18n');
    const message = browserAPI.i18n.getMessage(key);

    if (message) {
      // Set the content based on element type
      if (element.tagName === 'INPUT' && element.type === 'button') {
        element.value = message;
      } else if (element.tagName === 'INPUT' && element.placeholder !== undefined) {
        element.placeholder = message;
      } else if (element.tagName === 'META' && element.name === 'description') {
        element.content = message;
      } else if (element.tagName === 'TITLE') {
        element.textContent = message;
      } else {
        element.textContent = message;
      }
    }
  });
  
  // Handle data-i18n-title attributes
  const elementsWithTitle = document.querySelectorAll('[data-i18n-title]');
  elementsWithTitle.forEach(element => {
    const key = element.getAttribute('data-i18n-title');
    const message = browserAPI.i18n.getMessage(key);
    if (message) {
      element.title = message;
    }
  });
}

const { showConfirmModal, showAlertModal } = createLocalizedModalHelpers(
  (key, defaultValue) => browserAPI.i18n.getMessage(key) || defaultValue
);

function getMessage(key, fallback = '') {
  if (typeof chrome !== 'undefined' && browserAPI.i18n) {
    return browserAPI.i18n.getMessage(key) || fallback || key;
  }
  return fallback || key;
}

function extractHostname(url) {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    // A file has no hostname; its name is the closest thing to one, and an
    // empty line under "This site" would read as a page that failed to load.
    if (parsed.protocol === 'file:') return decodeURIComponent(parsed.pathname.split('/').pop() || '');
    return parsed.hostname;
  } catch {
    return '';
  }
}

function extractScheme(url) {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    return parsed.protocol ? parsed.protocol.replace(/:$/, '') : '';
  } catch {
    const match = /^([a-z][a-z0-9+.-]*):/i.exec(url);
    return match ? match[1].toLowerCase() : '';
  }
}

document.addEventListener('DOMContentLoaded', async function () {
  // Initialize internationalization first
  initializeI18n();
  
  // Initialize theme watcher
  initializeThemeWatcher();

  const highlightsContainer = document.getElementById('highlights-container');
  const noHighlights = document.getElementById('no-highlights');
  const clearAllBtn = document.getElementById('clear-all');
  const viewAllPagesBtn = document.getElementById('view-all-pages');
  const openSettingsBtn = document.getElementById('open-settings');

  const siteHostnameEl = document.getElementById('site-hostname');
  const siteStatusEl = document.getElementById('site-status');
  const siteModeNoteEl = document.getElementById('site-mode-note');
  const siteToggleBtn = document.getElementById('site-toggle-btn');
  const siteFeedbackEl = document.getElementById('site-feedback');
  const siteNoteEl = document.getElementById('site-note');
  const siteRefreshBtn = document.getElementById('site-refresh-btn');

  let currentSiteStatus = null;
  let currentTab = null;

  function showFeedback(text, showRefresh = false) {
    if (siteNoteEl) siteNoteEl.textContent = text;
    if (siteRefreshBtn) {
      siteRefreshBtn.textContent = getMessage('siteRefreshButton');
      siteRefreshBtn.style.display = showRefresh ? 'block' : 'none';
    }
    if (siteFeedbackEl) siteFeedbackEl.style.display = 'block';
  }

  function renderSiteStatus(status, tab) {
    currentSiteStatus = status;
    if (!status) return;

    if (siteFeedbackEl) siteFeedbackEl.style.display = 'none';
    if (siteNoteEl) siteNoteEl.textContent = '';
    if (siteRefreshBtn) siteRefreshBtn.style.display = 'none';

    if (status.supported === false) {
      if (siteHostnameEl) siteHostnameEl.textContent = extractScheme(tab?.url);
      if (siteStatusEl) siteStatusEl.textContent = getMessage('siteStatusUnsupported');
      if (siteModeNoteEl) {
        siteModeNoteEl.textContent = '';
        siteModeNoteEl.style.display = 'none';
      }
      if (siteToggleBtn) siteToggleBtn.style.display = 'none';
      return;
    }

    const hostname = status.hostname || extractHostname(tab?.url);
    if (siteHostnameEl) siteHostnameEl.textContent = hostname;

    if (status.mode === 'all') {
      if (siteStatusEl) siteStatusEl.textContent = getMessage('siteStatusEnabled');
      if (siteModeNoteEl) {
        siteModeNoteEl.textContent = getMessage('siteModeAllNote');
        siteModeNoteEl.style.display = 'block';
      }
      if (siteToggleBtn) siteToggleBtn.style.display = 'none';
      return;
    }

    if (status.mode === 'allowlist') {
      if (siteModeNoteEl) {
        siteModeNoteEl.textContent = getMessage('siteModeAllowlistNote');
        siteModeNoteEl.style.display = 'block';
      }

      // Nothing to add or remove when the page has no hostname to write a rule
      // for: the button would be there and do nothing.
      if (!hostname) {
        if (siteStatusEl) siteStatusEl.textContent = getMessage('siteStatusDisabled');
        if (siteToggleBtn) siteToggleBtn.style.display = 'none';
        return;
      }

      if (!status.allowed) {
        if (siteStatusEl) siteStatusEl.textContent = getMessage('siteStatusDisabled');
        if (siteToggleBtn) {
          siteToggleBtn.className = 'btn btn-primary';
          siteToggleBtn.textContent = getMessage('siteEnableButton');
          siteToggleBtn.style.display = 'block';
        }
      } else {
        if (siteStatusEl) siteStatusEl.textContent = getMessage('siteStatusEnabled');
        if (siteToggleBtn) {
          siteToggleBtn.className = 'btn';
          siteToggleBtn.textContent = getMessage('siteRemoveButton');
          siteToggleBtn.style.display = 'block';
        }
      }
    }
  }

  async function loadSiteStatus() {
    currentTab = await getActiveTab();
    if (!currentTab || !currentTab.url) return;

    const response = await sendToBackground({
      action: 'getSiteStatus',
      url: currentTab.url,
    });

    if (response && response.success && response.status) {
      renderSiteStatus(response.status, currentTab);
    }
  }

  if (siteToggleBtn) {
    siteToggleBtn.addEventListener('click', async () => {
      if (!currentSiteStatus) return;

      if (!currentTab) currentTab = await getActiveTab();
      const hostname = currentSiteStatus.hostname || extractHostname(currentTab?.url);
      if (!hostname) return;

      const isEnabling = currentSiteStatus.mode === 'allowlist' && !currentSiteStatus.allowed;
      siteToggleBtn.disabled = true;

      try {
        const payload = isEnabling
          ? { action: 'addSiteRule', hostname, includeSubdomains: false }
          : { action: 'removeSiteRule', hostname };

        const response = await sendToBackground(payload);

        if (!response || !response.success) {
          showFeedback(getMessage('siteActionFailed'), false);
          return;
        }

        // Background is the single source of truth for evaluated policy; query rather than hand-patching local state.
        const statusResponse = await sendToBackground({
          action: 'getSiteStatus',
          url: currentTab?.url,
        });

        if (statusResponse && statusResponse.success && statusResponse.status) {
          renderSiteStatus(statusResponse.status, currentTab);
        }

        if (isEnabling) {
          if (response.needsRefresh === true) {
            showFeedback(getMessage('siteNeedsRefresh'), true);
          } else {
            showFeedback(getMessage('siteEnabledNote'), false);
          }
        } else {
          showFeedback(getMessage('siteRemovedNote'), false);
        }
      } finally {
        siteToggleBtn.disabled = false;
      }
    });
  }

  if (siteRefreshBtn) {
    siteRefreshBtn.addEventListener('click', async () => {
      siteRefreshBtn.disabled = true;
      if (!currentTab) currentTab = await getActiveTab();
      if (currentTab && currentTab.id) {
        await browserAPI.tabs.reload(currentTab.id);
      }
      // Reload the tab and close so the user lands straight back on the active page.
      window.close();
    });
  }
  // Load highlight information from current active tab
  async function loadHighlights() {
    const tab = await getActiveTab();
    const currentUrl = tab.url;
    if (!currentUrl) return;

    const result = await browserAPI.storage.local.get([currentUrl]);
    let highlights = result[currentUrl] || [];

    // Since it's a group structure, use the position of the representative span
    highlights.sort((a, b) => {
      const posA = a.spans && a.spans[0] ? a.spans[0].position : 0;
      const posB = b.spans && b.spans[0] ? b.spans[0].position : 0;
      return posA - posB;
    });

    debugLog('Loaded highlights for popup (sorted by position):', highlights);

    // Enable/disable clear-all button based on highlight count
    clearAllBtn.disabled = highlights.length === 0;

    // Display highlight list (group basis)
    if (highlights.length > 0) {
      noHighlights.style.display = 'none';
      highlightsContainer.innerHTML = '';

      const renderedItems = new Map();

      highlights.forEach(group => {
        const highlightItem = document.createElement('div');
        highlightItem.className = 'highlight-item';
        highlightItem.dataset.groupId = group.groupId;
        highlightItem.style.setProperty('--highlight-color', group.color);

        // Click (or Enter/Space) jumps to the highlight on the page
        highlightItem.setAttribute('role', 'button');
        highlightItem.tabIndex = 0;
        const jumpLabel = browserAPI.i18n.getMessage('jumpToHighlight');
        if (jumpLabel) {
          highlightItem.title = jumpLabel;
        }
        highlightItem.addEventListener('click', function () {
          if (highlightItem.classList.contains('is-missing')) return;
          jumpToHighlight(group.groupId, tab.id);
        });
        highlightItem.addEventListener('keydown', function (e) {
          if (highlightItem.classList.contains('is-missing')) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            jumpToHighlight(group.groupId, tab.id);
          }
        });

        // Truncate text if too long
        let displayText = group.text;
        if (displayText.length > 80) {
          displayText = displayText.substring(0, 77) + '...';
        }

        const textSpan = document.createElement('div');
        textSpan.className = 'highlight-text';
        textSpan.textContent = displayText;

        // Add delete button
        const deleteBtn = document.createElement('span');
        deleteBtn.className = 'delete-btn';
        const removeLabel = browserAPI.i18n.getMessage('removeHighlight');
        deleteBtn.title = removeLabel;
        deleteBtn.setAttribute('aria-label', removeLabel);

        // An SVG cross rather than the letter 'x': a glyph sits on its
        // baseline, so it reads as low inside the circle whatever the font.
        deleteBtn.innerHTML =
          '<svg class="delete-icon" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">' +
          '<line x1="5" y1="5" x2="11" y2="11" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>' +
          '<line x1="11" y1="5" x2="5" y2="11" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>' +
          '</svg>';
        deleteBtn.addEventListener('click', async function (e) {
          e.stopPropagation();
          const confirmMessage =
            browserAPI.i18n.getMessage('confirmDeleteHighlight') ||
            browserAPI.i18n.getMessage('confirmDeletePage') ||
            'Delete this highlight?';
          const confirmed = await showConfirmModal(confirmMessage);
          if (confirmed) {
            await deleteHighlight(group.groupId, currentUrl);
          }
        });

        highlightItem.appendChild(textSpan);
        highlightItem.appendChild(deleteBtn);
        highlightsContainer.appendChild(highlightItem);
        renderedItems.set(String(group.groupId), highlightItem);
      });

      markMissingHighlights(tab.id, renderedItems);
    } else {
      noHighlights.style.display = 'block';
      highlightsContainer.innerHTML = '';
      highlightsContainer.appendChild(noHighlights);
    }
  }

  // Ask the page which highlights it actually managed to restore, and mark the
  // rest. Without this a missing highlight is a list entry that looks normal and
  // does nothing when clicked.
  async function markMissingHighlights(tabId, renderedItems, waitedMs = 0) {
    const response = await sendMessageToTab(tabId, { action: 'getRestoredGroupIds' });

    if (!response || !response.success) {
      // No content script on this page, or it never answered. Leave the list
      // alone rather than marking every entry as missing.
      debugLog('getRestoredGroupIds gave no answer:', response);
      return;
    }

    // The page has not finished restoring - its initial pass, or the delayed
    // retry. Marking now would dim entries that are about to appear, and
    // nothing takes the mark back. The page says how long to hold off, so ask
    // again until it stops saying so.
    const pendingMs = Number(response.pendingRestoreMs) || 0;
    if (pendingMs > 0) {
      if (waitedMs >= PENDING_RESTORE_POLL_LIMIT_MS) {
        // Out of patience, but the page still says a restore is coming, so what
        // it has told us is "not yet", never "not there". Leave the entries
        // alone: that is the same thing this does when the page does not answer
        // at all, and it errs the safe way - an entry that is really gone still
        // looks normal, instead of a working one being dimmed and made dead.
        debugLog('Restore still pending after', waitedMs, 'ms - leaving entries unmarked');
        return;
      }

      const wait = Math.min(pendingMs, PENDING_RESTORE_POLL_LIMIT_MS - waitedMs);
      setTimeout(() => markMissingHighlights(tabId, renderedItems, waitedMs + wait), wait);
      return;
    }

    const present = new Set((response.groupIds || []).map(String));
    renderedItems.forEach((item, groupId) => {
      // The list may have been re-rendered while this was in flight.
      if (!item.isConnected) return;
      if (!present.has(groupId)) {
        markItemMissing(item, groupId, tabId);
      }
    });
  }

  // Turn an entry into a dead-but-explained state with a way out of it: the
  // retry runs the page's restore for just this group, which recovers the common
  // case where the text arrived after the initial restore had already run.
  function markItemMissing(item, groupId, tabId) {
    const missingLabel =
      browserAPI.i18n.getMessage('highlightMissingOnPage') || 'Not found on this page';

    item.classList.add('is-missing');
    item.removeAttribute('role');
    item.tabIndex = -1;
    item.title = missingLabel;

    const note = document.createElement('div');
    note.className = 'missing-note';

    const noteText = document.createElement('span');
    noteText.textContent = missingLabel;

    const retryBtn = document.createElement('button');
    retryBtn.type = 'button';
    retryBtn.className = 'retry-btn';
    retryBtn.textContent = browserAPI.i18n.getMessage('retryFindHighlight') || 'Find again';

    retryBtn.addEventListener('click', async function (e) {
      e.stopPropagation();
      retryBtn.disabled = true;

      const response = await sendMessageToTab(tabId, {
        action: 'retryRestoreHighlight',
        groupId: groupId
      });

      if (response && response.restored) {
        clearItemMissing(item, note);
        jumpToHighlight(groupId, tabId);
        return;
      }

      debugLog('retryRestoreHighlight did not restore:', response);
      retryBtn.disabled = false;
      noteText.textContent =
        browserAPI.i18n.getMessage('retryFindHighlightFailed') ||
        'Still not found. The page content may have changed.';
    });

    note.appendChild(noteText);
    note.appendChild(retryBtn);
    item.appendChild(note);
  }

  function clearItemMissing(item, note) {
    item.classList.remove('is-missing');
    note.remove();
    item.setAttribute('role', 'button');
    item.tabIndex = 0;
    item.title = browserAPI.i18n.getMessage('jumpToHighlight') || '';
  }

  // Scroll the page to the highlight group and close the popup
  async function jumpToHighlight(groupId, tabId) {
    const response = await sendMessageToTab(tabId, {
      action: 'scrollToHighlight',
      groupId: groupId
    });

    if (!response || !response.success) {
      debugLog('scrollToHighlight failed:', response);
      const message =
        browserAPI.i18n.getMessage('highlightNotFoundOnPage') ||
        'Could not find this highlight on the page.';
      showAlertModal(message);
      return;
    }

    window.close();
  }

  // Delete highlight (group basis)
  async function deleteHighlight(groupId, url) {
    const response = await browserAPI.runtime.sendMessage({
      action: 'deleteHighlight',
      url: url,
      groupId: groupId, // Delete by groupId
      notifyRefresh: true
    });
    if (response && response.success) {
      debugLog('Highlight group deleted through background:', groupId);
      await loadHighlights();
    }
  }

  // Delete all highlights
  clearAllBtn.addEventListener('click', async function () {
    debugLog('Clearing all highlights');
    const confirmMessage = browserAPI.i18n.getMessage('confirmClearAll');
    const confirmed = await showConfirmModal(confirmMessage);
    if (confirmed) {
      const tab = await getActiveTab();
      const currentUrl = tab.url;
      if (!currentUrl) return;
      
      const response = await browserAPI.runtime.sendMessage({
        action: 'clearAllHighlights',
        url: currentUrl,
        notifyRefresh: true
      });
      
      if (response && response.success) {
        debugLog('All highlights cleared through background');
        await loadHighlights();
      }
    }
  });

  // The pages list is an extension page, not a content script, so
  // tabs.sendMessage never reaches it. A runtime message does. With no listener
  // left to answer, the promise rejects, which is no reason to fail the open.
  async function refreshOpenPagesList() {
    try {
      await browserAPI.runtime.sendMessage({ action: 'refreshPagesList' });
    } catch (error) {
      debugLog('No pages list answered the refresh:', error);
    }
  }

  // View list of highlighted pages
  async function openPagesList() {
    debugLog('Opening all pages list');
    const targetUrl = browserAPI.runtime.getURL('pages-list.html');

    // browserAPI.windows is not available on Firefox Android
    if (browserAPI.windows) {
      const windows = await browserAPI.windows.getAll({ populate: true });

      for (const win of windows) {
        const openTab = (win.tabs || []).find(tab => tab.url && tab.url.startsWith(targetUrl));
        if (!openTab) continue;

        browserAPI.windows.update(win.id, { focused: true });
        browserAPI.tabs.update(openTab.id, { active: true });
        await refreshOpenPagesList();
        return;
      }

      const w = 860, h = 600;
      const left = Math.round((window.screen.width - w) / 2);
      const top = Math.round((window.screen.height - h) / 2);
      await browserAPI.windows.create({
        url: targetUrl,
        type: 'popup',
        width: w,
        height: h,
        left,
        top,
      });
      return;
    }

    // Mobile fallback: use tabs API only
    const tabs = await browserAPI.tabs.query({});
    const existingTab = tabs.find(tab => tab.url && tab.url.startsWith(targetUrl));

    if (existingTab) {
      browserAPI.tabs.update(existingTab.id, { active: true });
      await refreshOpenPagesList();
    } else {
      await browserAPI.tabs.create({ url: targetUrl });
    }

    // Close the popup so the user sees the page directly
    window.close();
  }

  viewAllPagesBtn.addEventListener('click', openPagesList);

  openSettingsBtn.addEventListener('click', () => {
    const settingsUrl = browserAPI.runtime.getURL('settings.html');
    if (browserAPI.windows) {
      const w = 440, h = 620;
      const left = Math.round((window.screen.width - w) / 2);
      const top = Math.round((window.screen.height - h) / 2);
      browserAPI.windows.create({
        url: settingsUrl,
        type: 'popup',
        width: w,
        height: h,
        left,
        top,
      });
    } else {
      // Mobile fallback
      browserAPI.tabs.create({ url: settingsUrl });
      window.close();
    }
  });

  // Initialization
  await Promise.all([
    loadHighlights(),
    loadSiteStatus(),
  ]);
});
