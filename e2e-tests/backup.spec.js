import path from 'path';
import { fileURLToPath } from 'url';
import { test, expect } from './fixtures';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The unit suite drives the backup service through a fake `fetch` and a fake
// `downloads`. This is the only place the real Chromium APIs are involved, and
// it is here for one specific difference between the browsers: Firefox refuses
// a `data:` URL in `downloads.download` outright and needs a blob URL instead,
// so the export is what exercises the other branch.
test.describe('Backup', () => {
  // The messages come from the settings page rather than from the service
  // worker: Chrome does not deliver a runtime message to the sender's own
  // context, so the worker cannot talk to itself.
  test('exports a plain backup until encryption is turned on, then a sealed one', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/settings.html`);

    const state = await page.evaluate(() => chrome.runtime.sendMessage({ action: 'getBackupState' }));
    expect(state.success).toBe(true);
    expect(state.state).toMatchObject({
      destination: 'none',
      encrypt: false,
      hasRecoveryCode: false,
      configured: false,
    });

    const configured = await page.evaluate(
      () => chrome.runtime.sendMessage({ action: 'setBackupDestination', destination: 'webdav' })
    );
    expect(configured.success).toBe(true);
    expect(configured.generatedRecoveryCode).toBeNull();

    // The default: no code exists, and the download is the snapshot itself.
    const plain = await page.evaluate(() => chrome.runtime.sendMessage({ action: 'exportLocalBackup' }));
    expect(plain.success).toBe(true);
    expect(plain.encrypted).toBe(false);
    expect(plain.filename).toMatch(/^marks-local-backup-.*\.json$/);
    expect(plain.filename).not.toContain('.enc.');

    const on = await page.evaluate(
      () => chrome.runtime.sendMessage({ action: 'setBackupEncryption', enabled: true })
    );
    expect(on.success).toBe(true);
    expect(typeof on.generatedRecoveryCode).toBe('string');

    const sealed = await page.evaluate(() => chrome.runtime.sendMessage({ action: 'exportLocalBackup' }));
    expect(sealed.success).toBe(true);
    expect(sealed.encrypted).toBe(true);
    expect(sealed.filename).toMatch(/^marks-local-backup-.*\.enc\.json$/);
  });

  test('refuses the backup state to a page', async ({ context, background }) => {
    const page = await context.newPage();
    await page.goto(`file:///${path.join(__dirname, 'test-page.html')}`);

    // The sender of a message from injected code carries the page's own URL,
    // which is exactly what the gate keys on.
    const results = await background.evaluate(async () => {
      const tabs = await chrome.tabs.query({});
      const target = tabs.find(tab => (tab.url || '').endsWith('/test-page.html'));
      if (!target) return [{ result: { error: 'the page under test is not visible to the extension' } }];
      return chrome.scripting.executeScript({
        target: { tabId: target.id },
        func: () => chrome.runtime.sendMessage({ action: 'getBackupState' }),
      });
    });

    expect(results[0].result.code).toBe('backup_forbidden');
  });
});
