/**
 * The backup round trip, in a real Firefox against a real server.
 *
 * The unit suite drives the backup service through a fake `fetch`, which cannot
 * answer the questions this file exists for: does the browser let the extension
 * PUT to a plain-HTTP host, does `downloads.download` accept the safety copy,
 * and does a restore actually put the highlight back on the page. The WebDAV
 * server is the one the harness already serves, so no account or token is
 * needed and nothing leaves the machine.
 *
 * Run before a Firefox release: `npm run test:e2e:firefox` (HEADFUL=1 to watch).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from './harness.js';

const PARAGRAPH = 'This is a sample paragraph with some text that can be highlighted.';

describe('Firefox backup round trip', { concurrency: 1, timeout: 120_000 }, () => {
  let harness;

  before(async () => { harness = await startHarness(); });
  after(async () => { if (harness) await harness.stop(); });

  /** Runs one background action from an extension page, the way the settings page does. */
  async function send(message) {
    return harness.inExtension(function (payload, done) {
      browser.runtime.sendMessage(payload)
        .then(response => done(response), error => done({ success: false, error: String(error && error.message) }));
    }, message);
  }

  const drawnHighlights = function () {
    const spans = [...document.querySelectorAll('span.text-highlighter-extension')];
    if (!spans.length) return null;
    return spans.map(span => ({ text: span.textContent, background: getComputedStyle(span).backgroundColor }));
  };

  it('backs up to WebDAV without leaking the text, then restores it', async () => {
    await harness.openPage('test-page.html');
    assert.ok(await harness.waitForContentScript(), 'the content script never came up in the page');

    await harness.inPage(function () {
      const paragraph = [...document.querySelectorAll('p')]
        .find(el => el.textContent.includes('This is a sample paragraph'));
      const range = document.createRange();
      range.selectNodeContents(paragraph);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    });
    const sent = await harness.sendToPage({ action: 'highlight', color: 'yellow' });
    assert.ok(sent.ok, `the highlight never reached the content script: ${sent.error}`);
    assert.deepEqual(await harness.waitInPage(drawnHighlights), [
      { text: PARAGRAPH, background: 'rgb(255, 255, 0)' },
    ]);

    // A fresh profile has to come up unencrypted: that is the shipped default,
    // and a code that appears before the user asked for one is exactly the
    // friction the mode exists to remove.
    const initial = await send({ action: 'getBackupState' });
    assert.equal(initial.state.encrypt, false, 'a fresh profile did not start unencrypted');
    assert.equal(initial.state.hasRecoveryCode, false, 'a recovery code existed before it was needed');

    const encrypted = await send({ action: 'setBackupEncryption', enabled: true });
    assert.equal(encrypted.success, true, JSON.stringify(encrypted));
    const recoveryCode = encrypted.generatedRecoveryCode;
    assert.ok(recoveryCode, 'no recovery code was minted when encryption was turned on');

    // A destination that is a host on this machine over plain HTTP: the one
    // combination the fake-fetch tests cannot try.
    const configured = await send({ action: 'setBackupDestination', destination: 'webdav' });
    assert.equal(configured.success, true, JSON.stringify(configured));

    const saved = await send({
      action: 'saveWebdavConfig',
      url: harness.davUrl,
      username: 'marks',
      password: 'local-only',
      allowInsecureHttp: true,
    });
    assert.equal(saved.success, true, JSON.stringify(saved));

    const tested = await send({ action: 'testBackupConnection' });
    assert.equal(tested.success, true, JSON.stringify(tested));

    const run = await send({ action: 'runBackupNow' });
    assert.equal(run.result.uploaded, true, JSON.stringify(run));

    assert.ok(harness.dav.body, 'the backup never reached the server');
    assert.ok(!harness.dav.body.includes(PARAGRAPH), 'the server received the highlighted text');
    assert.ok(!harness.dav.body.includes('/test-page.html'), 'the server received a page URL');
    assert.ok(harness.dav.body.includes('marks-local-backup'), 'the payload is not a backup envelope');

    // Wipe what is here, so a successful restore cannot be storage that never
    // went away.
    const cleared = await send({ action: 'deleteAllHighlightedPages' });
    assert.equal(cleared.success, true, JSON.stringify(cleared));
    assert.equal((await send({ action: 'getAllHighlightedPages' })).pages.length, 0);

    const preview = await send({ action: 'previewRemoteBackup' });
    assert.equal(preview.success, true, JSON.stringify(preview));
    assert.equal(preview.encrypted, true, 'the preview did not report the payload as sealed');
    assert.equal(preview.preview.pageCount, 1);
    assert.equal(preview.preview.highlightCount, 1);

    const restored = await send({ action: 'restoreFromRemoteBackup', confirm: true });
    assert.equal(restored.success, true, JSON.stringify(restored));
    assert.equal(restored.summary.restoredPages, 1);
    assert.equal(restored.safetySnapshot.ok, true, JSON.stringify(restored.safetySnapshot));

    const pages = await send({ action: 'getAllHighlightedPages' });
    assert.equal(pages.pages.length, 1, 'the restore put nothing back');

    // The settings card has to show the same state the background holds: the
    // recovery code the user has to write down, and when a backup last landed.
    await harness.inExtension(function (done) {
      browser.tabs.create({ url: browser.runtime.getURL('settings.html') })
        .then(() => done(true), error => done(String(error && error.message)));
    });
    const settings = await harness.findTab(url => url.includes('/settings.html'));
    assert.ok(settings, 'the settings page never opened');
    assert.ok(await harness.waitForPageReady(), 'the settings page never finished loading');

    const shown = await harness.waitUntil(async () => {
      const read = await harness.driver.executeScript(() => ({
        code: document.getElementById('backup-recovery-code-display').textContent.trim(),
        lastSuccess: document.getElementById('backup-status-last-success').textContent.trim(),
      }));
      return read.code ? read : null;
    });
    assert.equal(shown.code, recoveryCode, 'the card does not show the recovery code');
    assert.notEqual(shown.lastSuccess, '', 'the card does not show when the last backup landed');

    await harness.reloadPage();
    assert.deepEqual(
      await harness.waitInPage(drawnHighlights),
      [{ text: PARAGRAPH, background: 'rgb(255, 255, 0)' }],
      'the restored highlight was not drawn after a reload'
    );
  });
  it('backs up through a second WebDAV server that wants credentials and refuses HEAD', async () => {
    // A server that answers 401 without credentials and 501 to HEAD. The
    // providers' unit tests cover both branches against a fake fetch; this is
    // the same pair against a real socket and a real browser fetch.
    const saved = await send({
      action: 'saveWebdavConfig',
      url: harness.secureDavUrl,
      username: 'marks',
      password: 'wrong-password',
      allowInsecureHttp: true,
    });
    assert.equal(saved.success, true, JSON.stringify(saved));

    // Forced: the local data has not changed since the first test's upload, and
    // a run that stays home would prove nothing about the credential.
    const rejected = await send({ action: 'runBackupNow', force: true });
    assert.equal(rejected.result.ok, false, JSON.stringify(rejected.result));
    assert.equal(rejected.result.code, 'backup_auth_failed');
    assert.equal(harness.secureDav.body, null, 'a rejected credential still uploaded something');

    const accepted = await send({ action: 'saveWebdavConfig', password: 'local-only' });
    assert.equal(accepted.success, true, JSON.stringify(accepted));

    const tested = await send({ action: 'testBackupConnection' });
    assert.equal(tested.success, true, JSON.stringify(tested));

    const run = await send({ action: 'runBackupNow', force: true });
    assert.equal(run.result.uploaded, true, JSON.stringify(run));

    assert.ok(harness.secureDav.calls.includes('PUT'), 'the upload never reached the second server');
    assert.ok(harness.secureDav.body.includes('marks-local-backup'), 'the payload is not a backup envelope');
    assert.ok(!harness.secureDav.body.includes(PARAGRAPH), 'the server received the highlighted text');

    const preview = await send({ action: 'previewRemoteBackup' });
    assert.equal(preview.success, true, JSON.stringify(preview));
    assert.ok(preview.preview.pageCount >= 1, 'the second server had nothing to preview');
  });
  it('uploads and restores a plaintext backup with no recovery code at all', async () => {
    await harness.openPage('test-page.html');
    assert.ok(await harness.waitForContentScript(), 'the content script never came up in the page');
    await harness.inPage(function () {
      const paragraph = [...document.querySelectorAll('p')]
        .find(el => el.textContent.includes('This is a sample paragraph'));
      const range = document.createRange();
      range.selectNodeContents(paragraph);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    });
    assert.ok((await harness.sendToPage({ action: 'highlight', color: 'yellow' })).ok);

    const off = await send({ action: 'setBackupEncryption', enabled: false });
    assert.equal(off.success, true, JSON.stringify(off));
    assert.equal(off.state.encrypt, false);
    assert.equal(off.state.hasRecoveryCode, true, 'turning encryption off discarded the code the old backups need');

    const saved = await send({
      action: 'saveWebdavConfig',
      url: harness.secureDavUrl,
      username: 'marks',
      password: 'local-only',
      allowInsecureHttp: true,
    });
    assert.equal(saved.success, true, JSON.stringify(saved));
    assert.equal((await send({ action: 'runBackupNow', force: true })).result.uploaded, true);

    // The whole point of the mode: what lands on the server is readable. This
    // is what the user chose, so the test says so instead of pretending.
    assert.ok(harness.secureDav.body.includes('This is a sample paragraph'),
      'the plaintext mode did not upload readable text');

    const preview = await send({ action: 'previewRemoteBackup' });
    assert.equal(preview.success, true, JSON.stringify(preview));
    assert.equal(preview.encrypted, false, 'the preview called a plaintext backup encrypted');

    const cleared = await send({ action: 'deleteAllHighlightedPages' });
    assert.equal(cleared.success, true, JSON.stringify(cleared));
    assert.equal((await send({ action: 'getAllHighlightedPages' })).pages.length, 0);

    const restored = await send({ action: 'restoreFromRemoteBackup', confirm: true });
    assert.equal(restored.success, true, JSON.stringify(restored));
    assert.equal(restored.encrypted, false);
    assert.equal(restored.summary.restoredPages, 1);

    await harness.reloadPage();
    assert.deepEqual(
      await harness.waitInPage(drawnHighlights),
      [{ text: PARAGRAPH, background: 'rgb(255, 255, 0)' }],
      'the plaintext backup did not come back'
    );
  });

});
