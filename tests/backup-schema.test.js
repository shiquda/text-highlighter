import {
  BACKUP_SCHEMA_VERSION,
  BACKUP_APP_ID,
  BACKUP_FORMAT,
  DEFAULT_BACKUP_SETTINGS,
  buildBackupSnapshot,
  validateBackupSnapshot,
  describeBackupSnapshot,
  canonicalizeSnapshot,
  computeSnapshotFingerprint,
  isBackupEnvelope,
  readEnvelopeMeta,
} from '../shared/backup-schema.js';
import { STORAGE_KEYS, BACKUP_KEYS, SITE_POLICY_KEY } from '../constants/storage-keys.js';

describe('backup-schema', () => {
  const PAGE1_URL = 'https://example.org/article1';
  const PAGE2_URL = 'https://example.org/article2';

  const sampleHighlightsPage1 = [
    {
      groupId: 'g1',
      color: '#ffff00',
      text: 'First highlight',
      updatedAt: 1700000000000,
      spans: [{ spanId: 's1', text: 'First highlight', position: 0 }],
    },
  ];

  const sampleHighlightsPage2 = [
    {
      groupId: 'g2',
      color: '#00ff00',
      text: 'Second highlight',
      updatedAt: 1700000005000,
      spans: [{ spanId: 's2', text: 'Second highlight', position: 10 }],
    },
  ];

  function createRealisticStorageDump() {
    return {
      [PAGE1_URL]: sampleHighlightsPage1,
      [`${PAGE1_URL}${STORAGE_KEYS.META_SUFFIX}`]: {
        title: 'Article 1 Title',
        lastUpdated: '2026-03-01T12:00:00.000Z',
        deletedGroupIds: { old_g0: 1699999990000 },
      },
      [PAGE2_URL]: sampleHighlightsPage2,
      [`${PAGE2_URL}${STORAGE_KEYS.META_SUFFIX}`]: {
        title: 'Article 2 Title',
        lastUpdated: '2026-03-02T15:30:00.000Z',
        deletedGroupIds: {},
      },
      [STORAGE_KEYS.CUSTOM_COLORS]: [{ id: 'custom_1', color: '#ff00ff' }],
      [SITE_POLICY_KEY]: {
        version: 1,
        mode: 'allowlist',
        sites: [{ hostname: 'example.org', includeSubdomains: true }],
      },
      // Sensitive / internal backup keys that must NEVER leak into the snapshot:
      [BACKUP_KEYS.CONFIG]: { destination: 'gist', token: 'secret-token-12345', gistId: 'gist-abcdef' },
      [BACKUP_KEYS.RECOVERY_CODE]: 'XXXX-YYYY-ZZZZ-WWWW',
      [BACKUP_KEYS.LAST_SUCCESS_AT]: 1700000010000,
      [BACKUP_KEYS.LAST_FINGERPRINT]: 'abcd1234ef567890',
      [BACKUP_KEYS.LAST_ERROR]: { code: 'backup_network', message: 'Offline', at: 1700000009000 },
      [BACKUP_KEYS.LAST_ATTEMPT_AT]: 1700000010000,
      [STORAGE_KEYS.LAST_USED_COLOR]: '#ff00ff',
    };
  }

  test('buildBackupSnapshot creates valid snapshot and excludes backup keys & sensitive tokens', () => {
    const storageDump = createRealisticStorageDump();
    const snapshot = buildBackupSnapshot({ storage: storageDump });

    expect(snapshot.schemaVersion).toBe(BACKUP_SCHEMA_VERSION);
    expect(snapshot.app).toBe(BACKUP_APP_ID);
    expect(typeof snapshot.exportedAt).toBe('string');

    // Never contain backup internals or tokens
    expect(snapshot).not.toHaveProperty('backupConfig');
    expect(snapshot).not.toHaveProperty('backupRecoveryCode');
    expect(snapshot).not.toHaveProperty('backupLastSuccessAt');
    expect(snapshot).not.toHaveProperty('backupLastFingerprint');
    expect(snapshot).not.toHaveProperty('backupLastError');
    expect(snapshot).not.toHaveProperty('backupLastAttemptAt');
    expect(snapshot).not.toHaveProperty('lastUsedColor');

    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain('secret-token-12345');
    expect(serialized).not.toContain('gist-abcdef');
    expect(serialized).not.toContain('XXXX-YYYY-ZZZZ-WWWW');
    expect(serialized).not.toContain('abcd1234ef567890');

    // Site policy round-trips correctly
    expect(snapshot.sitePolicy).toEqual({
      version: 1,
      mode: 'allowlist',
      sites: [{ hostname: 'example.org', includeSubdomains: true }],
    });

    // Absent settings become explicit defaults
    expect(snapshot.settings).toEqual({
      customColors: [{ id: 'custom_1', color: '#ff00ff' }],
      minimapVisible: true,
      selectionControlsVisible: true,
      oneClickHighlightEnabled: false,
      shortcutColorMap: {},
    });

    // Pages are extracted and sorted
    expect(snapshot.pages).toHaveLength(2);
    expect(snapshot.pages[0].url).toBe(PAGE1_URL);
    expect(snapshot.pages[0].title).toBe('Article 1 Title');
    expect(snapshot.pages[0].highlights).toEqual(sampleHighlightsPage1);
    expect(snapshot.pages[0].meta.lastUpdated).toBe('2026-03-01T12:00:00.000Z');
    expect(snapshot.pages[0].meta.deletedGroupIds).toEqual({ old_g0: 1699999990000 });
  });

  test('buildBackupSnapshot handles pages missing _meta gracefully', () => {
    const storage = {
      'https://example.com/no-meta': [
        { groupId: 'g1', color: '#ffff00', text: 'hi', updatedAt: 123, spans: [{ text: 'hi', spanId: 's1', position: 0 }] },
      ],
    };

    const snapshot = buildBackupSnapshot({ storage });
    expect(snapshot.pages).toHaveLength(1);
    expect(snapshot.pages[0].title).toBe('');
    expect(snapshot.pages[0].meta).toEqual({
      lastUpdated: '',
      deletedGroupIds: {},
    });
  });

  test('validateBackupSnapshot drops corrupted highlight group but keeps the rest of the page', () => {
    const raw = {
      schemaVersion: 1,
      app: BACKUP_APP_ID,
      exportedAt: '2026-03-01T00:00:00.000Z',
      sitePolicy: { version: 1, mode: 'all', sites: [] },
      settings: DEFAULT_BACKUP_SETTINGS,
      pages: [
        {
          url: 'https://example.com/mixed',
          title: 'Mixed Highlights',
          highlights: [
            // Valid highlight group
            {
              groupId: 'valid-1',
              color: '#ffff00',
              text: 'Valid',
              updatedAt: 1700000000000,
              spans: [{ spanId: 's1', text: 'Valid', position: 0 }],
            },
            // Corrupted highlight group (missing color and text)
            {
              groupId: 'corrupted-2',
              spans: [],
            },
          ],
          meta: { lastUpdated: '2026-03-01T00:00:00.000Z', deletedGroupIds: {} },
        },
      ],
    };

    const result = validateBackupSnapshot(raw);
    expect(result.valid).toBe(true);
    expect(result.reason).toBeNull();
    expect(result.snapshot.pages).toHaveLength(1);
    expect(result.snapshot.pages[0].highlights).toHaveLength(1);
    expect(result.snapshot.pages[0].highlights[0].groupId).toBe('valid-1');

    expect(result.stats.inputHighlights).toBe(2);
    expect(result.stats.acceptedHighlights).toBe(1);
    expect(result.stats.rejectedHighlights).toBe(1);
    expect(result.stats.acceptedPages).toBe(1);
    expect(result.stats.rejectedPages).toBe(0);
  });

  test('validateBackupSnapshot rejects schemaVersion: 2 with unsupported-version', () => {
    const raw = {
      schemaVersion: 2,
      app: BACKUP_APP_ID,
      exportedAt: '2026-03-01T00:00:00.000Z',
      sitePolicy: { version: 1, mode: 'all', sites: [] },
      settings: DEFAULT_BACKUP_SETTINGS,
      pages: [],
    };

    const result = validateBackupSnapshot(raw);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('unsupported-version');
    expect(result.snapshot).toBeNull();
  });

  test('validateBackupSnapshot rejects invalid app or non-object payload', () => {
    expect(validateBackupSnapshot(null).valid).toBe(false);
    expect(validateBackupSnapshot('not-an-object').valid).toBe(false);
    expect(validateBackupSnapshot({ schemaVersion: 1, app: 'wrong-app', pages: [] }).reason).toBe('invalid-app');
    expect(validateBackupSnapshot({ schemaVersion: 1, app: BACKUP_APP_ID }).reason).toBe('pages must be an array');
  });

  test('computeSnapshotFingerprint is stable across exportedAt change but changes when highlight color changes', async () => {
    const snapshot1 = buildBackupSnapshot({
      storage: createRealisticStorageDump(),
      exportedAt: '2026-01-01T00:00:00.000Z',
    });

    const snapshot2 = buildBackupSnapshot({
      storage: createRealisticStorageDump(),
      exportedAt: '2026-06-01T12:00:00.000Z',
    });

    const fp1 = await computeSnapshotFingerprint(snapshot1);
    const fp2 = await computeSnapshotFingerprint(snapshot2);

    expect(typeof fp1).toBe('string');
    expect(fp1).toMatch(/^[0-9a-f]{64}$/);
    expect(fp1).toBe(fp2);

    // Now change a highlight color in storage
    const modifiedDump = createRealisticStorageDump();
    modifiedDump[PAGE1_URL] = [
      {
        ...sampleHighlightsPage1[0],
        color: '#ff0000', // yellow changed to red
      },
    ];

    const snapshotModified = buildBackupSnapshot({
      storage: modifiedDump,
      exportedAt: '2026-01-01T00:00:00.000Z',
    });

    const fp3 = await computeSnapshotFingerprint(snapshotModified);
    expect(fp3).not.toBe(fp1);
  });

  test('describeBackupSnapshot returns accurate preview counts and policy mode', () => {
    const snapshot = buildBackupSnapshot({ storage: createRealisticStorageDump() });
    const description = describeBackupSnapshot(snapshot);

    expect(description).toEqual({
      exportedAt: snapshot.exportedAt,
      pageCount: 2,
      highlightCount: 2,
      siteCount: 1,
      mode: 'allowlist',
    });
  });

  test('isBackupEnvelope and readEnvelopeMeta identify envelopes without decrypting', () => {
    const validEnvelope = {
      format: BACKUP_FORMAT,
      version: 1,
      createdAt: '2026-03-01T00:00:00.000Z',
      alg: 'AES-256-GCM',
      kdf: 'HKDF-SHA256',
      iv: 'base64iv==',
      ciphertext: 'base64cipher==',
    };

    expect(isBackupEnvelope(validEnvelope)).toBe(true);
    expect(isBackupEnvelope({ hello: 'world' })).toBe(false);

    const meta = readEnvelopeMeta(validEnvelope);
    expect(meta).toEqual({
      format: BACKUP_FORMAT,
      version: 1,
      createdAt: '2026-03-01T00:00:00.000Z',
      alg: 'AES-256-GCM',
      kdf: 'HKDF-SHA256',
    });

    expect(readEnvelopeMeta(null)).toBeNull();
  });
});
