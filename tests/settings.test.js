import { jest } from '@jest/globals';
import chrome from '../mocks/chrome.js';
import {
  loadPageScript,
  readPageBody,
  stubPageEnvironment,
} from './helpers/extension-page.js';

const SETTINGS_BODY = readPageBody(new URL('../settings.html', import.meta.url));

const BUILT_IN_COLOR = { id: 'yellow', color: '#ffd54f', nameKey: 'colorYellow' };
const CUSTOM_COLOR = { id: 'custom_1', color: '#ff8a80', colorNumber: 1 };
const NAMED_CUSTOM_COLOR = { id: 'custom_2', color: '#82b1ff', colorNumber: 2, customName: 'Ocean' };

const ALL_COLORS = [BUILT_IN_COLOR, CUSTOM_COLOR, NAMED_CUSTOM_COLOR];

const DEFAULT_BACKUP_STATE = {
  destination: 'none',
  autoEnabled: false,
  hasRecoveryCode: false,
  recoveryCode: null,
  configured: false,
  upToDate: true,
  lastSuccessAt: null,
  lastError: null,
  gist: { hasToken: false, gistId: '', filename: 'marks-backup.json' },
  webdav: { url: '', username: '', hasPassword: false, allowInsecureHttp: false },
};


describe('settings', () => {
  let openSettings;
  const activeTimers = new Set();
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;

  beforeAll(async () => {
    stubPageEnvironment();
    globalThis.setTimeout = (fn, delay, ...args) => {
      const id = realSetTimeout(() => {
        activeTimers.delete(id);
        fn(...args);
      }, delay);
      activeTimers.add(id);
      return id;
    };
    globalThis.clearTimeout = (id) => {
      activeTimers.delete(id);
      realClearTimeout(id);
    };
    openSettings = await loadPageScript(() => import('../settings.js'));
  });

  afterAll(() => {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    document.body.innerHTML = SETTINGS_BODY;

    chrome.i18n.getMessage.mockImplementation(key => key);
    chrome.storage.local.get.mockResolvedValue({});
    chrome.commands.getAll.mockResolvedValue([]);
    respondToBackground({});
  });

  afterEach(() => {
    for (const id of activeTimers) {
      realClearTimeout(id);
    }
    activeTimers.clear();
  });

  /**
   * Answer the page's background messages. `overrides` maps an action to its
   * response; anything not named gets a bare success.
   */
  function respondToBackground(overrides) {
    const defaults = {
      getColors: { success: true, colors: ALL_COLORS },
      getShortcutColorMap: { success: true, shortcutColorMap: {} },
      getSitePolicy: { success: true, policy: { version: 1, mode: 'all', sites: [] } },
      getBackupState: { success: true, state: DEFAULT_BACKUP_STATE },
    };
    const responses = { ...defaults, ...overrides };

    chrome.runtime.sendMessage.mockImplementation(message =>
      Promise.resolve(responses[message.action] ?? { success: true })
    );
  }

  // The page fans its loads out through Promise.all, and its click handlers are
  // async, so assertions need the microtask queue drained first.
  function flush() {
    return new Promise(resolve => setTimeout(resolve, 0));
  }

  function backgroundMessages(action) {
    return chrome.runtime.sendMessage.mock.calls
      .map(([message]) => message)
      .filter(message => message.action === action);
  }

  function lastMessage(action) {
    return backgroundMessages(action).at(-1);
  }

  async function confirmModal(accept) {
    await flush();
    const button = document.querySelector(accept ? '.modal-confirm' : '.modal-cancel');
    expect(button).not.toBeNull();
    button.click();
    await flush();
  }

  function alertText() {
    return document.querySelector('.modal-content p')?.textContent ?? null;
  }

  function colorRows() {
    return [...document.querySelectorAll('#custom-colors-list .color-row')];
  }

  function colorNames() {
    return colorRows().map(row => row.querySelector('.color-name').textContent);
  }

  function shortcutRows() {
    return [...document.querySelectorAll('#shortcuts-list .shortcut-row')];
  }

  function byId(id) {
    return document.getElementById(id);
  }

  function siteRows() {
    return [...document.querySelectorAll('#site-rules-list .site-rule-row')];
  }

  function siteHostnames() {
    return siteRows().map(row => row.querySelector('.site-rule-hostname').textContent);
  }

  // ===================================================================
  // General settings
  // ===================================================================

  describe('general settings', () => {
    it('defaults the minimap to on when nothing is stored', async () => {
      await openSettings();

      expect(byId('minimap-toggle').checked).toBe(true);
    });

    it('reflects a stored minimap preference of off', async () => {
      chrome.storage.local.get.mockResolvedValue({ minimapVisible: false });
      await openSettings();

      expect(byId('minimap-toggle').checked).toBe(false);
    });

    it('saves the minimap preference when it is toggled', async () => {
      await openSettings();

      const toggle = byId('minimap-toggle');
      toggle.checked = false;
      toggle.dispatchEvent(new Event('change'));
      await flush();

      expect(lastMessage('saveSettings')).toEqual({
        action: 'saveSettings',
        minimapVisible: false,
      });
    });

    it('saves the selection-controls preference when it is toggled', async () => {
      await openSettings();

      const toggle = byId('selection-controls-toggle');
      toggle.checked = false;
      toggle.dispatchEvent(new Event('change'));
      await flush();

      expect(lastMessage('saveSettings')).toEqual({
        action: 'saveSettings',
        selectionControlsVisible: false,
      });
    });


    // One-click highlighting is opt-in: an existing user's icon keeps opening
    // the palette until they ask for something else.
    it('leaves one-click highlighting off when nothing has been stored', async () => {
      await openSettings();

      expect(byId('one-click-highlight-toggle').checked).toBe(false);
    });

    it('restores the stored one-click preference', async () => {
      chrome.storage.local.get.mockResolvedValue({ oneClickHighlightEnabled: true });
      await openSettings();

      expect(byId('one-click-highlight-toggle').checked).toBe(true);
    });

    it('saves the one-click preference when it is toggled', async () => {
      await openSettings();

      const toggle = byId('one-click-highlight-toggle');
      toggle.checked = true;
      toggle.dispatchEvent(new Event('change'));
      await flush();

      expect(lastMessage('saveSettings')).toEqual({
        action: 'saveSettings',
        oneClickHighlightEnabled: true,
      });
    });

    // The switch changes what pressing the selection icon does, which a short
    // label cannot say on its own. The explanation sits behind a help tip -
    // beside the label, never inside it: the i18n pass overwrites the
    // textContent of every [data-i18n] element, children and all.
    it('explains the one-click behaviour through a help tip beside the label', async () => {
      await openSettings();

      const label = byId('one-click-highlight-row').querySelector('label[for="one-click-highlight-toggle"]');
      const bubble = byId('one-click-highlight-help');

      expect(label.textContent).toBe('oneClickHighlight');
      expect(bubble.textContent).toBe('oneClickHighlightHelp');
      expect(label.contains(bubble)).toBe(false);
      expect(bubble.closest('.help-tip').getAttribute('tabindex')).toBe('0');
    });

    // Without the selection icon there is nothing for a one-click press to
    // happen on, so the row says so rather than accepting a dead setting.
    it('disables the one-click row while the selection icon is turned off', async () => {
      chrome.storage.local.get.mockResolvedValue({ selectionControlsVisible: false });
      await openSettings();

      expect(byId('one-click-highlight-toggle').disabled).toBe(true);
      expect(byId('one-click-highlight-row').classList.contains('is-disabled')).toBe(true);

      const selectionControls = byId('selection-controls-toggle');
      selectionControls.checked = true;
      selectionControls.dispatchEvent(new Event('change'));
      await flush();

      expect(byId('one-click-highlight-toggle').disabled).toBe(false);
      expect(byId('one-click-highlight-row').classList.contains('is-disabled')).toBe(false);
    });
    it('hides the selection-controls row where windows is unavailable', async () => {
      await withoutBrowserApi('windows', async () => {
        await openSettings();

        expect(byId('selection-controls-row').style.display).toBe('none');
      });
    });
  });

  /**
   * Run `body` with one extension API missing, the way Firefox for Android
   * presents it. `browserAPI` is the mock object itself, so the property has to
   * come off and go back on.
   */
  async function withoutBrowserApi(name, body) {
    const saved = chrome[name];
    delete chrome[name];
    try {
      await body();
    } finally {
      chrome[name] = saved;
    }
  }

  // ===================================================================
  // Custom colors
  // ===================================================================

  describe('custom colors', () => {
    it('lists the custom colors and leaves the built-in ones out', async () => {
      await openSettings();

      expect(colorRows()).toHaveLength(2);
      expect(colorRows().map(row => row.querySelector('.color-hex').textContent))
        .toEqual(['#FF8A80', '#82B1FF']);
    });

    it('names an unnamed custom color by its number', async () => {
      await openSettings();

      expect(colorNames()).toEqual(['customColor 1', 'Ocean']);
    });

    it('says so when there are no custom colors', async () => {
      respondToBackground({ getColors: { success: true, colors: [BUILT_IN_COLOR] } });
      await openSettings();

      expect(colorRows()).toHaveLength(0);
      expect(byId('custom-colors-list').querySelector('.empty-text').textContent)
        .toBe('noCustomColors');
    });

    it('adds the picked color and re-renders the list', async () => {
      await openSettings();
      const added = { id: 'custom_3', color: '#00e676', colorNumber: 3 };
      respondToBackground({ addColor: { success: true, colors: [...ALL_COLORS, added] } });

      const picker = byId('color-picker-hidden');
      picker.value = '#00e676';
      picker.dispatchEvent(new Event('change'));
      await flush();

      expect(lastMessage('addColor')).toEqual({ action: 'addColor', color: '#00e676' });
      expect(colorRows()).toHaveLength(3);
    });

    it('warns instead of adding when the color is already there', async () => {
      await openSettings();
      respondToBackground({ addColor: { success: true, exists: true } });

      const picker = byId('color-picker-hidden');
      picker.value = '#ff8a80';
      picker.dispatchEvent(new Event('change'));
      await flush();

      expect(alertText()).toBe('colorAlreadyExists');
      expect(colorRows()).toHaveLength(2);
    });

    it('updates the color the edit button selected, not a new one', async () => {
      await openSettings();
      respondToBackground({ updateCustomColor: { success: true, colors: ALL_COLORS } });

      colorRows()[0].querySelectorAll('.btn-icon')[0].click();
      const picker = byId('color-picker-hidden');
      picker.value = '#111111';
      picker.dispatchEvent(new Event('change'));
      await flush();

      expect(lastMessage('updateCustomColor')).toEqual({
        action: 'updateCustomColor',
        id: CUSTOM_COLOR.id,
        color: '#111111',
      });
      expect(backgroundMessages('addColor')).toHaveLength(0);
    });

    it('removes a color and re-renders without it', async () => {
      await openSettings();
      respondToBackground({
        removeCustomColor: { success: true, colors: [BUILT_IN_COLOR, NAMED_CUSTOM_COLOR] },
      });

      colorRows()[0].querySelectorAll('.btn-icon')[1].click();
      await flush();

      expect(lastMessage('removeCustomColor')).toEqual({
        action: 'removeCustomColor',
        id: CUSTOM_COLOR.id,
      });
      expect(colorNames()).toEqual(['Ocean']);
    });

    it('offers the bulk delete only once a second color makes the rows tedious', async () => {
      respondToBackground({ getColors: { success: true, colors: [BUILT_IN_COLOR] } });
      await openSettings();
      expect(byId('clear-custom-colors-btn').hidden).toBe(true);

      respondToBackground({ getColors: { success: true, colors: [BUILT_IN_COLOR, CUSTOM_COLOR] } });
      await openSettings();
      expect(byId('clear-custom-colors-btn').hidden).toBe(true);

      respondToBackground({});
      await openSettings();
      expect(byId('clear-custom-colors-btn').hidden).toBe(false);
    });

    it('leaves the colors alone when the bulk delete is cancelled', async () => {
      await openSettings();

      byId('clear-custom-colors-btn').click();
      await confirmModal(false);

      expect(backgroundMessages('clearCustomColors')).toHaveLength(0);
      expect(colorNames()).toEqual(['customColor 1', 'Ocean']);
    });

    it('clears every custom color once the bulk delete is confirmed', async () => {
      await openSettings();
      respondToBackground({
        clearCustomColors: { success: true, colors: [BUILT_IN_COLOR] },
        getColors: { success: true, colors: [BUILT_IN_COLOR] },
      });

      byId('clear-custom-colors-btn').click();
      await confirmModal(true);

      expect(lastMessage('clearCustomColors')).toEqual({ action: 'clearCustomColors' });
      expect(colorRows()).toHaveLength(0);
      expect(byId('clear-custom-colors-btn').hidden).toBe(true);
    });

    // Committing the edit blurs the input, which hands focus back to the window
    // and runs the page's refresh-on-focus reload. So `getColors` has to agree
    // with the rename the way the real background would, or the reload renders
    // the list back to the old name.
    it('renames a color when the inline edit is committed', async () => {
      await openSettings();
      const renamed = { ...CUSTOM_COLOR, customName: 'Coral' };
      const afterRename = { success: true, colors: [BUILT_IN_COLOR, renamed, NAMED_CUSTOM_COLOR] };
      respondToBackground({
        updateCustomColorName: afterRename,
        getColors: afterRename,
      });

      colorRows()[0].querySelector('.color-name').click();
      const input = document.querySelector('.color-name-input');
      input.value = 'Coral';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      await flush();

      expect(lastMessage('updateCustomColorName')).toEqual({
        action: 'updateCustomColorName',
        id: CUSTOM_COLOR.id,
        name: 'Coral',
      });
      expect(colorNames()).toEqual(['Coral', 'Ocean']);
    });

    it('abandons the rename on Escape without asking the background', async () => {
      await openSettings();

      colorRows()[0].querySelector('.color-name').click();
      const input = document.querySelector('.color-name-input');
      input.value = 'Discarded';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      await flush();

      expect(backgroundMessages('updateCustomColorName')).toHaveLength(0);
      expect(colorNames()).toEqual(['customColor 1', 'Ocean']);
    });

    it('warns and restores the old name when the new one is taken', async () => {
      await openSettings();
      respondToBackground({ updateCustomColorName: { success: true, exists: true } });

      colorRows()[0].querySelector('.color-name').click();
      const input = document.querySelector('.color-name-input');
      input.value = 'Ocean';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      await flush();

      expect(alertText()).toBe('nameAlreadyExists');
      expect(colorNames()).toEqual(['customColor 1', 'Ocean']);
    });
  });

  // ===================================================================
  // Keyboard shortcuts
  // ===================================================================

  describe('keyboard shortcuts', () => {
    it('renders a row per shortcut slot, then the two navigation shortcuts', async () => {
      await openSettings();

      expect(shortcutRows()).toHaveLength(7);
      expect(shortcutRows().filter(row => row.querySelector('select'))).toHaveLength(5);
    });

    it('lists the navigation shortcuts with their keys and no color to choose', async () => {
      chrome.commands.getAll.mockResolvedValue([
        { name: 'navigate_next_highlight', shortcut: 'Ctrl+Shift+Down' },
        { name: 'navigate_previous_highlight', shortcut: '' },
      ]);
      await openSettings();

      const rows = [...document.querySelectorAll('#shortcuts-list .shortcut-row-navigation')];
      expect(rows.map(row => row.querySelector('.shortcut-slot').textContent))
        .toEqual(['commandNextHighlight', 'commandPreviousHighlight']);
      expect(rows.map(row => row.querySelector('.key-badge').textContent))
        .toEqual(['Ctrl+Shift+Down', 'notAssigned']);
      expect(rows.some(row => row.querySelector('select'))).toBe(false);
    });

    it('shows the assigned key, and says so when there is none', async () => {
      chrome.commands.getAll.mockResolvedValue([
        { name: 'command_slot_1', shortcut: 'Alt+1' },
        { name: 'command_slot_2', shortcut: '' },
      ]);
      await openSettings();

      const badges = shortcutRows().map(row => row.querySelector('.key-badge').textContent);
      expect(badges[0]).toBe('Alt+1');
      expect(badges[1]).toBe('notAssigned');
    });

    it('offers every color, plus an unassigned option', async () => {
      await openSettings();

      const options = [...shortcutRows()[0].querySelectorAll('option')];
      expect(options.map(option => option.value))
        .toEqual(['', BUILT_IN_COLOR.id, CUSTOM_COLOR.id, NAMED_CUSTOM_COLOR.id]);
      expect(options.map(option => option.textContent))
        .toEqual(['notAssigned', 'colorYellow', 'customColor 1', 'Ocean']);
    });

    it('preselects the color already mapped to a slot', async () => {
      respondToBackground({
        getShortcutColorMap: { success: true, shortcutColorMap: { command_slot_2: NAMED_CUSTOM_COLOR.id } },
      });
      await openSettings();

      expect(shortcutRows()[1].querySelector('select').value).toBe(NAMED_CUSTOM_COLOR.id);
    });

    it('saves the map when a slot is pointed at another color', async () => {
      await openSettings();

      const select = shortcutRows()[0].querySelector('select');
      select.value = CUSTOM_COLOR.id;
      select.dispatchEvent(new Event('change'));
      await flush();

      expect(lastMessage('saveShortcutColorMap').shortcutColorMap)
        .toMatchObject({ command_slot_1: CUSTOM_COLOR.id });
    });

    it('clears a slot pointed at a color that no longer exists', async () => {
      respondToBackground({
        getShortcutColorMap: { success: true, shortcutColorMap: { command_slot_1: 'custom_gone' } },
      });
      await openSettings();

      expect(lastMessage('saveShortcutColorMap').shortcutColorMap)
        .toMatchObject({ command_slot_1: null });
      expect(shortcutRows()[0].querySelector('select').value).toBe('');
    });

    it('hides the section where commands is unavailable', async () => {
      await withoutBrowserApi('commands', async () => {
        await openSettings();

        expect(byId('shortcuts-section').style.display).toBe('none');
        expect(shortcutRows()).toHaveLength(0);
      });
    });
  });

  // ===================================================================
  // Site rules
  // ===================================================================

  describe('site rules', () => {
    function policy(overrides = {}) {
      return {
        success: true,
        policy: {
          version: 1,
          mode: 'all',
          sites: [],
          ...overrides,
        },
      };
    }

    it('renders the all-websites mode by default and hides the empty allowlist warning', async () => {
      respondToBackground({ getSitePolicy: policy({ mode: 'all', sites: [] }) });
      await openSettings();

      expect(byId('site-rules-mode-all').checked).toBe(true);
      expect(byId('site-rules-mode-allowlist').checked).toBe(false);
      expect(byId('site-rules-empty-warning').style.display).toBe('none');
      expect(byId('site-rules-empty').style.display).toBe('');
      expect(byId('site-rules-empty').textContent).toBe('siteRulesNoSites');
    });

    it('shows the empty allowlist warning only when mode is allowlist and the list is empty', async () => {
      respondToBackground({ getSitePolicy: policy({ mode: 'allowlist', sites: [] }) });
      await openSettings();

      expect(byId('site-rules-mode-allowlist').checked).toBe(true);
      expect(byId('site-rules-empty-warning').style.display).toBe('');

      // When allowlist has sites, warning must be hidden
      respondToBackground({
        getSitePolicy: policy({
          mode: 'allowlist',
          sites: [{ hostname: 'arxiv.org', includeSubdomains: true }],
        }),
      });
      await openSettings();
      expect(byId('site-rules-empty-warning').style.display).toBe('none');
    });

    it('sends setSitePolicyMode when changing the mode radio and updates the warning', async () => {
      respondToBackground({
        getSitePolicy: policy({ mode: 'all', sites: [] }),
        setSitePolicyMode: policy({ mode: 'allowlist', sites: [] }),
      });
      await openSettings();

      expect(byId('site-rules-empty-warning').style.display).toBe('none');

      const allowlistRadio = byId('site-rules-mode-allowlist');
      allowlistRadio.checked = true;
      allowlistRadio.dispatchEvent(new Event('change'));
      await flush();

      expect(lastMessage('setSitePolicyMode')).toEqual({
        action: 'setSitePolicyMode',
        mode: 'allowlist',
      });
      expect(byId('site-rules-empty-warning').style.display).toBe('');
    });

    it('sends the raw input to addSiteRule and clears the field on success', async () => {
      respondToBackground({
        getSitePolicy: policy({ mode: 'all', sites: [] }),
        addSiteRule: policy({
          mode: 'all',
          sites: [{ hostname: 'arxiv.org', includeSubdomains: true }],
        }),
      });
      await openSettings();

      const rawUrl = 'https://arxiv.org/abs/1234.5678';
      byId('site-rules-add-input').value = rawUrl;
      byId('site-rules-include-subdomains').checked = true;
      byId('site-rules-add-btn').click();
      await flush();

      expect(lastMessage('addSiteRule')).toEqual({
        action: 'addSiteRule',
        hostname: rawUrl,
        includeSubdomains: true,
      });
      expect(byId('site-rules-add-input').value).toBe('');
      expect(siteHostnames()).toEqual(['arxiv.org']);
      expect(siteRows()[0].querySelector('.site-rule-badge').textContent).toBe('siteSubdomainsBadge');
    });

    it('shows siteRulesInvalidHostname and keeps typed input when adding fails', async () => {
      respondToBackground({
        getSitePolicy: policy({ mode: 'all', sites: [] }),
        addSiteRule: { success: false, code: 'site_invalid_hostname' },
      });
      await openSettings();

      const badInput = 'not a valid url!';
      byId('site-rules-add-input').value = badInput;
      byId('site-rules-add-btn').click();
      await flush();

      expect(lastMessage('addSiteRule')).toEqual({
        action: 'addSiteRule',
        hostname: badInput,
        includeSubdomains: false,
      });
      expect(byId('site-rules-error').style.display).not.toBe('none');
      expect(byId('site-rules-error').textContent).toBe('siteRulesInvalidHostname');
      expect(byId('site-rules-add-input').value).toBe(badInput);
    });

    it('filters rows client-side via the search box and displays no-matches when empty', async () => {
      respondToBackground({
        getSitePolicy: policy({
          mode: 'all',
          sites: [
            { hostname: 'arxiv.org', includeSubdomains: true },
            { hostname: 'github.com', includeSubdomains: false },
            { hostname: 'wikipedia.org', includeSubdomains: true },
          ],
        }),
      });
      await openSettings();

      expect(siteHostnames()).toEqual(['arxiv.org', 'github.com', 'wikipedia.org']);

      const searchInput = byId('site-rules-search-input');
      searchInput.value = 'hub';
      searchInput.dispatchEvent(new Event('input'));
      await flush();

      expect(siteHostnames()).toEqual(['github.com']);
      expect(byId('site-rules-empty').style.display).toBe('none');

      searchInput.value = 'nonexistent';
      searchInput.dispatchEvent(new Event('input'));
      await flush();

      expect(siteHostnames()).toHaveLength(0);
      expect(byId('site-rules-empty').style.display).toBe('');
      expect(byId('site-rules-empty').textContent).toBe('siteRulesNoMatches');

      searchInput.value = '';
      searchInput.dispatchEvent(new Event('input'));
      await flush();

      expect(siteHostnames()).toEqual(['arxiv.org', 'github.com', 'wikipedia.org']);
    });

    it('sends removeSiteRule on remove button click and re-renders from policy', async () => {
      respondToBackground({
        getSitePolicy: policy({
          mode: 'all',
          sites: [{ hostname: 'arxiv.org', includeSubdomains: false }],
        }),
        removeSiteRule: policy({
          mode: 'all',
          sites: [],
        }),
      });
      await openSettings();

      expect(siteHostnames()).toEqual(['arxiv.org']);

      const removeBtn = siteRows()[0].querySelector('.site-rule-remove-btn');
      removeBtn.click();
      await flush();

      expect(lastMessage('removeSiteRule')).toEqual({
        action: 'removeSiteRule',
        hostname: 'arxiv.org',
      });
      expect(siteHostnames()).toHaveLength(0);
      expect(byId('site-rules-empty').style.display).toBe('');
      expect(byId('site-rules-empty').textContent).toBe('siteRulesNoSites');
    });

    it('sends setSiteRuleSubdomains when toggling the subdomain checkbox', async () => {
      respondToBackground({
        getSitePolicy: policy({
          mode: 'all',
          sites: [{ hostname: 'arxiv.org', includeSubdomains: false }],
        }),
        setSiteRuleSubdomains: policy({
          mode: 'all',
          sites: [{ hostname: 'arxiv.org', includeSubdomains: true }],
        }),
      });
      await openSettings();

      expect(siteRows()[0].querySelector('.site-rule-badge').textContent).toBe('siteExactBadge');

      const checkbox = siteRows()[0].querySelector('.site-rule-subdomain-toggle');
      expect(checkbox.checked).toBe(false);

      checkbox.checked = true;
      checkbox.dispatchEvent(new Event('change'));
      await flush();

      expect(lastMessage('setSiteRuleSubdomains')).toEqual({
        action: 'setSiteRuleSubdomains',
        hostname: 'arxiv.org',
        includeSubdomains: true,
      });
      expect(siteRows()[0].querySelector('.site-rule-badge').textContent).toBe('siteSubdomainsBadge');
    });
  });

  // ===================================================================
  // Backup & Restore
  // ===================================================================
  describe('backup', () => {
    it('sends setBackupDestination when destination radio is changed', async () => {
      respondToBackground({
        setBackupDestination: {
          success: true,
          state: { ...DEFAULT_BACKUP_STATE, destination: 'gist' },
        },
      });
      await openSettings();

      const gistRadio = byId('backup-dest-gist');
      gistRadio.checked = true;
      gistRadio.dispatchEvent(new Event('change'));
      await flush();

      expect(lastMessage('setBackupDestination')).toEqual({
        action: 'setBackupDestination',
        destination: 'gist',
      });
      expect(byId('backup-gist-config').style.display).not.toBe('none');
    });

    it('shows the first generatedRecoveryCode prominently', async () => {
      respondToBackground({
        setBackupDestination: {
          success: true,
          state: {
            ...DEFAULT_BACKUP_STATE,
            destination: 'gist',
            hasRecoveryCode: true,
            recoveryCode: 'fresh-code-xyz',
          },
          generatedRecoveryCode: 'fresh-code-xyz',
        },
      });
      await openSettings();

      const gistRadio = byId('backup-dest-gist');
      gistRadio.checked = true;
      gistRadio.dispatchEvent(new Event('change'));
      await flush();

      expect(byId('backup-new-code-banner').style.display).not.toBe('none');
      expect(byId('backup-generated-code-value').textContent).toBe('fresh-code-xyz');
      expect(byId('backup-recovery-code-display').textContent).toBe('fresh-code-xyz');
    });

    it('sends setBackupAutoEnabled when auto toggle is toggled', async () => {
      respondToBackground({
        setBackupAutoEnabled: {
          success: true,
          state: { ...DEFAULT_BACKUP_STATE, autoEnabled: true },
        },
      });
      await openSettings();

      const toggle = byId('backup-auto-toggle');
      expect(toggle.checked).toBe(false);

      toggle.checked = true;
      toggle.dispatchEvent(new Event('change'));
      await flush();

      expect(lastMessage('setBackupAutoEnabled')).toEqual({
        action: 'setBackupAutoEnabled',
        enabled: true,
      });
    });

    it('reports the unchanged case differently from the uploaded case on back up now', async () => {
      respondToBackground({
        runBackupNow: {
          success: true,
          state: DEFAULT_BACKUP_STATE,
          result: { ok: true, uploaded: false },
        },
      });
      await openSettings();

      byId('backup-now-btn').click();
      await flush();

      const unchangedFeedback = byId('backup-action-feedback').textContent;
      expect(unchangedFeedback).not.toBe('');

      respondToBackground({
        runBackupNow: {
          success: true,
          state: DEFAULT_BACKUP_STATE,
          result: { ok: true, uploaded: true },
        },
      });

      byId('backup-now-btn').click();
      await flush();

      const uploadedFeedback = byId('backup-action-feedback').textContent;
      expect(uploadedFeedback).not.toBe('');
      expect(uploadedFeedback).not.toEqual(unchangedFeedback);
    });

    it('asks for confirmation before restoreFromRemoteBackup is sent with confirm:true', async () => {
      respondToBackground({
        previewRemoteBackup: {
          success: true,
          preview: {
            exportedAt: 12345678,
            pageCount: 3,
            highlightCount: 15,
            siteCount: 2,
            mode: 'all',
          },
        },
        restoreFromRemoteBackup: {
          success: true,
          summary: {},
          safetySnapshot: { ok: true, filename: 'safety.json' },
          state: DEFAULT_BACKUP_STATE,
        },
      });
      await openSettings();

      // Case 1: Cancel confirmation
      const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValueOnce(false);
      byId('backup-restore-btn').click();
      await flush();

      expect(lastMessage('previewRemoteBackup')).toEqual({ action: 'previewRemoteBackup' });
      expect(confirmSpy).toHaveBeenCalledTimes(1);
      expect(confirmSpy).toHaveBeenCalledWith('backupRestoreConfirm');
      expect(chrome.i18n.getMessage).toHaveBeenCalledWith('backupRestoreConfirm', ['3', '15', '2']);
      expect(backgroundMessages('restoreFromRemoteBackup')).toHaveLength(0);

      // Case 2: Accept confirmation
      confirmSpy.mockReturnValueOnce(true);
      byId('backup-restore-btn').click();
      await flush();

      expect(confirmSpy).toHaveBeenCalledTimes(2);
      expect(lastMessage('restoreFromRemoteBackup')).toEqual({
        action: 'restoreFromRemoteBackup',
        confirm: true,
      });

      confirmSpy.mockRestore();
    });

    it('asks a second time on backup_safety_snapshot_failed and only then sends acceptMissingSnapshot:true', async () => {
      respondToBackground({
        previewRemoteBackup: {
          success: true,
          preview: { pageCount: 1, highlightCount: 2, siteCount: 1 },
        },
        restoreFromRemoteBackup: {
          success: false,
          code: 'backup_safety_snapshot_failed',
          error: 'Snapshot error',
        },
      });
      await openSettings();

      // First run: User accepts first confirmation, but rejects the second prompt
      const confirmSpy = jest.spyOn(window, 'confirm')
        .mockReturnValueOnce(true)   // first prompt (restore confirm)
        .mockReturnValueOnce(false); // second prompt (missing snapshot confirm)

      byId('backup-restore-btn').click();
      await flush();

      expect(confirmSpy).toHaveBeenCalledTimes(2);
      expect(backgroundMessages('restoreFromRemoteBackup')).toHaveLength(1);
      expect(lastMessage('restoreFromRemoteBackup')).toEqual({
        action: 'restoreFromRemoteBackup',
        confirm: true,
      });

      // Second run: User accepts first prompt and accepts second prompt
      chrome.runtime.sendMessage.mockImplementation(message => {
        if (message.action === 'restoreFromRemoteBackup') {
          if (!message.acceptMissingSnapshot) {
            return Promise.resolve({
              success: false,
              code: 'backup_safety_snapshot_failed',
              error: 'Snapshot error',
            });
          }
          return Promise.resolve({
            success: true,
            summary: {},
            safetySnapshot: { ok: true, filename: 'safety-final.json' },
            state: DEFAULT_BACKUP_STATE,
          });
        }
        return Promise.resolve({
          success: true,
          preview: { pageCount: 1, highlightCount: 2, siteCount: 1 },
        });
      });

      confirmSpy
        .mockReturnValueOnce(true)  // first prompt
        .mockReturnValueOnce(true); // second prompt

      byId('backup-restore-btn').click();
      await flush();

      expect(confirmSpy).toHaveBeenCalledTimes(4);
      expect(lastMessage('restoreFromRemoteBackup')).toEqual({
        action: 'restoreFromRemoteBackup',
        confirm: true,
        acceptMissingSnapshot: true,
      });
      expect(chrome.i18n.getMessage).toHaveBeenCalledWith('backupRestoreSuccessWithSnapshot', ['safety-final.json']);
      expect(byId('backup-action-feedback').textContent).toBe('backupRestoreSuccessWithSnapshot');
      confirmSpy.mockRestore();
    });

    it('renders the last error in the status line', async () => {
      respondToBackground({
        getBackupState: {
          success: true,
          state: {
            ...DEFAULT_BACKUP_STATE,
            lastError: {
              code: 'backup_network',
              message: 'Failed to connect',
              at: 12345678,
            },
          },
        },
      });
      await openSettings();

      const lastErrorEl = byId('backup-status-last-error');
      expect(lastErrorEl.style.display).not.toBe('none');
      expect(lastErrorEl.textContent).toBe('backupErrorNetwork');
    });

    it('saves gist config without token when token input is empty', async () => {
      respondToBackground({
        getBackupState: {
          success: true,
          state: {
            ...DEFAULT_BACKUP_STATE,
            destination: 'gist',
            gist: { hasToken: true, gistId: 'g123', filename: 'marks.json' },
          },
        },
        saveGistConfig: { success: true, state: DEFAULT_BACKUP_STATE },
      });
      await openSettings();

      expect(byId('backup-gist-token').placeholder).toBe('backupTokenSavedPlaceholder');
      byId('backup-gist-id').value = 'g999';
      byId('backup-gist-save-btn').click();
      await flush();

      expect(lastMessage('saveGistConfig')).toEqual({
        action: 'saveGistConfig',
        gistId: 'g999',
        filename: 'marks.json',
      });
    });

    it('saves webdav config sending password only when entered', async () => {
      respondToBackground({
        getBackupState: {
          success: true,
          state: {
            ...DEFAULT_BACKUP_STATE,
            destination: 'webdav',
            webdav: { url: 'https://dav.test', username: 'alice', hasPassword: true, allowInsecureHttp: false },
          },
        },
        saveWebdavConfig: { success: true, state: DEFAULT_BACKUP_STATE },
      });
      await openSettings();

      expect(byId('backup-webdav-password').placeholder).toBe('backupPasswordSavedPlaceholder');
      byId('backup-webdav-password').value = 'secret123';
      byId('backup-webdav-save-btn').click();
      await flush();

      expect(lastMessage('saveWebdavConfig')).toEqual({
        action: 'saveWebdavConfig',
        url: 'https://dav.test',
        username: 'alice',
        password: 'secret123',
        allowInsecureHttp: false,
      });
    });

    it('tests backup connection and shows success feedback', async () => {
      respondToBackground({
        getBackupState: {
          success: true,
          state: { ...DEFAULT_BACKUP_STATE, destination: 'gist' },
        },
        testBackupConnection: { success: true, state: DEFAULT_BACKUP_STATE },
      });
      await openSettings();

      byId('backup-gist-test-btn').click();
      await flush();

      expect(lastMessage('testBackupConnection')).toEqual({ action: 'testBackupConnection' });
      expect(byId('backup-gist-feedback').textContent).toBe('backupTestSuccess');
    });

    it('exports local backup and reports the filename', async () => {
      respondToBackground({
        exportLocalBackup: {
          success: true,
          filename: 'marks-export-2026.json',
          encrypted: true,
          state: DEFAULT_BACKUP_STATE,
        },
      });
      await openSettings();

      byId('backup-export-local-btn').click();
      await flush();

      expect(lastMessage('exportLocalBackup')).toEqual({ action: 'exportLocalBackup' });
      expect(chrome.i18n.getMessage).toHaveBeenCalledWith('backupExportSuccess', ['marks-export-2026.json']);
      expect(byId('backup-action-feedback').textContent).toBe('backupExportSuccess');
    });
  });

  // ===================================================================
  // Refresh on focus
  // ===================================================================

  // Every test in this file opens the page again, and each open leaves another
  // focus listener on the shared window - so the absolute counts here are the
  // number of opens so far, not one. The shape of a single reload still shows in
  // their ratio: one colour map and one policy per listener, and two colour
  // reads, since the shortcut list fetches them again for its dropdowns.
  it('reloads colors, shortcuts and site policy when the window regains focus', async () => {
    await openSettings();
    jest.clearAllMocks();
    respondToBackground({});

    window.dispatchEvent(new Event('focus'));
    await flush();

    const reloads = backgroundMessages('getShortcutColorMap').length;
    expect(reloads).toBeGreaterThan(0);
    expect(backgroundMessages('getSitePolicy')).toHaveLength(reloads);
    expect(backgroundMessages('getColors')).toHaveLength(reloads * 2);
  });
});
