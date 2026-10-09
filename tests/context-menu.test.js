import chrome from '../mocks/chrome.js';
import { SITE_MENU_ENABLE, SITE_MENU_REMOVE } from '../background/settings-service.js';
import { initContextMenus } from '../background/context-menu.js';

// A tab always has a URL once the `tabs` permission is declared, and the
// handlers authorise every highlight against it.
const PAGE_URL = 'https://example.com/article';

// Default color values from settings-service (used to verify handler logic)
const DEFAULT_COLORS = {
  yellow: '#FFFF00',
  green:  '#AAFFAA',
  blue:   '#AAAAFF',
  pink:   '#FFAAFF',
  orange: '#FFAA55',
};

describe('context-menu', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    initContextMenus();
  });

  // ===================================================================
  // Listener registration
  // ===================================================================

  describe('initContextMenus — listener registration', () => {
    it('should register exactly one contextMenus.onClicked listener', () => {
      expect(chrome.contextMenus.onClicked.addListener).toHaveBeenCalledTimes(1);
    });

    it('should register exactly one commands.onCommand listener', () => {
      expect(chrome.commands.onCommand.addListener).toHaveBeenCalledTimes(1);
    });

    it('should register exactly one tabs.onActivated listener for shortcut change detection', () => {
      expect(chrome.tabs.onActivated.addListener).toHaveBeenCalledTimes(1);
    });
  });

  // ===================================================================
  // contextMenus.onClicked handler
  // ===================================================================

  describe('contextMenus.onClicked handler', () => {
    function getClickListener() {
      return chrome.contextMenus.onClicked.addListener.mock.calls[0][0];
    }

    it('should send a highlight message to the tab when a color menu item is clicked', async () => {
      const clickListener = getClickListener();
      await clickListener(
        { menuItemId: 'highlight-yellow', selectionText: 'selected text' },
        { id: 42, url: PAGE_URL },
      );

      expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(42, {
        action: 'highlight',
        color: DEFAULT_COLORS.yellow,
        text: 'selected text',
      });
    });

    it('should NOT send a message for the parent "highlight-text" menu item', async () => {
      const clickListener = getClickListener();
      await clickListener({ menuItemId: 'highlight-text', selectionText: 'hello' }, { id: 1, url: PAGE_URL });

      expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
    });

    it('should NOT send a message for an unknown menu item id', async () => {
      const clickListener = getClickListener();
      await clickListener({ menuItemId: 'highlight-unknown-color', selectionText: 'hi' }, { id: 1, url: PAGE_URL });

      expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
    });
  });

  // ===================================================================
  // commands.onCommand handler
  // ===================================================================

  describe('commands.onCommand handler', () => {
    function getCommandListener() {
      return chrome.commands.onCommand.addListener.mock.calls[0][0];
    }

    it.each([
      ['command_slot_1', DEFAULT_COLORS.yellow],
      ['command_slot_2',  DEFAULT_COLORS.green],
      ['command_slot_3',   DEFAULT_COLORS.blue],
      ['command_slot_4',   DEFAULT_COLORS.pink],
      ['command_slot_5', DEFAULT_COLORS.orange],
    ])('should send highlight with correct color for command "%s"', async (command, expectedColor) => {
      chrome.tabs.query.mockResolvedValueOnce([{ id: 99, url: PAGE_URL }]);
      const commandListener = getCommandListener();
      await commandListener(command);

      expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(99, {
        action: 'highlight',
        color: expectedColor,
      });
    });

    it('should do nothing when no active tab is found', async () => {
      chrome.tabs.query.mockResolvedValueOnce([]);
      const commandListener = getCommandListener();
      await commandListener('command_slot_1');

      expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
    });

    it.each([
      ['navigate_next_highlight', 'next'],
      ['navigate_previous_highlight', 'previous'],
    ])('should ask the tab to jump for command "%s"', async (command, direction) => {
      chrome.tabs.query.mockResolvedValueOnce([{ id: 42, url: PAGE_URL }]);
      await getCommandListener()(command);

      expect(chrome.tabs.sendMessage).toHaveBeenCalledTimes(1);
      expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(42, {
        action: 'jumpToAdjacentHighlight',
        direction,
      });
    });

    it('should do nothing for an unknown command name', async () => {
      chrome.tabs.query.mockResolvedValueOnce([{ id: 1 }]);
      const commandListener = getCommandListener();
      await commandListener('unknown_command');

      expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
    });

  });
  // ===================================================================
  // Site rules
  // ===================================================================

  describe('site rules', () => {
    function getClickListener() {
      return chrome.contextMenus.onClicked.addListener.mock.calls[0][0];
    }

    function getCommandListener() {
      return chrome.commands.onCommand.addListener.mock.calls[0][0];
    }

    function useAllowlist(sites) {
      chrome.storage.local.get.mockImplementation(() =>
        Promise.resolve({ sitePolicy: { version: 1, mode: 'allowlist', sites } }));
    }

    it('enables the host of the page from the context menu', async () => {
      useAllowlist([]);

      await getClickListener()({ menuItemId: SITE_MENU_ENABLE }, { id: 7, url: PAGE_URL });

      expect(chrome.storage.local.set).toHaveBeenCalledWith({
        sitePolicy: expect.objectContaining({
          mode: 'allowlist',
          sites: [{ hostname: 'example.com', includeSubdomains: false }],
        }),
      });
    });

    it('removes the matching rule from the context menu, not the subdomain', async () => {
      useAllowlist([{ hostname: 'example.com', includeSubdomains: true }]);

      await getClickListener()({ menuItemId: SITE_MENU_REMOVE }, { id: 7, url: 'https://www.example.com/x' });

      expect(chrome.storage.local.set).toHaveBeenCalledWith({
        sitePolicy: expect.objectContaining({ sites: [] }),
      });
    });

    it('refuses a colour highlight on a site the allowlist does not cover', async () => {
      useAllowlist([]);

      await getClickListener()(
        { menuItemId: 'highlight-yellow', selectionText: 'selected text' },
        { id: 42, url: PAGE_URL },
      );

      expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
    });

    it('refuses a shortcut highlight on a site the allowlist does not cover', async () => {
      useAllowlist([]);
      chrome.tabs.query.mockResolvedValueOnce([{ id: 99, url: PAGE_URL }]);

      await getCommandListener()('command_slot_1');

      expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
    });
  });
});
