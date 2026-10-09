export const STORAGE_KEYS = {
  CUSTOM_COLORS: 'customColors',
  MINIMAP_VISIBLE: 'minimapVisible',
  SELECTION_CONTROLS_VISIBLE: 'selectionControlsVisible',
  ONE_CLICK_HIGHLIGHT: 'oneClickHighlightEnabled',
  LAST_USED_COLOR: 'lastUsedColor',
  META_SUFFIX: '_meta',
  SHORTCUT_COLOR_MAP: 'shortcutColorMap',
};

// Site rules live under one key so a mode change and a list change are a single
// atomic write, and so both UIs read the same object.
export const SITE_POLICY_KEY = 'sitePolicy';

export const BACKUP_KEYS = {
  CONFIG: 'backupConfig',
  RECOVERY_CODE: 'backupRecoveryCode',
  LAST_SUCCESS_AT: 'backupLastSuccessAt',
  LAST_FINGERPRINT: 'backupLastFingerprint',
  LAST_ERROR: 'backupLastError',
  LAST_ATTEMPT_AT: 'backupLastAttemptAt',
};

// The settings carried by a backup beyond the pages themselves. Named once here
// because the snapshot builder and the restore writer have to agree on the set.
export const BACKED_UP_SETTING_KEYS = [
  STORAGE_KEYS.CUSTOM_COLORS,
  STORAGE_KEYS.MINIMAP_VISIBLE,
  STORAGE_KEYS.SELECTION_CONTROLS_VISIBLE,
  STORAGE_KEYS.ONE_CLICK_HIGHLIGHT,
  STORAGE_KEYS.SHORTCUT_COLOR_MAP,
];

/**
 * Every storage.local key that is not a highlighted page.
 *
 * The page scan keys off `Array.isArray(value)`, so anything here that could
 * ever hold an array would otherwise be listed, exported and deleted as a page.
 * Two of them are arrays today: the recovered backup's own page list, and the
 * site rules' `sites` - the latter nested, but listed anyway so the invariant
 * survives a future flattening.
 */
export const NON_PAGE_STORAGE_KEYS = [
  ...Object.values(STORAGE_KEYS),
  SITE_POLICY_KEY,
  ...Object.values(BACKUP_KEYS),
];

export function isPageStorageKey(key, value) {
  if (!Array.isArray(value)) return false;
  if (key.endsWith(STORAGE_KEYS.META_SUFFIX)) return false;
  return !NON_PAGE_STORAGE_KEYS.includes(key);
}
