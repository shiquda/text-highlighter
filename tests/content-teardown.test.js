import { jest } from '@jest/globals';
import chrome from '../mocks/chrome.js';
import {
  loadContentScripts,
  respondToBackground,
  respondToStorage,
  resetContentScriptEnvironment,
} from './helpers/content-script.js';

describe('content script teardown on siteDisabled', () => {
  const palette = [
    { id: 'yellow', nameKey: 'yellowColor', color: '#FFFF00' },
    { id: 'green', nameKey: 'greenColor', color: '#AAFFAA' },
  ];

  let page = null;
  let removeMessageListenerMock;
  let removeStorageListenerMock;

  beforeEach(async () => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    resetContentScriptEnvironment();

    delete window.__marksLocalContentBooted;
    delete window.__marksLocalContentReady;
    delete window.__marksLocalContentDisabled;
    delete window.TextHighlighterControls;

    removeMessageListenerMock = jest.fn();
    chrome.runtime.onMessage.removeListener = removeMessageListenerMock;

    removeStorageListenerMock = jest.fn();
    chrome.storage.onChanged.removeListener = removeStorageListenerMock;

    respondToBackground(message => {
      if (message.action === 'getPlatformInfo') return { isMobile: false };
      if (message.action === 'getColors') return { colors: palette };
      if (message.action === 'getHighlights') return { highlights: [] };
      return { success: true };
    });

    respondToStorage({
      minimapVisible: true,
      selectionControlsVisible: true,
      oneClickHighlightEnabled: false,
      lastUsedColor: '#FFFF00',
    });
    window.currentColors = palette.slice();

    document.body.innerHTML = `
      <div id="content">
        <p id="target-text">This is a paragraph that will be used for testing text highlights and teardown.</p>
      </div>
    `;

    // Load scripts in manifest order: common, minimap, controls, content
    page = loadContentScripts(['common', 'minimap', 'controls', 'content']);

    // Advance past initial async round trips (colors + delayed restore)
    await jest.advanceTimersByTimeAsync(600);
  });

  afterEach(() => {
    jest.useRealTimers();
    resetContentScriptEnvironment();
    delete window.__marksLocalContentBooted;
    delete window.__marksLocalContentReady;
    delete window.__marksLocalContentDisabled;
    delete window.TextHighlighterControls;
  });

  it('sets boot and ready flags upon initialization and responds to messages', async () => {
    expect(window.__marksLocalContentBooted).toBe(true);
    expect(window.__marksLocalContentReady).toBe(true);
    expect(window.__marksLocalContentDisabled).toBeUndefined();

    // DOM containers should be created and attached
    expect(document.querySelector('.text-highlighter-controls')).not.toBeNull();
    expect(document.querySelector('.text-highlighter-minimap')).not.toBeNull();
    expect(document.querySelector('.text-highlighter-ui-root')).not.toBeNull();

    // Before teardown, getRestoredGroupIds answers
    const restored = await page.sendToContentScript({ action: 'getRestoredGroupIds' });
    expect(restored).toEqual(expect.objectContaining({ success: true }));
  });

  it('tears down cleanly when siteDisabled message is received', async () => {
    // Select text to verify highlighting works before teardown
    const targetNode = document.getElementById('target-text').firstChild;
    const range = document.createRange();
    range.setStart(targetNode, 0);
    range.setEnd(targetNode, 4); // "This"
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);

    const initialHighlight = await page.sendToContentScript({ action: 'highlight', color: '#FFFF00' });
    expect(initialHighlight).toEqual({ success: true });
    expect(document.querySelectorAll('.text-highlighter-extension').length).toBeGreaterThan(0);

    // Send siteDisabled message
    const disabledResponse = await page.sendToContentScript({ action: 'siteDisabled' });
    expect(disabledResponse).toEqual({ success: true });

    // 1. Verify boot/ready/disabled flags
    expect(window.__marksLocalContentBooted).toBe(true);
    expect(window.__marksLocalContentReady).toBe(false);
    expect(window.__marksLocalContentDisabled).toBe(true);

    // 2. Verify controls and minimap containers are removed from the DOM
    expect(document.querySelector('.text-highlighter-controls')).toBeNull();
    expect(document.querySelector('.text-highlighter-minimap')).toBeNull();
    expect(document.querySelector('.text-highlighter-ui-root')).toBeNull();

    // 3. Verify listeners were unregistered
    expect(removeMessageListenerMock).toHaveBeenCalled();
    expect(removeStorageListenerMock).toHaveBeenCalled();

    // 4. Verify getRestoredGroupIds gets no response
    const postRestored = await page.sendToContentScript({ action: 'getRestoredGroupIds' });
    expect(postRestored).toBeUndefined();

    // 5. Verify that a later highlight message creates no new highlight
    const spanCountBefore = document.querySelectorAll('.text-highlighter-extension').length;
    range.setStart(targetNode, 5);
    range.setEnd(targetNode, 7); // "is"
    selection.removeAllRanges();
    selection.addRange(range);

    const postHighlight = await page.sendToContentScript({ action: 'highlight', color: '#AAFFAA' });
    expect(postHighlight).toBeUndefined();
    expect(document.querySelectorAll('.text-highlighter-extension').length).toBe(spanCountBefore);

    // 6. Verify existing highlight spans remain in place but clicking them does not open controls
    const existingSpan = document.querySelector('.text-highlighter-extension');
    expect(existingSpan).not.toBeNull();
    existingSpan.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(document.querySelector('.text-highlighter-controls')).toBeNull();
  });
});
