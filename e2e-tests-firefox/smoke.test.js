/**
 * Six checks: does the Firefox build come up, does a highlight survive a
 * reload, do the extension's own pages open, does the settings page drive the
 * site rules, does the site allowlist really decide whether a page gets a
 * content script, and is the recovery code kept away from pages. Anything that is the same code
 * on both browsers - anchoring, selection maths, colour handling - is covered
 * by `tests/` and `e2e-tests/`; running it again here would cost a Firefox
 * launch and tell us nothing new.
 *
 * The allowlist check is here rather than in the unit suite because the thing
 * under test is the browser's own content-script registration reacting to it.
 *
 * Run before a Firefox release: `npm run test:e2e:firefox` (HEADFUL=1 to watch).
 */
import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { By } from 'selenium-webdriver';
import { startHarness } from './harness.js';

describe('Firefox smoke', { concurrency: 1, timeout: 120_000 }, () => {
  let harness;

  before(async () => { harness = await startHarness(); });
  after(async () => { if (harness) await harness.stop(); });
  afterEach(async () => { if (harness) await harness.closeExtraTabs(); });

  it('installs, opens its guide, and answers privileged calls', async () => {
    const url = await harness.urlOf(harness.extensionTab);
    assert.match(url, /^moz-extension:\/\/.+\/onboarding\.html$/);

    // The guide tab stands in for the background here, so a driver that cannot
    // reach the extension APIs from it makes the rest of the suite meaningless.
    const reach = await harness.inExtension(function (done) {
      done({
        id: browser.runtime.id,
        tabs: !!browser.tabs,
        storage: !!browser.storage,
      });
    });
    assert.equal(reach.id, 'marks-local@shiquda.github.io');
    assert.ok(reach.tabs && reach.storage, 'extension APIs are not reachable from the guide tab');
  });

  it('highlights a selection and restores it after a reload', async () => {
    await harness.openPage('test-page.html');
    assert.ok(await harness.waitForContentScript(), 'the content script never came up in the page');

    const expected = 'This is a sample paragraph with some text that can be highlighted.';

    await harness.inPage(function () {
      const paragraph = [...document.querySelectorAll('p')]
        .find(el => el.textContent.includes('This is a sample paragraph'));
      const range = document.createRange();
      range.selectNodeContents(paragraph);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    });

    // The promise form of tabs.sendMessage is the call that goes silently dead
    // on Firefox when someone reaches for a callback, so drive the highlight
    // through it rather than through the selection controls.
    const sent = await harness.sendToPage({ action: 'highlight', color: 'yellow' });
    assert.ok(sent.ok, `the highlight message never reached the content script: ${sent.error}`);

    const readHighlights = function () {
      const spans = [...document.querySelectorAll('span.text-highlighter-extension')];
      if (!spans.length) return null;
      return spans.map(span => ({
        text: span.textContent,
        background: getComputedStyle(span).backgroundColor,
      }));
    };

    const drawn = await harness.waitInPage(readHighlights);
    assert.deepEqual(drawn, [{ text: expected, background: 'rgb(255, 255, 0)' }]);

    // The content script answers the message as soon as the span is drawn and
    // fires the save without awaiting it, so a reload timed off the DOM alone
    // can outrun storage and blame the restore for a save that never landed.
    const saved = await harness.waitInExtension(function (done) {
      browser.storage.local.get(null).then(stored => {
        const key = Object.keys(stored)
          .find(name => name.includes('/test-page.html') && !name.endsWith('_meta'));
        const groups = key ? stored[key] : null;
        return browser.storage.sync.get(null).then(synced => done({
          groups: groups && groups.length ? groups.length : null,
          syncedWords: Object.keys(synced).length,
        }));
      }, () => done(null));
    });
    assert.equal(saved.groups, 1, 'the highlight never reached storage, so a reload would prove nothing');
    assert.equal(saved.syncedWords, 0, 'a highlight was written to storage.sync');

    await harness.reloadPage();
    const restored = await harness.waitInPage(readHighlights);
    assert.deepEqual(restored, [{ text: expected, background: 'rgb(255, 255, 0)' }],
      'the highlight was not restored after a reload');
  });

  it('opens the popup and reaches settings from it', async () => {
    // A driver cannot navigate to moz-extension:// - the extension has to open
    // its own page, the way the toolbar button would.
    await harness.inExtension(function (done) {
      browser.tabs.create({ url: browser.runtime.getURL('popup.html') })
        .then(() => done(true), error => done(String(error && error.message)));
    });

    const popup = await harness.findTab(url => url.includes('/popup.html'));
    assert.ok(popup, 'the popup page never opened');

    const expectedTitle = await harness.inExtension(function (done) {
      done(browser.i18n.getMessage('popupTitle'));
    });
    await harness.driver.switchTo().window(popup);

    // popup.html carries the English strings as static markup and popup.js
    // swaps them for the locale's on DOMContentLoaded, in the same pass that
    // registers the settings click. Reading either before that finishes tests
    // the markup rather than the popup: on an English browser the heading
    // matches without a line of script having run, and on any other one it
    // matches only if the timing happens to work out.
    assert.ok(await harness.waitForPageReady(), 'the popup never finished loading');

    const heading = await harness.driver.findElement(By.css('h1')).getText();
    assert.equal(heading, expectedTitle);

    await harness.driver.findElement(By.css('#open-settings')).click();
    // The popup closes itself here, so step off its handle before looking for
    // the settings tab; commands to a closed tab hang instead of failing.
    await harness.driver.switchTo().window(harness.pageTab);

    const settings = await harness.findTab(url => url.includes('/settings.html'));
    assert.ok(settings, 'the settings page did not open from the popup');
  });

  /**
   * The tests share one browser profile, so a test that cares about the policy
   * starts from the default rather than from whatever the previous one left.
   */
  async function resetPolicy() {
    await harness.inExtension(function (done) {
      browser.runtime.sendMessage({ action: 'getSitePolicy' })
        .then(response => response.policy.sites.reduce(
          (chain, rule) => chain.then(() => browser.runtime.sendMessage({ action: 'removeSiteRule', hostname: rule.hostname })),
          Promise.resolve()
        ))
        .then(() => browser.runtime.sendMessage({ action: 'setSitePolicyMode', mode: 'all' }))
        .then(() => done(true), error => done(String(error && error.message)));
    });
  }

  it('drives the site rules from the settings page', async () => {
    await resetPolicy();
    await harness.inExtension(function (done) {
      browser.tabs.create({ url: browser.runtime.getURL('settings.html') })
        .then(() => done(true), error => done(String(error && error.message)));
    });
    const settings = await harness.findTab(url => url.includes('/settings.html'));
    assert.ok(settings, 'the settings page never opened');
    assert.ok(await harness.waitForPageReady(), 'the settings page never finished loading');

    const ask = async message => harness.inExtension(function (payload, done) {
      browser.runtime.sendMessage(payload)
        .then(done, error => done({ error: String(error && error.message) }));
    }, message);
    const policyNow = async () => (await ask({ action: 'getSitePolicy' })).policy;
    // Reaching the extension moves the driver off the settings tab, so every
    // DOM step has to come back to it first.
    const onSettings = async run => {
      await harness.driver.switchTo().window(settings);
      return run();
    };

    // Both cards fill themselves in from a background message, so a filled-in
    // count is the proof that settings.js ran and the background answered - not
    // just that the markup is on the page.
    const filled = await harness.waitUntil(async () => {
      const read = await onSettings(() => harness.driver.executeScript(() => ({
        heading: (document.querySelector('#backup-section h2') || {}).textContent || '',
        rulesCount: (document.getElementById('site-rules-count') || {}).textContent || '',
        lastBackup: (document.getElementById('backup-status-last-success') || {}).textContent || '',
      })));
      return read.rulesCount && read.lastBackup ? read : null;
    });
    assert.ok(filled, 'the settings cards never filled in from the background');

    const expectedHeading = await harness.inExtension(function (done) {
      done(browser.i18n.getMessage('backupSection'));
    });
    assert.equal(filled.heading.trim(), expectedHeading, 'the backup card has no localized heading');

    const hostname = new URL(harness.baseUrl).hostname;

    await onSettings(() => harness.driver.findElement(By.css('#site-rules-mode-allowlist')).click());
    assert.ok(
      await harness.waitUntil(async () => ((await policyNow()).mode === 'allowlist' ? true : null)),
      'the mode control never reached the background'
    );

    await onSettings(async () => {
      await harness.driver.findElement(By.css('#site-rules-add-input')).sendKeys(hostname);
      await harness.driver.findElement(By.css('#site-rules-add-btn')).click();
    });
    assert.ok(
      await harness.waitUntil(async () => {
        const policy = await policyNow();
        return policy.sites.some(rule => rule.hostname === hostname) ? true : null;
      }),
      'adding a site from the settings page never reached the background'
    );

    // Read and click inside the page in one round trip each: the list re-renders
    // when the background answers, and an element handle captured a moment
    // earlier is stale by the time the driver uses it.
    const rows = await onSettings(() => harness.driver.executeScript(() => ({
      count: document.querySelectorAll('#site-rules-list .site-rule-row').length,
      hosts: Array.from(document.querySelectorAll('#site-rules-list .site-rule-row .site-rule-hostname'))
        .map(element => element.textContent.trim()),
    })));
    assert.deepEqual(rows, { count: 1, hosts: [hostname] }, 'the site rules list did not show the added site');

    const removed = await harness.waitUntil(async () => onSettings(() => harness.driver.executeScript(() => {
      const button = document.querySelector('#site-rules-list .site-rule-row .site-rule-remove-btn');
      if (!button) return null;
      button.click();
      return true;
    })));
    assert.ok(removed, 'the settings list never offered a remove button');
    assert.ok(
      await harness.waitUntil(async () => ((await policyNow()).sites.length === 0 ? true : null)),
      'removing a site from the settings page never reached the background'
    );

    await onSettings(() => harness.driver.findElement(By.css('#site-rules-mode-all')).click());
  });

  it('gates the content script behind the site allowlist', async () => {
    await resetPolicy();

    const hostname = new URL(harness.baseUrl).hostname;

    /**
     * Whether a content script is running in the page.
     *
     * Its own `window` is an isolated world, so a flag it sets there is not
     * readable from here. The answer to a message is: a script that never ran,
     * and a script that has torn itself down, both leave `getRestoredGroupIds`
     * unanswered - and an unanswered message is not a rejection in every
     * browser, which is why the shape of the answer is what is checked.
     */
    async function contentScriptAnswers(timeoutMs = 2000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const result = await harness.sendToPage({ action: 'getRestoredGroupIds' });
        if (result.ok && Array.isArray(result.response?.groupIds)) return true;
        await new Promise(resolve => setTimeout(resolve, 150));
      }
      return false;
    }

    /** Applies a policy change and reports what the browser now has registered. */
    const applyPolicy = function (options, done) {
      browser.runtime.sendMessage({ action: 'setSitePolicyMode', mode: options.mode })
        .then(() => (options.host
          ? browser.runtime.sendMessage({ action: 'addSiteRule', hostname: options.host })
          : Promise.resolve()))
        .then(response => browser.scripting.getRegisteredContentScripts()
          .then(scripts => done({ response, scripts })))
        .catch(error => done({ error: String(error && error.message) }));
    };

    // An allowlist that does not contain the test host registers nothing at
    // all - it is not a script that loads and then refuses to run.
    const listed = await harness.inExtension(applyPolicy, { mode: 'allowlist' });
    assert.ok(!listed.error, listed.error);
    assert.deepEqual(listed.scripts, [], 'an empty allowlist still registered a content script');

    await harness.openPage('test-page.html');
    assert.equal(
      await contentScriptAnswers(),
      false,
      'the content script ran on a site that is not in the allowlist'
    );

    // Enabling the site has to reach the page that is already open, not just
    // the next one: that is what the popup and the context menu promise.
    const enabled = await harness.inExtension(applyPolicy, { mode: 'allowlist', host: hostname });
    assert.ok(!enabled.error, enabled.error);
    assert.deepEqual(
      enabled.scripts.map(script => script.matches),
      [[`*://${hostname}/*`]],
      'enabling the site did not register exactly its own match pattern'
    );
    assert.equal(await contentScriptAnswers(), true, 'the enabled site did not get the content script');

    // Removing the site again has to reach the open page too, and the page has
    // to come back down: a content script that keeps running on a site the user
    // just removed is the feature failing.
    const removed = await harness.inExtension(function (host, done) {
      browser.runtime.sendMessage({ action: 'removeSiteRule', hostname: host })
        .then(response => done({ response }), error => done({ error: String(error && error.message) }));
    }, hostname);
    assert.ok(!removed.error, removed.error);
    assert.equal(removed.response.success, true);
    assert.equal(
      await contentScriptAnswers(),
      false,
      'the content script kept running on a site that was just removed'
    );

    await harness.inExtension(applyPolicy, { mode: 'all' });
  });

  it('hands the backup recovery code to the extension pages and to nothing else', async () => {
    await resetPolicy();

    await harness.openPage('test-page.html');
    assert.ok(await harness.waitForContentScript(), 'the content script never came up in the page');

    // executeScript runs in the content script's own world, so this is the
    // message a page's script would send - and it carries the page's URL.
    const fromPage = await harness.inExtension(function (pageUrl, done) {
      browser.tabs.query({}).then(tabs => {
        const target = tabs.find(tab => tab.url === pageUrl);
        if (!target) return done({ error: 'the page under test is not visible to the extension' });
        return browser.scripting.executeScript({
          target: { tabId: target.id },
          func: () => browser.runtime.sendMessage({ action: 'getBackupState' }),
        }).then(results => done({ answer: results[0] && results[0].result }))
          .catch(error => done({ error: String(error && error.message) }));
      });
    }, harness.pageUrl);
    assert.ok(!fromPage.error, fromPage.error);
    assert.equal(fromPage.answer && fromPage.answer.code, 'backup_forbidden',
      'a page was told the backup state');

    await harness.inExtension(function (done) {
      browser.tabs.create({ url: browser.runtime.getURL('settings.html') })
        .then(() => done(true), error => done(String(error && error.message)));
    });
    const settings = await harness.findTab(url => url.includes('/settings.html'));
    assert.ok(settings, 'the settings page never opened');

    const fromSettings = await harness.driver.executeAsyncScript(function (done) {
      browser.runtime.sendMessage({ action: 'getBackupState' })
        .then(response => done({ response }), error => done({ error: String(error && error.message) }));
    });
    assert.ok(!fromSettings.error, fromSettings.error);
    assert.equal(fromSettings.response.success, true, JSON.stringify(fromSettings.response));
    assert.equal(fromSettings.response.state.destination, 'none');
  });
});
