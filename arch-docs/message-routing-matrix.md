# Message Routing Matrix

Source of truth: `background/message-router.js`

Every response is `{ success: true, ... }` or `{ success: false, code, error }`.
`code` is a stable machine string the UI maps to a localized sentence; `error`
is an English fallback for the case where the UI has no mapping.

| action | request fields | response fields | side effects | handler |
|---|---|---|---|---|
| `getDebugMode` | none | `debugMode` | none | `handleGetDebugMode` |
| `getPlatformInfo` | none | `platform`, `isMobile` | none | `handleGetPlatformInfo` |
| `openExtensionPage` | `page` (`pagesList` \| `settings`) | `success`, `opened?`, `error?` | focuses the tab already showing the page, or creates one (refreshes an existing pages list) | `handleOpenExtensionPage` |
| `getColors` | none | `colors` | none | `handleGetColors` |
| `saveSettings` | `minimapVisible?`, `selectionControlsVisible?`, `oneClickHighlightEnabled?` | `success`, `error?` | local storage write, settings broadcast | `handleSaveSettings` |
| `getHighlights` | `url` | `highlights` | local storage read | `handleGetHighlights` |
| `clearCustomColors` | none | `success`, `noCustomColors?`, `error?` | local storage write, context menu update, tab broadcast | `handleClearCustomColors` |
| `addColor` | `color` | `success`, `colors?`, `error?` | local storage write, context menu update, tab broadcast | `handleAddColor` |
| `updateCustomColor` | `id`, `color` | `success`, `colors?`, `exists?`, `error?` | local storage write, context menu update, tab broadcast | `handleUpdateCustomColor` |
| `updateCustomColorName` | `id`, `name` | `success`, `colors?`, `exists?`, `error?` | local storage write, context menu update, tab broadcast | `handleUpdateCustomColorName` |
| `removeCustomColor` | `id` | `success`, `colors?`, `error?` | local storage write, context menu update, tab broadcast | `handleRemoveCustomColor` |
| `getShortcutColorMap` | none | `success`, `shortcutColorMap`, `error?` | local storage read | `handleGetShortcutColorMap` |
| `saveShortcutColorMap` | `shortcutColorMap` | `success`, `error?` | local storage write, context menu update | `handleSaveShortcutColorMap` |
| `saveHighlights` | `url`, `highlights`, `deletedGroupIds?` | `success`, `error?`, `code?` | local storage write/remove; refused with `site_not_allowed` unless the sending tab is on an allowed site | `handleSaveHighlights` |
| `deleteHighlight` | `url`, `groupId`, `notifyRefresh?` | `success`, `highlights?`, `error?` | local storage write/remove, tab broadcast (optional) | `handleDeleteHighlight` |
| `clearAllHighlights` | `url`, `notifyRefresh?` | `success`, `error?` | local storage remove, tab broadcast (optional) | `handleClearAllHighlights` |
| `getAllHighlightedPages` | none | `success`, `pages`, `error?` | local storage read | `handleGetAllHighlightedPages` |
| `deleteAllHighlightedPages` | none | `success`, `deletedCount`, `error?` | local storage remove | `handleDeleteAllHighlightedPages` |
| `getSitePolicy` | none | `policy` | local storage read | `handleGetSitePolicy` |
| `setSitePolicyMode` | `mode` (`all` \| `allowlist`) | `policy`, `injected`, `needsRefresh` | local storage write, content-script re-registration, hot injection / teardown of affected open tabs, context menu redraw | `handleSetSitePolicyMode` |
| `addSiteRule` | `hostname`, `includeSubdomains?` | `policy`, `added`, `hostname`, `injected`, `needsRefresh` | same as `setSitePolicyMode` | `handleAddSiteRule` |
| `removeSiteRule` | `hostname` | `policy`, `removed`, `hostname`, `tornDown` | local storage write, content-script re-registration, teardown of affected open tabs, context menu redraw | `handleRemoveSiteRule` |
| `setSiteRuleSubdomains` | `hostname`, `includeSubdomains` | `policy`, `hostname`, `updated`, `injected`, `needsRefresh`, `tornDown` | same as `setSitePolicyMode` | `handleSetSiteRuleSubdomains` |
| `getSiteStatus` | `url?` (defaults to the active tab) | `status` | none | `handleGetSiteStatus` |
| `getBackupState` | none | `state` | local storage read, one snapshot fingerprint | `handleGetBackupState` |
| `setBackupDestination` | `destination` (`none`\|`gist`\|`webdav`) | `state`, `generatedRecoveryCode` | local storage write, alarm schedule; mints a recovery code on first configuration | `handleSetBackupDestination` |
| `setBackupAutoEnabled` | `enabled` | `state` | local storage write, alarm schedule, one run when switched on | `handleSetBackupAutoEnabled` |
| `saveGistConfig` | `token?`, `gistId?`, `filename?` | `state` | local storage write; a new token or gist forgets the known remote revision | `handleSaveGistConfig` |
| `saveWebdavConfig` | `url?`, `username?`, `password?`, `allowInsecureHttp?` | `state` | same as `saveGistConfig` | `handleSaveWebdavConfig` |
| `generateBackupRecoveryCode` | none | `state`, `code` | local storage write | `handleGenerateBackupRecoveryCode` |
| `saveBackupRecoveryCode` | `code` | `state` | local storage write; refuses a code that is not a valid one | `handleSaveBackupRecoveryCode` |
| `testBackupConnection` | none | `state`, `details?` | provider request; records the remote revision it read | `handleTestBackupConnection` |
| `runBackupNow` | `force?` | `state`, `result` | snapshot, seal, provider upload; skipped when the fingerprint is unchanged unless forced | `handleRunBackupNow` |
| `previewRemoteBackup` | none | `preview`, `source`, `state` | provider read, decrypt, validate; records the remote revision | `handlePreviewRemoteBackup` |
| `restoreFromRemoteBackup` | `confirm` (must be `true`), `acceptMissingSnapshot?` | `summary`, `safetySnapshot`, `state` | downloads a safety snapshot, replaces the page set, settings and site rules, re-syncs the content-script registration, redraws the menus, refreshes the restored pages | `handleRestoreFromRemoteBackup` |
| `exportLocalBackup` | none | `filename`, `encrypted`, `state` | seals the local snapshot and downloads it | `handleExportLocalBackup` |

## Notes

- Unknown actions return `{ success: false, code: 'unknown_action', error }`.
- Page-to-page actions (`refreshPagesList`) are not handled here: the router returns without responding so the extension page they target can answer. The pages list listens for it on `runtime.onMessage`.
- All handlers respond asynchronously through `runtime.onMessage`.
- `saveHighlights` is the only highlight write a page can reach, and it is authorised against `sender.tab.url` rather than the `url` in the message, so a content script cannot name a site it is not on. Deletes are not gated: removing data is safe on any page.
- The site actions all go through `background/site-rule-service.js`, which owns the single write queue, the content-script registration, and the hot injection / teardown of already-open tabs.
- Every `backup*` action is gated on the sender's URL scheme: only `moz-extension://`, `chrome-extension://`, `safari-web-extension://` and `ms-browser-extension://` are answered, and anything else gets `backup_forbidden` without touching storage. The sender's `sender.tab` cannot be that test on its own, because the settings page is itself a tab. This matters because `getBackupState` answers with the recovery code.
- The backup actions talk to `background/backup-service.js`. `runBackupNow` answers `success: true` with `result.ok === false` for a run that failed — the state is still worth returning — while every other backup action turns a failure into an error response.
- `restoreFromRemoteBackup` refuses with `backup_confirm_required` unless `confirm` is exactly `true`, and with `backup_safety_snapshot_failed` when the safety copy could not be written and `acceptMissingSnapshot` is not `true`.
