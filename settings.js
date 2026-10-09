import { browserAPI } from './shared/browser-api.js';
import { debugLog } from './shared/logger.js';
import { createLocalizedModalHelpers } from './shared/modal.js';
import { sendToBackground } from './shared/runtime-message.js';
import { initializeThemeWatcher } from './shared/theme.js';

function initializeI18n() {
  const elements = document.querySelectorAll('[data-i18n]');
  elements.forEach(element => {
    const key = element.getAttribute('data-i18n');
    const message = browserAPI.i18n.getMessage(key);
    if (message) {
      if (element.tagName === 'INPUT' && element.type === 'button') {
        element.value = message;
      } else if (element.tagName === 'INPUT' && element.placeholder !== undefined) {
        element.placeholder = message;
      } else if (element.tagName === 'TITLE') {
        element.textContent = message;
      } else {
        element.textContent = message;
      }
    }
  });
}

const { showAlertModal, showConfirmModal } = createLocalizedModalHelpers(
  (key, defaultValue) => browserAPI.i18n.getMessage(key) || defaultValue
);

document.addEventListener('DOMContentLoaded', async () => {
  initializeI18n();
  initializeThemeWatcher();

  // --- General Settings ---
  const minimapToggle = document.getElementById('minimap-toggle');
  const selectionControlsToggle = document.getElementById('selection-controls-toggle');
  const selectionControlsRow = document.getElementById('selection-controls-row');
  const oneClickToggle = document.getElementById('one-click-highlight-toggle');
  const oneClickRow = document.getElementById('one-click-highlight-row');

  // One-click highlighting rides on the selection icon, so it can do nothing
  // while the icon is switched off. Mobile has no such switch - the icon is
  // always on there - so the row stays live.
  function syncOneClickAvailability() {
    const available = !browserAPI.windows || selectionControlsToggle.checked;
    oneClickToggle.disabled = !available;
    oneClickRow.classList.toggle('is-disabled', !available);
  }

  async function loadGeneralSettings() {
    const result = await browserAPI.storage.local.get([
      'minimapVisible',
      'selectionControlsVisible',
      'oneClickHighlightEnabled',
    ]);

    const minimapVisible = result.minimapVisible !== undefined ? result.minimapVisible : true;
    minimapToggle.checked = minimapVisible;

    if (!browserAPI.windows) {
      selectionControlsRow.style.display = 'none';
    } else {
      const selectionControlsVisible = result.selectionControlsVisible !== undefined ? result.selectionControlsVisible : true;
      selectionControlsToggle.checked = selectionControlsVisible;
    }

    oneClickToggle.checked = result.oneClickHighlightEnabled === true;
    syncOneClickAvailability();
  }

  minimapToggle.addEventListener('change', async () => {
    await sendToBackground({
      action: 'saveSettings',
      minimapVisible: minimapToggle.checked
    });
  });

  selectionControlsToggle.addEventListener('change', async () => {
    syncOneClickAvailability();
    await sendToBackground({
      action: 'saveSettings',
      selectionControlsVisible: selectionControlsToggle.checked
    });
  });

  oneClickToggle.addEventListener('change', async () => {
    await sendToBackground({
      action: 'saveSettings',
      oneClickHighlightEnabled: oneClickToggle.checked
    });
  });

  // --- Custom Colors ---
  const customColorsList = document.getElementById('custom-colors-list');
  const addCustomColorBtn = document.getElementById('add-custom-color-btn');
  const clearCustomColorsBtn = document.getElementById('clear-custom-colors-btn');
  const colorPicker = document.getElementById('color-picker-hidden');

  let activeColorIdForUpdate = null;

  function buildColorRow(colorObj) {
    const row = document.createElement('div');
    row.className = 'color-row';

    const info = document.createElement('div');
    info.className = 'color-info';

    const swatch = document.createElement('div');
    swatch.className = 'color-swatch';
    swatch.style.backgroundColor = colorObj.color;

    const name = document.createElement('span');
    name.className = 'color-name';
    name.textContent = colorObj.customName || `${browserAPI.i18n.getMessage('customColor') || 'Custom Color'} ${colorObj.colorNumber}`;
    name.title = browserAPI.i18n.getMessage('editNameTooltip') || 'Click to edit name';

    let isEditingName = false;

    name.addEventListener('click', () => {
      if (isEditingName) return;
      isEditingName = true;

      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'color-name-input';
      input.maxLength = 50;
      input.value = name.textContent;

      const finishEditing = async () => {
        if (!isEditingName) return;
        isEditingName = false;

        const newName = input.value.trim();
        if (newName && newName !== (colorObj.customName || `${browserAPI.i18n.getMessage('customColor') || 'Custom Color'} ${colorObj.colorNumber}`)) {
          const response = await browserAPI.runtime.sendMessage({
            action: 'updateCustomColorName',
            id: colorObj.id,
            name: newName
          });

          if (response.success) {
            if (response.exists) {
              await showAlertModal(browserAPI.i18n.getMessage('nameAlreadyExists') || 'Name already exists.');
              name.textContent = colorObj.customName || `${browserAPI.i18n.getMessage('customColor') || 'Custom Color'} ${colorObj.colorNumber}`;
            } else {
              const customColors = response.colors.filter(c => c.id.startsWith('custom_'));
              renderCustomColorsList(customColors);
              await loadShortcuts(); // Refresh names in dropdown
              return; // re-rendering handles putting the span back
            }
          }
        }

        info.replaceChild(name, input);
      };

      input.addEventListener('blur', finishEditing);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          input.blur();
        } else if (e.key === 'Escape') {
          isEditingName = false;
          info.replaceChild(name, input);
        }
      });

      info.replaceChild(input, name);
      input.focus();
      input.select();
    });

    const hex = document.createElement('span');
    hex.className = 'color-hex';
    hex.textContent = colorObj.color.toUpperCase();

    info.appendChild(swatch);
    // When editing, info will contain input instead of name. This append handles the initial render.
    info.appendChild(name);
    info.appendChild(hex);

    const actions = document.createElement('div');
    actions.className = 'color-actions';

    const editBtn = document.createElement('button');
    editBtn.className = 'btn-icon';
    editBtn.textContent = browserAPI.i18n.getMessage('editColor') || 'Edit';
    editBtn.addEventListener('click', () => {
      activeColorIdForUpdate = colorObj.id;
      colorPicker.value = colorObj.color;
      colorPicker.click();
    });

    const removeBtn = document.createElement('button');
    removeBtn.className = 'btn-icon btn-danger';
    removeBtn.textContent = browserAPI.i18n.getMessage('removeColor') || 'Remove';
    removeBtn.addEventListener('click', async () => {
      await handleRemoveColor(colorObj);
    });

    actions.appendChild(editBtn);
    actions.appendChild(removeBtn);

    row.appendChild(info);
    row.appendChild(actions);

    return row;
  }

  function renderCustomColorsList(customColors) {
    customColorsList.innerHTML = '';

    // With one colour its own row's Remove is enough; the bulk button is for
    // the case the rows make tedious.
    clearCustomColorsBtn.hidden = customColors.length < 2;

    if (customColors.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-text';
      empty.textContent = browserAPI.i18n.getMessage('noCustomColors') || 'No custom colors yet.';
      customColorsList.appendChild(empty);
      return;
    }

    customColors.forEach(colorObj => {
      customColorsList.appendChild(buildColorRow(colorObj));
    });
  }

  colorPicker.addEventListener('change', async () => {
    const colorValue = colorPicker.value;

    if (activeColorIdForUpdate) {
      // Update
      const response = await browserAPI.runtime.sendMessage({
        action: 'updateCustomColor',
        id: activeColorIdForUpdate,
        color: colorValue
      });
      activeColorIdForUpdate = null;

      if (response.success) {
        if (response.exists) {
          await showAlertModal(browserAPI.i18n.getMessage('colorAlreadyExists') || 'Color already exists.');
        } else {
          const customColors = response.colors.filter(c => c.id.startsWith('custom_'));
          renderCustomColorsList(customColors);
          await loadShortcuts(); // Refresh names in dropdown
        }
      }
    } else {
      // Add
      const response = await browserAPI.runtime.sendMessage({
        action: 'addColor',
        color: colorValue
      });
      if (response.success) {
        if (response.exists) {
          await showAlertModal(browserAPI.i18n.getMessage('colorAlreadyExists') || 'Color already exists.');
        } else {
          const customColors = response.colors.filter(c => c.id.startsWith('custom_'));
          renderCustomColorsList(customColors);
          await loadShortcuts(); // Refresh options in dropdown
        }
      }
    }
  });

  addCustomColorBtn.addEventListener('click', () => {
    activeColorIdForUpdate = null;
    colorPicker.value = '#ff0000';
    colorPicker.click();
  });

  clearCustomColorsBtn.addEventListener('click', async () => {
    const confirmed = await showConfirmModal(
      browserAPI.i18n.getMessage('confirmDeleteCustomColors') || 'Delete ALL custom colors?'
    );
    if (!confirmed) return;

    // The confirm can sit open long enough for the worker to go back to sleep,
    // and a rejection here would end the click in an unhandled rejection.
    const response = await sendToBackground({ action: 'clearCustomColors' });
    if (response && response.success) {
      renderCustomColorsList((response.colors || []).filter(c => c.id.startsWith('custom_')));
      await loadShortcuts(); // Refresh options and drop any that were assigned
    }
  });

  async function handleRemoveColor(colorObj) {
    const response = await browserAPI.runtime.sendMessage({
      action: 'removeCustomColor',
      id: colorObj.id
    });
    if (response.success) {
      const customColors = response.colors.filter(c => c.id.startsWith('custom_'));
      renderCustomColorsList(customColors);
      await loadShortcuts(); // Refresh options and remove from map if assigned
    }
  }

  async function loadCustomColors() {
    const response = await browserAPI.runtime.sendMessage({ action: 'getColors' });
    if (response && response.colors) {
      const customColors = response.colors.filter(c => c.id.startsWith('custom_'));
      renderCustomColorsList(customColors);
    }
  }

  // --- Keyboard Shortcuts ---
  const shortcutsList = document.getElementById('shortcuts-list');

  function isCustomColor(colorObj) {
    return colorObj.id && colorObj.id.startsWith('custom_');
  }

  function getCustomColorBaseName() {
    return browserAPI.i18n.getMessage('customColor') || 'Custom Color';
  }

  function buildColorLabel(colorObj) {
    if (colorObj.customName) {
      return colorObj.customName;
    }
    if (isCustomColor(colorObj)) {
      const baseName = getCustomColorBaseName();
      return colorObj.colorNumber ? `${baseName} ${colorObj.colorNumber}` : baseName;
    }
    if (colorObj.nameKey) {
      const msg = browserAPI.i18n.getMessage(colorObj.nameKey);
      if (colorObj.colorNumber) {
        return `${msg} ${colorObj.colorNumber}`;
      }
      return msg || colorObj.nameKey;
    }
    return colorObj.color;
  }

  async function renderShortcutsList(commands, colorMap, allColors) {
    shortcutsList.innerHTML = '';

    const SLOT_COMMANDS = [
      'command_slot_1', 'command_slot_2', 'command_slot_3',
      'command_slot_4', 'command_slot_5',
    ];

    const NAVIGATION_COMMANDS = [
      ['navigate_next_highlight', 'commandNextHighlight', 'Jump to next highlight'],
      ['navigate_previous_highlight', 'commandPreviousHighlight', 'Jump to previous highlight'],
    ];

    // Label on top, key combination under it. Chrome gives these commands no
    // default key, so an unassigned badge is the normal first sight there.
    function buildShortcutInfo(cmdName, label) {
      const cmd = commands.find(c => c.name === cmdName);
      const shortcutLabel = cmd?.shortcut || browserAPI.i18n.getMessage('notAssigned') || '(Not assigned)';

      const info = document.createElement('div');
      info.className = 'shortcut-info';

      const slotLabel = document.createElement('span');
      slotLabel.className = 'shortcut-slot';
      slotLabel.textContent = label;

      const keyBadge = document.createElement('span');
      keyBadge.className = 'key-badge';
      keyBadge.textContent = shortcutLabel;

      info.appendChild(slotLabel);
      info.appendChild(keyBadge);
      return info;
    }

    SLOT_COMMANDS.forEach((cmdName, idx) => {
      const assignedColorId = colorMap[cmdName] ?? null;

      const row = document.createElement('div');
      row.className = 'shortcut-row';

      const info = buildShortcutInfo(
        cmdName,
        `${browserAPI.i18n.getMessage('shortcutSlot') || 'Slot'} ${idx + 1}`
      );

      const select = document.createElement('select');
      select.className = 'shortcut-select';

      const noneOption = document.createElement('option');
      noneOption.value = '';
      noneOption.textContent = browserAPI.i18n.getMessage('notAssigned') || '(Not assigned)';
      select.appendChild(noneOption);

      allColors.forEach(color => {
        const option = document.createElement('option');
        option.value = color.id;
        option.textContent = buildColorLabel(color);
        if (color.id === assignedColorId) option.selected = true;
        select.appendChild(option);
      });

      select.addEventListener('change', async () => {
        const newColorId = select.value || null;
        colorMap[cmdName] = newColorId;

        await browserAPI.runtime.sendMessage({
          action: 'saveShortcutColorMap',
          shortcutColorMap: colorMap
        });
      });

      row.appendChild(info);
      row.appendChild(select);
      shortcutsList.appendChild(row);
    });

    NAVIGATION_COMMANDS.forEach(([cmdName, messageKey, fallback]) => {
      const row = document.createElement('div');
      row.className = 'shortcut-row shortcut-row-navigation';
      row.appendChild(buildShortcutInfo(cmdName, browserAPI.i18n.getMessage(messageKey) || fallback));
      shortcutsList.appendChild(row);
    });
  }

  async function loadShortcuts() {
    if (!browserAPI.commands) {
      shortcutsList.innerHTML = '<div class="empty-text">Shortcuts not supported on this platform.</div>';
      return;
    }

    const [commandsResult, colorMapResult, colorsResult] = await Promise.all([
      browserAPI.commands.getAll(),
      browserAPI.runtime.sendMessage({ action: 'getShortcutColorMap' }),
      browserAPI.runtime.sendMessage({ action: 'getColors' })
    ]);

    const colorMap = colorMapResult.success ? colorMapResult.shortcutColorMap : {};
    const allColors = colorsResult.colors || [];

    // Auto-cleanup map if a custom color was removed but still assigned
    let mapChanged = false;
    for (const key in colorMap) {
      if (colorMap[key] && !allColors.find(c => c.id === colorMap[key])) {
        colorMap[key] = null;
        mapChanged = true;
      }
    }
    if (mapChanged) {
      await browserAPI.runtime.sendMessage({
        action: 'saveShortcutColorMap',
        shortcutColorMap: colorMap
      });
    }

    renderShortcutsList(commandsResult, colorMap, allColors);
  }

  // --- Site Rules ---
  const siteRulesModeAll = document.getElementById('site-rules-mode-all');
  const siteRulesModeAllowlist = document.getElementById('site-rules-mode-allowlist');
  const siteRulesModeHelp = document.getElementById('site-rules-mode-help');
  const siteRulesEmptyWarning = document.getElementById('site-rules-empty-warning');
  const siteRulesCount = document.getElementById('site-rules-count');
  const siteRulesAddInput = document.getElementById('site-rules-add-input');
  const siteRulesIncludeSubdomains = document.getElementById('site-rules-include-subdomains');
  const siteRulesAddBtn = document.getElementById('site-rules-add-btn');
  const siteRulesError = document.getElementById('site-rules-error');
  const siteRulesFeedback = document.getElementById('site-rules-feedback');
  const siteRulesSearchInput = document.getElementById('site-rules-search-input');
  const siteRulesList = document.getElementById('site-rules-list');
  const siteRulesEmpty = document.getElementById('site-rules-empty');

  let currentSitePolicy = null;
  let siteRulesFeedbackTimer = null;

  function showSiteRulesFeedback(message) {
    clearTimeout(siteRulesFeedbackTimer);
    siteRulesFeedback.textContent = message;
    siteRulesFeedback.style.display = '';
    siteRulesFeedbackTimer = setTimeout(() => {
      siteRulesFeedback.textContent = '';
      siteRulesFeedback.style.display = 'none';
      siteRulesFeedbackTimer = null;
    }, 2000);
    if (typeof siteRulesFeedbackTimer?.unref === 'function') {
      siteRulesFeedbackTimer.unref();
    }
  }

  function showSiteRulesError(message) {
    siteRulesError.textContent = message;
    siteRulesError.style.display = '';
  }

  function clearSiteRulesError() {
    siteRulesError.textContent = '';
    siteRulesError.style.display = 'none';
  }

  function renderSiteRuleRows() {
    if (!currentSitePolicy) return;
    const query = (siteRulesSearchInput.value || '').trim().toLowerCase();
    const allSites = currentSitePolicy.sites || [];
    const filtered = query
      ? allSites.filter(site => site.hostname.toLowerCase().includes(query))
      : allSites;

    siteRulesList.innerHTML = '';

    if (allSites.length === 0) {
      siteRulesEmpty.textContent = browserAPI.i18n.getMessage('siteRulesNoSites') || 'No sites in the list yet.';
      siteRulesEmpty.style.display = '';
      return;
    }

    if (filtered.length === 0) {
      siteRulesEmpty.textContent = browserAPI.i18n.getMessage('siteRulesNoMatches') || 'No sites match your search.';
      siteRulesEmpty.style.display = '';
      return;
    }

    siteRulesEmpty.style.display = 'none';

    for (const rule of filtered) {
      const row = document.createElement('div');
      row.className = 'site-rule-row';

      const info = document.createElement('div');
      info.className = 'site-rule-info';

      const host = document.createElement('span');
      host.className = 'site-rule-hostname';
      host.textContent = rule.hostname;

      const badge = document.createElement('span');
      badge.className = `site-rule-badge ${rule.includeSubdomains ? 'badge-subdomains' : 'badge-exact'}`;
      badge.textContent = rule.includeSubdomains
        ? (browserAPI.i18n.getMessage('siteSubdomainsBadge') || 'Includes subdomains')
        : (browserAPI.i18n.getMessage('siteExactBadge') || 'Exact hostname');

      info.appendChild(host);
      info.appendChild(badge);

      const actions = document.createElement('div');
      actions.className = 'site-rule-actions';

      const subLabel = document.createElement('label');
      subLabel.className = 'site-rules-checkbox-label';
      const subCheckbox = document.createElement('input');
      subCheckbox.type = 'checkbox';
      subCheckbox.className = 'site-rule-subdomain-toggle';
      subCheckbox.checked = !!rule.includeSubdomains;
      const subText = document.createElement('span');
      subText.textContent = browserAPI.i18n.getMessage('siteRulesIncludeSubdomains') || 'Include subdomains';
      subLabel.appendChild(subCheckbox);
      subLabel.appendChild(subText);

      subCheckbox.addEventListener('change', async () => {
        const response = await sendToBackground({
          action: 'setSiteRuleSubdomains',
          hostname: rule.hostname,
          includeSubdomains: subCheckbox.checked
        });
        if (response && response.success && response.policy) {
          clearSiteRulesError();
          renderSiteRules(response.policy);
          showSiteRulesFeedback(browserAPI.i18n.getMessage('siteRulesSaved') || 'Site rules saved.');
        } else {
          subCheckbox.checked = !subCheckbox.checked;
          showSiteRulesError(browserAPI.i18n.getMessage('siteRulesError') || 'Could not save the site rules.');
        }
      });

      const removeBtn = document.createElement('button');
      removeBtn.className = 'btn-icon btn-danger site-rule-remove-btn';
      removeBtn.textContent = browserAPI.i18n.getMessage('siteRulesRemove') || 'Remove';
      removeBtn.addEventListener('click', async () => {
        const response = await sendToBackground({
          action: 'removeSiteRule',
          hostname: rule.hostname
        });
        if (response && response.success && response.policy) {
          clearSiteRulesError();
          renderSiteRules(response.policy);
          showSiteRulesFeedback(browserAPI.i18n.getMessage('siteRulesSaved') || 'Site rules saved.');
        } else {
          showSiteRulesError(browserAPI.i18n.getMessage('siteRulesError') || 'Could not save the site rules.');
        }
      });

      actions.appendChild(subLabel);
      actions.appendChild(removeBtn);

      row.appendChild(info);
      row.appendChild(actions);
      siteRulesList.appendChild(row);
    }
  }

  function renderSiteRules(policy) {
    currentSitePolicy = policy;

    siteRulesModeAll.checked = (policy.mode !== 'allowlist');
    siteRulesModeAllowlist.checked = (policy.mode === 'allowlist');

    if (policy.mode === 'allowlist') {
      siteRulesModeHelp.textContent = browserAPI.i18n.getMessage('siteRulesModeAllowlistHelp') ||
        'Highlighting runs only on the sites listed below. Pages you are not allowed to highlight keep the highlights you already saved there.';
    } else {
      siteRulesModeHelp.textContent = browserAPI.i18n.getMessage('siteRulesModeAllHelp') ||
        'Highlighting runs on every ordinary http and https page.';
    }

    // An empty allowlist switches highlighting off across all tabs without notice,
    // so the warning is highlighted prominently until the user adds a site.
    const isEmptyAllowlist = (policy.mode === 'allowlist' && (!policy.sites || policy.sites.length === 0));
    siteRulesEmptyWarning.style.display = isEmptyAllowlist ? '' : 'none';

    const count = policy.sites ? policy.sites.length : 0;
    siteRulesCount.textContent = browserAPI.i18n.getMessage('siteRulesCount', [String(count)]) ||
      `${count} site(s) in the list`;

    renderSiteRuleRows();
  }

  async function handleModeChange(mode) {
    const response = await sendToBackground({
      action: 'setSitePolicyMode',
      mode
    });
    if (response && response.success && response.policy) {
      clearSiteRulesError();
      renderSiteRules(response.policy);
      showSiteRulesFeedback(browserAPI.i18n.getMessage('siteRulesSaved') || 'Site rules saved.');
    } else {
      if (currentSitePolicy) {
        siteRulesModeAll.checked = (currentSitePolicy.mode !== 'allowlist');
        siteRulesModeAllowlist.checked = (currentSitePolicy.mode === 'allowlist');
      }
      showSiteRulesError(browserAPI.i18n.getMessage('siteRulesError') || 'Could not save the site rules.');
    }
  }

  siteRulesModeAll.addEventListener('change', () => {
    if (siteRulesModeAll.checked) {
      handleModeChange('all');
    }
  });

  siteRulesModeAllowlist.addEventListener('change', () => {
    if (siteRulesModeAllowlist.checked) {
      handleModeChange('allowlist');
    }
  });

  async function handleAddSiteRule() {
    const rawInput = siteRulesAddInput.value;
    if (!rawInput.trim()) return;
    const includeSubdomains = siteRulesIncludeSubdomains.checked;
    // The background normalises URLs and hostnames centrally, so we pass
    // raw input directly without duplicating normalisation logic here.
    const response = await sendToBackground({
      action: 'addSiteRule',
      hostname: rawInput,
      includeSubdomains
    });
    if (response && response.success && response.policy) {
      siteRulesAddInput.value = '';
      siteRulesIncludeSubdomains.checked = false;
      clearSiteRulesError();
      renderSiteRules(response.policy);
      showSiteRulesFeedback(browserAPI.i18n.getMessage('siteRulesSaved') || 'Site rules saved.');
    } else {
      if (response && response.code === 'site_invalid_hostname') {
        showSiteRulesError(browserAPI.i18n.getMessage('siteRulesInvalidHostname') || 'Enter a website address such as example.org.');
      } else {
        showSiteRulesError(browserAPI.i18n.getMessage('siteRulesError') || 'Could not save the site rules.');
      }
    }
  }

  siteRulesAddBtn.addEventListener('click', handleAddSiteRule);
  siteRulesAddInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAddSiteRule();
    }
  });

  siteRulesSearchInput.addEventListener('input', () => {
    renderSiteRuleRows();
  });

  async function loadSitePolicy() {
    const response = await sendToBackground({ action: 'getSitePolicy' });
    if (response && response.success && response.policy) {
      renderSiteRules(response.policy);
    }
  }

  // --- Backup & Restore ---
  const BACKUP_ERROR_LOCALE_MAP = {
    backup_not_configured: 'backupErrorNotConfigured',
    backup_no_recovery_code: 'backupErrorNoRecoveryCode',
    backup_auth_failed: 'backupErrorAuthFailed',
    backup_forbidden: 'backupErrorForbidden',
    backup_not_found: 'backupErrorNotFound',
    backup_conflict: 'backupErrorConflict',
    backup_directory_missing: 'backupErrorDirectoryMissing',
    backup_too_large: 'backupErrorTooLarge',
    backup_rate_limited: 'backupErrorRateLimited',
    backup_server_error: 'backupErrorServerError',
    backup_network: 'backupErrorNetwork',
    backup_timeout: 'backupErrorTimeout',
    backup_tls: 'backupErrorTls',
    backup_insecure_transport: 'backupErrorInsecureTransport',
    backup_cross_host_redirect: 'backupErrorCrossHostRedirect',
    backup_truncated: 'backupErrorTruncated',
    backup_decrypt_failed: 'backupErrorDecryptFailed',
    backup_invalid_format: 'backupErrorInvalidFormat',
    backup_unsupported_version: 'backupErrorUnsupportedVersion',
    backup_insecure_http_blocked: 'backupErrorInsecureHttpBlocked',
    backup_download_failed: 'backupErrorDownloadFailed',
    backup_safety_snapshot_failed: 'backupErrorSafetySnapshotFailed',
    backup_storage_error: 'backupErrorStorageError',
    backup_confirm_required: 'backupErrorConfirmRequired',
    backup_generic: 'backupErrorGeneric',
  };

  function getBackupErrorMessage(code, fallbackMessage = '') {
    if (!code) return fallbackMessage;
    const localeKey = BACKUP_ERROR_LOCALE_MAP[code];
    if (localeKey) {
      const msg = browserAPI.i18n.getMessage(localeKey);
      if (msg) return msg;
    }
    return fallbackMessage || code;
  }

  async function askConfirm(message) {
    if (typeof window.confirm === 'function') {
      try {
        const result = window.confirm(message);
        if (typeof result === 'boolean') {
          return result;
        }
      } catch {
        // jsdom throws "Not implemented: window.confirm"
      }
    }
    return showConfirmModal(message);
  }

  const backupDestNone = document.getElementById('backup-dest-none');
  const backupDestGist = document.getElementById('backup-dest-gist');
  const backupDestWebdav = document.getElementById('backup-dest-webdav');

  const backupEncryptToggle = document.getElementById('backup-encrypt-toggle');
  const backupEncryptHelp = document.getElementById('backup-encrypt-help');
  const backupPlaintextWarning = document.getElementById('backup-plaintext-warning');
  const backupRecoveryArea = document.getElementById('backup-recovery-area');

  const backupNewCodeBanner = document.getElementById('backup-new-code-banner');
  const backupGeneratedCodeValue = document.getElementById('backup-generated-code-value');
  const backupCopyGeneratedCodeBtn = document.getElementById('backup-copy-generated-code-btn');

  const backupGistConfig = document.getElementById('backup-gist-config');
  const backupGistToken = document.getElementById('backup-gist-token');
  const backupGistId = document.getElementById('backup-gist-id');
  const backupGistFilename = document.getElementById('backup-gist-filename');
  const backupGistSaveBtn = document.getElementById('backup-gist-save-btn');
  const backupGistTestBtn = document.getElementById('backup-gist-test-btn');
  const backupGistError = document.getElementById('backup-gist-error');
  const backupGistFeedback = document.getElementById('backup-gist-feedback');

  const backupWebdavConfig = document.getElementById('backup-webdav-config');
  const backupWebdavUrl = document.getElementById('backup-webdav-url');
  const backupWebdavUsername = document.getElementById('backup-webdav-username');
  const backupWebdavPassword = document.getElementById('backup-webdav-password');
  const backupWebdavInsecureHttp = document.getElementById('backup-webdav-insecure-http');
  const backupWebdavSaveBtn = document.getElementById('backup-webdav-save-btn');
  const backupWebdavTestBtn = document.getElementById('backup-webdav-test-btn');
  const backupWebdavError = document.getElementById('backup-webdav-error');
  const backupWebdavFeedback = document.getElementById('backup-webdav-feedback');

  const backupRecoveryCodeDisplay = document.getElementById('backup-recovery-code-display');
  const backupCopyRecoveryCodeBtn = document.getElementById('backup-copy-recovery-code-btn');
  const backupRegenerateCodeBtn = document.getElementById('backup-regenerate-code-btn');
  const backupCustomRecoveryCodeInput = document.getElementById('backup-custom-recovery-code-input');
  const backupSaveRecoveryCodeBtn = document.getElementById('backup-save-recovery-code-btn');
  const backupRecoveryError = document.getElementById('backup-recovery-error');
  const backupRecoveryFeedback = document.getElementById('backup-recovery-feedback');

  const backupAutoToggle = document.getElementById('backup-auto-toggle');

  const backupNowBtn = document.getElementById('backup-now-btn');
  const backupRestoreBtn = document.getElementById('backup-restore-btn');
  const backupExportLocalBtn = document.getElementById('backup-export-local-btn');
  const backupActionError = document.getElementById('backup-action-error');
  const backupActionFeedback = document.getElementById('backup-action-feedback');

  const backupStatusLastSuccess = document.getElementById('backup-status-last-success');
  const backupStatusUpToDate = document.getElementById('backup-status-up-to-date');
  const backupStatusLastError = document.getElementById('backup-status-last-error');

  const backupFeedbackTimers = new Map();
  function showTemporaryFeedback(element, text, durationMs = 3000) {
    if (!element) return;
    if (backupFeedbackTimers.has(element)) {
      clearTimeout(backupFeedbackTimers.get(element));
    }
    element.textContent = text;
    element.style.display = '';
    const timer = setTimeout(() => {
      element.textContent = '';
      element.style.display = 'none';
      backupFeedbackTimers.delete(element);
    }, durationMs);
    if (typeof timer?.unref === 'function') timer.unref();
    backupFeedbackTimers.set(element, timer);
  }

  function showError(element, text) {
    if (!element) return;
    element.textContent = text;
    element.style.display = text ? '' : 'none';
  }

  function clearError(element) {
    if (!element) return;
    element.textContent = '';
    element.style.display = 'none';
  }

  let currentBackupState = null;

  function renderBackupState(state) {
    if (!state) return;
    currentBackupState = state;

    const dest = state.destination || 'none';
    backupDestNone.checked = (dest === 'none');
    backupDestGist.checked = (dest === 'gist');
    backupDestWebdav.checked = (dest === 'webdav');

    backupGistConfig.style.display = (dest === 'gist') ? '' : 'none';
    backupWebdavConfig.style.display = (dest === 'webdav') ? '' : 'none';

    if (state.gist) {
      if (state.gist.hasToken) {
        backupGistToken.placeholder = browserAPI.i18n.getMessage('backupTokenSavedPlaceholder') || '•••••••• (saved)';
      } else {
        backupGistToken.placeholder = browserAPI.i18n.getMessage('backupGistTokenPlaceholder') || 'ghp_...';
      }
      backupGistId.value = state.gist.gistId || '';
      backupGistFilename.value = state.gist.filename || '';
    }

    if (state.webdav) {
      backupWebdavUrl.value = state.webdav.url || '';
      backupWebdavUsername.value = state.webdav.username || '';
      if (state.webdav.hasPassword) {
        backupWebdavPassword.placeholder = browserAPI.i18n.getMessage('backupPasswordSavedPlaceholder') || '•••••••• (saved)';
      } else {
        backupWebdavPassword.placeholder = browserAPI.i18n.getMessage('backupWebdavPasswordPlaceholder') || 'Password';
      }
      backupWebdavInsecureHttp.checked = state.webdav.allowInsecureHttp === true;
    }

    // The recovery code only exists to open an encrypted backup, so it is not
    // on screen while encryption is off - a code the user is told to guard but
    // never needs is how the one that matters gets ignored.
    const encrypting = state.encrypt === true;
    backupEncryptToggle.checked = encrypting;
    backupRecoveryArea.style.display = encrypting ? '' : 'none';
    if (!encrypting) backupNewCodeBanner.style.display = 'none';
    backupEncryptHelp.textContent = browserAPI.i18n.getMessage(
      encrypting ? 'backupEncryptHelpOn' : 'backupEncryptHelpOff'
    ) || backupEncryptHelp.textContent;
    backupPlaintextWarning.style.display = encrypting ? 'none' : '';

    backupRecoveryCodeDisplay.textContent = state.recoveryCode || '';
    backupAutoToggle.checked = state.autoEnabled === true;

    if (state.lastSuccessAt) {
      const formattedDate = new Date(state.lastSuccessAt).toLocaleString();
      backupStatusLastSuccess.textContent = browserAPI.i18n.getMessage('backupLastSuccessLabel', [formattedDate]) ||
        `Last backup: ${formattedDate}`;
    } else {
      const neverText = browserAPI.i18n.getMessage('backupNeverRun') || 'Never';
      backupStatusLastSuccess.textContent = browserAPI.i18n.getMessage('backupLastSuccessLabel', [neverText]) ||
        `Last backup: ${neverText}`;
    }

    if (state.upToDate) {
      backupStatusUpToDate.textContent = browserAPI.i18n.getMessage('backupStatusUpToDate') || 'Up to date';
      backupStatusUpToDate.className = 'site-rule-badge badge-subdomains';
    } else {
      backupStatusUpToDate.textContent = browserAPI.i18n.getMessage('backupStatusPending') || 'Changes pending';
      backupStatusUpToDate.className = 'site-rule-badge';
    }

    if (state.lastError) {
      const errorMsg = getBackupErrorMessage(state.lastError.code, state.lastError.message);
      backupStatusLastError.textContent = errorMsg;
      backupStatusLastError.style.display = '';
    } else {
      backupStatusLastError.textContent = '';
      backupStatusLastError.style.display = 'none';
    }
  }

  async function handleDestinationChange(dest) {
    clearError(backupActionError);
    const response = await sendToBackground({
      action: 'setBackupDestination',
      destination: dest
    });

    if (response && response.success) {
      if (response.state) {
        renderBackupState(response.state);
      }
    } else {
      if (currentBackupState) {
        const prev = currentBackupState.destination || 'none';
        backupDestNone.checked = (prev === 'none');
        backupDestGist.checked = (prev === 'gist');
        backupDestWebdav.checked = (prev === 'webdav');
      }
      showError(backupActionError, getBackupErrorMessage(response?.code, response?.error));
    }
  }

  backupDestNone.addEventListener('change', () => {
    if (backupDestNone.checked) handleDestinationChange('none');
  });
  backupDestGist.addEventListener('change', () => {
    if (backupDestGist.checked) handleDestinationChange('gist');
  });
  backupDestWebdav.addEventListener('change', () => {
    if (backupDestWebdav.checked) handleDestinationChange('webdav');
  });

  backupCopyGeneratedCodeBtn.addEventListener('click', async () => {
    const code = backupGeneratedCodeValue.textContent;
    if (!code) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(code);
      }
    } catch {}
    showTemporaryFeedback(backupCopyGeneratedCodeBtn, browserAPI.i18n.getMessage('backupRecoveryCodeCopied') || 'Copied!');
  });

  backupCopyRecoveryCodeBtn.addEventListener('click', async () => {
    const code = backupRecoveryCodeDisplay.textContent;
    if (!code) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(code);
      }
    } catch {}
    showTemporaryFeedback(backupRecoveryFeedback, browserAPI.i18n.getMessage('backupRecoveryCodeCopied') || 'Recovery code copied to clipboard.');
  });

  backupGistSaveBtn.addEventListener('click', async () => {
    clearError(backupGistError);
    const payload = {
      action: 'saveGistConfig',
      gistId: backupGistId.value.trim(),
      filename: backupGistFilename.value.trim()
    };
    const typedToken = backupGistToken.value.trim();
    if (typedToken) {
      payload.token = typedToken;
    }
    const response = await sendToBackground(payload);
    if (response && response.success) {
      backupGistToken.value = '';
      if (response.state) renderBackupState(response.state);
      showTemporaryFeedback(backupGistFeedback, browserAPI.i18n.getMessage('backupConfigSaved') || 'Backup settings saved.');
    } else {
      showError(backupGistError, getBackupErrorMessage(response?.code, response?.error));
    }
  });

  backupGistTestBtn.addEventListener('click', async () => {
    clearError(backupGistError);
    const response = await sendToBackground({ action: 'testBackupConnection' });
    if (response && response.success) {
      if (response.state) renderBackupState(response.state);
      showTemporaryFeedback(backupGistFeedback, browserAPI.i18n.getMessage('backupTestSuccess') || 'Connection test succeeded.');
    } else {
      showError(backupGistError, getBackupErrorMessage(response?.code, response?.error));
    }
  });

  backupWebdavSaveBtn.addEventListener('click', async () => {
    clearError(backupWebdavError);
    const payload = {
      action: 'saveWebdavConfig',
      url: backupWebdavUrl.value.trim(),
      username: backupWebdavUsername.value.trim(),
      allowInsecureHttp: backupWebdavInsecureHttp.checked
    };
    if (backupWebdavPassword.value) {
      payload.password = backupWebdavPassword.value;
    }
    const response = await sendToBackground(payload);
    if (response && response.success) {
      backupWebdavPassword.value = '';
      if (response.state) renderBackupState(response.state);
      showTemporaryFeedback(backupWebdavFeedback, browserAPI.i18n.getMessage('backupConfigSaved') || 'Backup settings saved.');
    } else {
      showError(backupWebdavError, getBackupErrorMessage(response?.code, response?.error));
    }
  });

  backupWebdavTestBtn.addEventListener('click', async () => {
    clearError(backupWebdavError);
    const response = await sendToBackground({ action: 'testBackupConnection' });
    if (response && response.success) {
      if (response.state) renderBackupState(response.state);
      showTemporaryFeedback(backupWebdavFeedback, browserAPI.i18n.getMessage('backupTestSuccess') || 'Connection test succeeded.');
    } else {
      showError(backupWebdavError, getBackupErrorMessage(response?.code, response?.error));
    }
  });

  backupRegenerateCodeBtn.addEventListener('click', async () => {
    clearError(backupRecoveryError);
    const confirmMessage = browserAPI.i18n.getMessage('backupConfirmRegenerateCode') ||
      'Generating a new recovery code means older backups encrypted with the previous code can no longer be opened. Are you sure you want to proceed?';
    const confirmed = await askConfirm(confirmMessage);
    if (!confirmed) return;

    const response = await sendToBackground({ action: 'generateBackupRecoveryCode' });
    if (response && response.success) {
      if (response.state) renderBackupState(response.state);
      showTemporaryFeedback(backupRecoveryFeedback, browserAPI.i18n.getMessage('backupCodeRegenerated') || 'New recovery code generated.');
    } else {
      showError(backupRecoveryError, getBackupErrorMessage(response?.code, response?.error));
    }
  });

  backupSaveRecoveryCodeBtn.addEventListener('click', async () => {
    clearError(backupRecoveryError);
    const code = backupCustomRecoveryCodeInput.value.trim();
    if (!code) return;
    const response = await sendToBackground({
      action: 'saveBackupRecoveryCode',
      code
    });
    if (response && response.success) {
      backupCustomRecoveryCodeInput.value = '';
      if (response.state) renderBackupState(response.state);
      showTemporaryFeedback(backupRecoveryFeedback, browserAPI.i18n.getMessage('backupCustomCodeSaved') || 'Recovery code saved.');
    } else {
      showError(backupRecoveryError, getBackupErrorMessage(response?.code, response?.error));
    }
  });

  backupEncryptToggle.addEventListener('change', async () => {
    clearError(backupActionError);
    const response = await sendToBackground({
      action: 'setBackupEncryption',
      enabled: backupEncryptToggle.checked
    });

    if (!response || !response.success) {
      backupEncryptToggle.checked = !backupEncryptToggle.checked;
      showError(backupActionError, getBackupErrorMessage(response?.code, response?.error));
      return;
    }

    if (response.generatedRecoveryCode) {
      backupGeneratedCodeValue.textContent = response.generatedRecoveryCode;
      backupNewCodeBanner.style.display = '';
    }
    if (response.state) renderBackupState(response.state);
  });

  backupAutoToggle.addEventListener('change', async () => {
    const response = await sendToBackground({
      action: 'setBackupAutoEnabled',
      enabled: backupAutoToggle.checked
    });
    if (response && response.success && response.state) {
      renderBackupState(response.state);
    }
  });

  backupNowBtn.addEventListener('click', async () => {
    clearError(backupActionError);
    const response = await sendToBackground({ action: 'runBackupNow' });
    if (response && response.success) {
      if (response.state) renderBackupState(response.state);
      if (response.result && response.result.uploaded === false) {
        showTemporaryFeedback(backupActionFeedback, browserAPI.i18n.getMessage('backupNothingChanged') || 'Nothing has changed');
      } else {
        showTemporaryFeedback(backupActionFeedback, browserAPI.i18n.getMessage('backupSuccess') || 'Backup completed successfully.');
      }
    } else {
      const errCode = response?.code || response?.result?.code;
      const errMsg = response?.error || response?.result?.message;
      showError(backupActionError, getBackupErrorMessage(errCode, errMsg));
    }
  });

  backupRestoreBtn.addEventListener('click', async () => {
    clearError(backupActionError);
    const previewRes = await sendToBackground({ action: 'previewRemoteBackup' });
    if (!previewRes || !previewRes.success) {
      showError(backupActionError, getBackupErrorMessage(previewRes?.code, previewRes?.error));
      return;
    }

    const preview = previewRes.preview || {};
    const confirmMessage = browserAPI.i18n.getMessage('backupRestoreConfirm', [
      String(preview.pageCount ?? 0),
      String(preview.highlightCount ?? 0),
      String(preview.siteCount ?? 0)
    ]) || `Remote backup contains ${preview.pageCount ?? 0} pages, ${preview.highlightCount ?? 0} highlights, and ${preview.siteCount ?? 0} site rules. Restore this backup and replace your local data?`;

    // The remote can hold either shape, and the mode this device is set to says
    // nothing about what was actually uploaded. Say which one this is before
    // anything is replaced.
    const confirmText = previewRes.encrypted === false
      ? `${browserAPI.i18n.getMessage('backupRestorePlaintextWarning') || 'This backup was uploaded unencrypted.'}\n\n${confirmMessage}`
      : confirmMessage;

    const confirmed = await askConfirm(confirmText);
    if (!confirmed) return;

    let restoreRes = await sendToBackground({
      action: 'restoreFromRemoteBackup',
      confirm: true
    });

    if (!restoreRes || !restoreRes.success) {
      if (restoreRes && restoreRes.code === 'backup_safety_snapshot_failed') {
        const secondConfirmMessage = browserAPI.i18n.getMessage('backupSafetySnapshotFailedConfirm') ||
          'Could not create a safety snapshot before restoring. Continue restoring anyway?';
        const secondConfirmed = await askConfirm(secondConfirmMessage);
        if (!secondConfirmed) return;

        restoreRes = await sendToBackground({
          action: 'restoreFromRemoteBackup',
          confirm: true,
          acceptMissingSnapshot: true
        });
      }
    }

    if (restoreRes && restoreRes.success) {
      if (restoreRes.state) renderBackupState(restoreRes.state);
      await Promise.all([
        loadSitePolicy(),
        loadCustomColors()
      ]);
      const filename = restoreRes.safetySnapshot?.filename;
      if (filename) {
        showTemporaryFeedback(
          backupActionFeedback,
          browserAPI.i18n.getMessage('backupRestoreSuccessWithSnapshot', [filename]) || `Backup restored successfully. Safety snapshot saved to ${filename}.`
        );
      } else {
        showTemporaryFeedback(
          backupActionFeedback,
          browserAPI.i18n.getMessage('backupRestoreSuccess') || 'Backup restored successfully.'
        );
      }
    } else {
      showError(backupActionError, getBackupErrorMessage(restoreRes?.code, restoreRes?.error));
    }
  });

  backupExportLocalBtn.addEventListener('click', async () => {
    clearError(backupActionError);
    const response = await sendToBackground({ action: 'exportLocalBackup' });
    if (response && response.success) {
      if (response.state) renderBackupState(response.state);
      const filename = response.filename || '';
      showTemporaryFeedback(
        backupActionFeedback,
        browserAPI.i18n.getMessage('backupExportSuccess', [filename]) || `Local backup exported to ${filename}.`
      );
    } else {
      showError(backupActionError, getBackupErrorMessage(response?.code, response?.error));
    }
  });

  async function loadBackupState() {
    const response = await sendToBackground({ action: 'getBackupState' });
    if (response && response.success && response.state) {
      renderBackupState(response.state);
    }
  }

  // --- Init ---
  if (!browserAPI.commands) {
    document.getElementById('shortcuts-section').style.display = 'none';
  }

  await Promise.all([
    loadGeneralSettings(),
    loadCustomColors(),
    loadShortcuts(),
    loadSitePolicy(),
    loadBackupState()
  ]);

  window.addEventListener('focus', async () => {
    await Promise.all([
      loadCustomColors(),
      loadShortcuts(),
      loadSitePolicy(),
      loadBackupState()
    ]);
  });
});
