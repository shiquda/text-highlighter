# Marks Local: Text Highlighter

Highlight text on web pages and keep it on your own machine. Highlights live in
`storage.local`; the only thing that ever leaves the device is an encrypted
backup file you configure yourself.

This is a fork of [cuspymd/text-highlighter](https://github.com/cuspymd/text-highlighter)
(MIT). It keeps the highlighting engine and drops the parts that depended on
someone else's server: the Cloud Sync (Beta) service and the Cloudflare Worker
behind it are gone, and `storage.sync` is no longer read or written.

## Features

- **Text highlighting**: select and highlight text with multiple colours
- **Local-first storage**: every highlight and setting lives in `storage.local`
- **Site allowlist**: highlight everywhere, or only on the sites you list
- **Per-site actions**: enable or remove the current site from the popup or the
  context menu, and bring the page under the new rule without a reload
- **Encrypted backup**: push a sealed snapshot to a private GitHub Gist or any
  WebDAV server, on demand or daily
- **Previewed restore**: see what a remote backup contains before it replaces
  anything, with a safety copy written to your downloads first
- **Minimap**: highlighted positions at a glance, on the right of the page
- **Keyboard shortcuts**: quick highlighting and highlight-to-highlight
  navigation (desktop only)
- **Selection controls**: a floating highlight button on text selection, for
  touch devices
- **Languages**: English, Chinese, Korean, Japanese, Spanish, Portuguese,
  Russian (see [Known limitations](#known-limitations) for the new strings)

## Getting started

### Load the extension

```bash
npm install
npm run deploy:firefox   # dist-firefox/
npm run deploy:chrome    # dist/
```

- **Firefox**: `about:debugging` → This Firefox → Load Temporary Add-on →
  `dist-firefox/manifest.json`
- **Chrome**: `chrome://extensions` → Developer mode → Load unpacked → `dist/`

### Highlighting

Select text and pick a colour from the selection controls, the context menu, or
a keyboard shortcut. Everything is stored on this device.

### Which sites get highlighted

The default mode is **All sites**: every `http(s)` page, and every local file you
open in the browser, is highlighted.

Switch to **Allowlist** in Settings → Site Rules to restrict it. In that mode
the extension registers its content scripts only for the sites you list, so a
page that is not on the list never receives them at all. The popup shows the
state of the site you are on and can add or remove it in one click.

A local file has no hostname, so no allowlist rule can name it: in allowlist
mode, `file://` pages are not highlighted. Switching back to All sites brings
them back.

Two things follow from registering per site rather than always:

- Turning a site off tears the content script down. Turning it back on for a
  page that is already open needs a reload — the popup says so instead of
  pretending it worked.
- A browser without the `scripting` API cannot do this at all. See
  [Known limitations](#known-limitations).

### Backup and restore

Settings → Backup & Restore.

1. Pick a destination: **GitHub Gist** or **WebDAV**.
2. The first time you pick one, the extension generates a **recovery code**.
   Write it down. It is the only key to the backup: the file on the server is
   encrypted with a key derived from it, and nobody — this extension, GitHub,
   your WebDAV host — can read it without it.
3. Fill in the destination:
   - **GitHub Gist**: a personal access token with the `gist` scope. Leave the
     gist id empty to have a private gist created on the first backup.
   - **WebDAV**: the file URL, plus a username and password if the server needs
     them. Plain `http://` is refused unless you tick the box that allows it,
     because the credentials travel in the `Authorization` header.
4. **Test connection** before you rely on it.
5. **Back up now** uploads; **Automatic backup** does the same once a day and
   retries a network failure a few times with a widening delay. A run that finds
   nothing changed uploads nothing.

The payload is a snapshot of your pages, settings and site rules, sealed with
AES-256-GCM under a key derived from the recovery code (HKDF-SHA256). The
envelope records the format and its version; the recovery code, the tokens and
the passwords are never part of it.

To restore on another device: install the extension, choose the same
destination, fill in its credentials, paste your recovery code under "use an
existing recovery code", then **Restore from backup**. You are shown how many
pages and highlights the backup holds before it replaces anything.

Three things about restoring are deliberate:

- It replaces the local page set, rather than merging into it.
- It writes an encrypted copy of what is about to be overwritten to your
  downloads folder first. If that fails it stops, and asks again if you want to
  go ahead without it.
- If the remote changed since this device last read it, the upload refuses and
  tells you, instead of overwriting someone else's newer backup.

**Export local backup** writes the same sealed file to your downloads folder
without uploading anything.

## Privacy and permissions

| Permission | Why |
|---|---|
| `storage` | highlights, settings, site rules, backup configuration |
| `scripting` | registering the content scripts per site, and enabling a site in an already-open tab |
| `<all_urls>` | the pages to highlight, and the Gist / WebDAV endpoints |
| `tabs` | the URL of the active tab, for the popup and the site rules |
| `contextMenus` | the highlight and site menu items |
| `activeTab` | reading the active tab after a user gesture |
| `downloads` | writing a backup or a safety copy to your downloads folder |
| `alarms` | the daily backup, and its retries |

`<all_urls>` is broad because highlighting has to work on any page you choose.
Nothing is sent anywhere unless you configure a backup destination and run one.

`storage.sync` is not used. If an earlier version of this extension left data
there, it is no longer read and no longer updated; your highlights are in
`storage.local` and always were.

## Development

Three suites, run separately:

```bash
# Unit and integration tests (Jest, jsdom)
npm test

# End-to-end tests on Chromium (Playwright)
npx playwright install   # browsers, required before the first run
npx playwright test

# Firefox smoke tests (Selenium + geckodriver)
npm run test:e2e:firefox
```

The Firefox suite is what verifies the parts that only exist in a real browser:
that the build comes up, that a highlight survives a reload and is written to
local storage only, that its own pages open, that the settings page drives the
site rules, that the allowlist decides which pages get a content script —
including enabling one into an already-open page and tearing it back down — and
that the backup recovery code is answered to the extension's pages and refused
to a page. A second file runs full backup round trips against two WebDAV
servers the harness serves locally — one permissive, one that wants credentials
on every request and refuses HEAD — covering configure, upload, ciphertext on
the wire, a rejected credential, wipe, preview, restore, and the highlight
coming back after a reload. It builds `dist-firefox/` itself and takes a few
seconds.

```bash
HEADFUL=1 npm run test:e2e:firefox                        # watch it run
FIREFOX_BINARY="/path/to/firefox" npm run test:e2e:firefox
```

### Firefox for Android

Firefox for Android has no `scripting` API, so this build loads there but
cannot highlight anything — see [Known limitations](#known-limitations). The
commands below are for loading it anyway, for example to check the settings and
backup screens.

To test on a real Android device:

```bash
npx web-ext run -t firefox-android --adb-device <device-id> --firefox-apk org.mozilla.firefox -s dist-firefox
```

`adb devices` lists the device id. Alternatively, load `dist-firefox/manifest.json`
through `about:debugging` on the desktop with the device connected. Logs:
`adb logcat -s GeckoConsole`.

### Production build

```bash
npm run version-deploy <version> [chrome|firefox]
```

Updates the version in the matching manifest, turns `DEBUG_MODE` off, builds,
and writes `outputs/text-highlighter-<version>-<browser>.zip` for the store.

## Browser support

| API | Chrome | Firefox Desktop | Firefox Android |
|-----|--------|----------------|-----------------|
| `storage.local` | O | O | O |
| `scripting` | O | O (140+) | X |
| `tabs`, `runtime`, `i18n` | O | O | O |
| `contextMenus` | O | O | X |
| `commands` | O | O | X |
| `downloads` | O | O | O |
| `alarms` | O | O | O |

Unavailable APIs are guarded at runtime with `browser.runtime.getPlatformInfo()`.

## Known limitations

- **Firefox for Android cannot highlight.** It has no `scripting` API, so the
  per-site content script registration has nowhere to run. Highlighting there
  would need the old always-on static registration, which is the thing the site
  allowlist replaced.
- **Re-enabling a site needs a reload.** Disabling a site tears the content
  script down, and the same script set cannot be re-injected into a live page.
  The popup tells you when a reload is needed.
- **`navigation-bridge.js` keeps running after a site is disabled.** It patches
  `history` in the page's own world, which cannot be undone. It publishes
  nothing once the rest of the script has been torn down.
- **The new strings are only translated into English and Chinese.** Spanish,
  Japanese, Korean, Portuguese and Russian fall back to English for the site
  rules and backup screens.
- **A Gist truncates its files at about 1 MB.** A truncated backup is detected
  and reported rather than restored. Use WebDAV for a large collection.
- **A local `file://` page is only highlighted in All sites mode.** Allowlist
  rules are hostnames, and a local file has none, so there is nothing to list.
- **One backup destination at a time.**
- **A restore replaces rather than merges.** The safety copy written to your
  downloads folder is the way back.

## Contributing

1. Fork the project
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## License

MIT — see [LICENSE](LICENSE). Original work by
[cuspymd](https://github.com/cuspymd/text-highlighter).
