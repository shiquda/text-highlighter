import {
  sealBackup,
  openBackup,
  sealBackupToText,
  openBackupFromText,
  generateRecoveryCode,
  normalizeRecoveryCode,
} from '../shared/backup-crypto.js';

describe('backup-crypto', () => {
  const sampleSnapshot = {
    schemaVersion: 1,
    app: 'marks-local',
    exportedAt: '2026-03-01T00:00:00.000Z',
    sitePolicy: { version: 1, mode: 'all', sites: [] },
    settings: {
      customColors: [],
      minimapVisible: true,
      selectionControlsVisible: true,
      oneClickHighlightEnabled: false,
      shortcutColorMap: {},
    },
    pages: [
      {
        url: 'https://example.org/test',
        title: 'Test Article',
        highlights: [
          {
            groupId: 'g1',
            color: '#ffff00',
            text: 'Highlighted text',
            updatedAt: 1700000000000,
            spans: [{ spanId: 's1', text: 'Highlighted text', position: 0 }],
          },
        ],
        meta: { lastUpdated: '2026-03-01T00:00:00.000Z', deletedGroupIds: {} },
      },
    ],
  };

  test('seal/open round-trip succeeds with valid recovery code', async () => {
    const recoveryCode = generateRecoveryCode();
    const envelope = await sealBackup(sampleSnapshot, recoveryCode);

    expect(envelope.format).toBe('marks-local-backup');
    expect(envelope.version).toBe(1);
    expect(envelope.alg).toBe('AES-256-GCM');
    expect(envelope.kdf).toBe('HKDF-SHA256');
    expect(typeof envelope.iv).toBe('string');
    expect(typeof envelope.ciphertext).toBe('string');

    const result = await openBackup(envelope, recoveryCode);
    expect(result.ok).toBe(true);
    expect(result.snapshot).toEqual(sampleSnapshot);
  });

  test('wrong recovery code results in backup_decrypt_failed', async () => {
    const codeA = generateRecoveryCode();
    const codeB = generateRecoveryCode();
    const envelope = await sealBackup(sampleSnapshot, codeA);

    const result = await openBackup(envelope, codeB);
    expect(result).toEqual({ ok: false, code: 'backup_decrypt_failed' });
  });

  test('tampered ciphertext results in backup_decrypt_failed', async () => {
    const recoveryCode = generateRecoveryCode();
    const envelope = await sealBackup(sampleSnapshot, recoveryCode);

    // Tamper with ciphertext by altering a base64 character
    const tamperedCipher = envelope.ciphertext.startsWith('A')
      ? 'B' + envelope.ciphertext.slice(1)
      : 'A' + envelope.ciphertext.slice(1);

    const tamperedEnvelope = {
      ...envelope,
      ciphertext: tamperedCipher,
    };

    const result = await openBackup(tamperedEnvelope, recoveryCode);
    expect(result).toEqual({ ok: false, code: 'backup_decrypt_failed' });
  });

  test('version: 2 results in backup_unsupported_version', async () => {
    const recoveryCode = generateRecoveryCode();
    const envelope = await sealBackup(sampleSnapshot, recoveryCode);

    const futureEnvelope = {
      ...envelope,
      version: 2,
    };

    const result = await openBackup(futureEnvelope, recoveryCode);
    expect(result).toEqual({ ok: false, code: 'backup_unsupported_version' });
  });

  test('{ hello: "world" } results in backup_invalid_format', async () => {
    const recoveryCode = generateRecoveryCode();
    const result = await openBackup({ hello: 'world' }, recoveryCode);
    expect(result).toEqual({ ok: false, code: 'backup_invalid_format' });
  });

  test('two seals of the same snapshot give different iv and different ciphertext', async () => {
    const recoveryCode = generateRecoveryCode();
    const e1 = await sealBackup(sampleSnapshot, recoveryCode);
    const e2 = await sealBackup(sampleSnapshot, recoveryCode);

    expect(e1.iv).not.toBe(e2.iv);
    expect(e1.ciphertext).not.toBe(e2.ciphertext);
  });

  test('normalizeRecoveryCode accepts lower-case and dash-free input, and throws on a short code', () => {
    const canonical = generateRecoveryCode();
    // Lowercase and dash-free
    const messy = canonical.toLowerCase().replace(/-/g, '');
    const normalized = normalizeRecoveryCode(messy);
    expect(normalized).toBe(canonical);

    // Throws on short code
    expect(() => normalizeRecoveryCode('1234-5678')).toThrow();
    expect(() => normalizeRecoveryCode('')).toThrow();
    expect(() => normalizeRecoveryCode(12345)).toThrow();
  });

  test('sealBackupToText and openBackupFromText round-trip JSON text', async () => {
    const recoveryCode = generateRecoveryCode();
    const text = await sealBackupToText(sampleSnapshot, recoveryCode);
    expect(typeof text).toBe('string');
    expect(text).toContain('"marks-local-backup"');

    const result = await openBackupFromText(text, recoveryCode);
    expect(result.ok).toBe(true);
    expect(result.snapshot).toEqual(sampleSnapshot);

    const invalidResult = await openBackupFromText('not valid json', recoveryCode);
    expect(invalidResult).toEqual({ ok: false, code: 'backup_invalid_format' });
  });
});
