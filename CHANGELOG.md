# Changelog

## 3.0.0 — Marks Local

Fork of [cuspymd/text-highlighter](https://github.com/cuspymd/text-highlighter)
2.13.1. The highlighting engine is unchanged; the way data moves is not.

### Removed

- **Cloud Sync (Beta)** — the whole feature: the settings UI, the sync
  (pull-merge-push) service, its alarms and its locale strings. The Cloudflare
  Worker it talked to (`worker/`) is deleted from this fork, so an installed
  copy of 2.13.1 cannot keep calling it after the upgrade.
- **`storage.sync`** — no highlight or setting is written to, or read from, the
  browser's sync storage any more. The custom-colour fallback read is gone with
  it. Data an earlier version left in `storage.sync` is ignored, not deleted.
- **Static `content_scripts`** in both manifests. Content scripts are registered
  at runtime instead, which is what makes the allowlist mean something. In All
  sites mode the registration covers `http`, `https` and `file` URLs; in
  allowlist mode it covers only the listed hostnames, so a local file is not
  highlighted there - a hostname rule cannot name one.

### Added

- **Site rules** — a mode (`all` or `allowlist`) plus a list of hostnames with
  an "include subdomains" flag, stored under a single `sitePolicy` key. In
  allowlist mode a page that is not on the list gets no content script at all.
  Enabling or removing the current site is one click in the popup or the context
  menu, and enabling hot-injects the page that is already open.
- **Write authorization in the background** — the tab URL a message came from is
  the authority for every highlight write, so a stale or forged message cannot
  write highlights for a site the rules do not allow. New codes:
  `site_invalid_hostname`, `site_not_found`, `site_unsupported_url`,
  `site_not_allowed`, `site_storage_error`. Deletes are never gated.
- **Backup and restore** — `background/backup-service.js` and the
  `backup-providers/` (GitHub Gist, WebDAV). A snapshot of pages, settings and
  site rules goes to the destination you configure.
  - **Encryption is off by default.** The upload is then that snapshot as plain
    JSON, readable by anyone who can reach the file. Turning **Encrypt backups**
    on seals it with AES-256-GCM under a key derived from a locally generated
    recovery code (HKDF-SHA256) and is what mints that code; the code, tokens and
    passwords are never part of the payload either way (`setBackupEncryption`).
  - Reading tolerates both shapes, because the remote can hold either: an
    envelope needs the recovery code, a plain snapshot needs nothing, and the
    preview says which one it found before a restore replaces anything.
  - Automatic backup runs once a day and retries a network failure a few times
    with a widening delay, up to six hours apart.
  - Unchanged data is not uploaded.
  - An upload whose remote changed since this device last read it is refused as a
    conflict rather than overwriting the other device's backup.
  - A restore is previewed, requires an explicit confirmation, writes a safety
    copy of the current data to the downloads folder first (in the shape the
    current setting produces), replaces the page set, and rolls the storage back
    if a write fails halfway.
  - `exportLocalBackup` writes the same payload locally, with `.enc.json` in the
    filename when it is sealed and `.json` when it is not.
  - The remote filename does not encode the mode (`marks-local-backup.json`):
    renaming the file on a mode change would leave the previous one behind at the
    destination, and the payload already says which shape it is.
- **New settings cards**: Site Rules, and Backup & Restore.
- **New locale strings** for both. English and Chinese are translated; Spanish,
  Japanese, Korean, Portuguese and Russian carry the English text.

### Changed

- **Name, id and version**: the extension is now "Marks Local"
  (`marks-local@shiquda.github.io`), version 3.0.0, so it installs alongside
  2.13.1 rather than as an upgrade of it.
- **Permissions**: `scripting` and `downloads` added, plus an `<all_urls>` host
  permission (2.13.1 relied on the host access its static content scripts
  implied). The `storage` permission now only covers `storage.local`.
- **Firefox floor unchanged** at 140.0 desktop / 142.0 Android, as in 2.13.1.

### Known limitations

See the [README](README.md#known-limitations). The significant one: Firefox for
Android has no `scripting` API, so highlighting is unavailable there.

### Deviations from the original plan

- **The plan required end-to-end encrypted uploads with no plaintext path at
  all** (PRD §48, §155, §165 and acceptance item C04). That requirement was
  dropped on purpose, by the owner, in favour of an unencrypted default with
  encryption as an opt-in: C04 now holds only while the toggle is on, and the
  help text says so. Restoring the stricter behaviour means flipping the default
  in `DEFAULT_CONFIG` and re-minting the code at destination-configure time.
- The legacy sync and Cloud Sync test suites (`tests/sync-service.test.js`,
  `tests/cloud-sync-service.test.js`, `e2e-tests/sync.spec.js`) are deleted
  rather than adapted, because the features they cover are gone. They are
  replaced by assertions that no code path writes to `storage.sync`.
- A disabled site needs a page reload before it can be highlighted again: the
  content script files declare top-level `const`s, so re-injecting them into a
  live page is a redeclaration error, not a re-initialisation. The popup reports
  this instead of claiming success.
