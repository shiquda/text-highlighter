// Client-side cryptography for encrypted backups.
//
// Encrypts snapshots using AES-256-GCM with keys derived from a 256-bit
// user recovery code via HKDF-SHA256. The plaintext snapshot never leaves
// the local browser; only the sealed envelope reaches remote storage.

import {
  deriveKeysFromCode,
  generateRecoveryCode,
  normalizeRecoveryCode,
  bytesToBase64,
  base64ToBytes,
} from './crypto-utils.js';
import {
  BACKUP_SCHEMA_VERSION,
  BACKUP_FORMAT,
  isBackupEnvelope,
} from './backup-schema.js';

export { generateRecoveryCode, normalizeRecoveryCode };

const HKDF_BACKUP_ENCRYPT = 'marks-local-backup-encrypt-v1';
const HKDF_BACKUP_KEYID = 'marks-local-backup-keyid-v1';

const GCM_IV_BYTE_LENGTH = 12;
const BACKUP_ALG = 'AES-256-GCM';
const BACKUP_KDF = 'HKDF-SHA256';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Seal a plaintext snapshot into an encrypted envelope.
 */
export async function sealBackup(snapshot, recoveryCode) {
  const iv = crypto.getRandomValues(new Uint8Array(GCM_IV_BYTE_LENGTH));
  const { encryptionKey } = await deriveKeysFromCode(recoveryCode, {
    encryptionInfo: HKDF_BACKUP_ENCRYPT,
    keyIdInfo: HKDF_BACKUP_KEYID,
  });

  const plaintext = textEncoder.encode(JSON.stringify(snapshot));
  const ciphertextBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    encryptionKey,
    plaintext
  );

  return {
    format: BACKUP_FORMAT,
    version: BACKUP_SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    alg: BACKUP_ALG,
    kdf: BACKUP_KDF,
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertextBuffer)),
  };
}

/**
 * Open and decrypt an encrypted envelope using the recovery code.
 * Returns { ok: true, snapshot } or { ok: false, code }.
 */
export async function openBackup(envelope, recoveryCode) {
  if (!isBackupEnvelope(envelope)) {
    return { ok: false, code: 'backup_invalid_format' };
  }

  if (envelope.alg !== BACKUP_ALG || envelope.kdf !== BACKUP_KDF) {
    return { ok: false, code: 'backup_invalid_format' };
  }

  if (typeof envelope.version !== 'number' || envelope.version > BACKUP_SCHEMA_VERSION) {
    return { ok: false, code: 'backup_unsupported_version' };
  }

  try {
    const iv = base64ToBytes(envelope.iv);
    const ciphertext = base64ToBytes(envelope.ciphertext);

    const { encryptionKey } = await deriveKeysFromCode(recoveryCode, {
      encryptionInfo: HKDF_BACKUP_ENCRYPT,
      keyIdInfo: HKDF_BACKUP_KEYID,
    });

    const plaintextBuffer = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      encryptionKey,
      ciphertext
    );

    const plaintext = textDecoder.decode(plaintextBuffer);
    const snapshot = JSON.parse(plaintext);
    return { ok: true, snapshot };
  } catch {
    return { ok: false, code: 'backup_decrypt_failed' };
  }
}

/**
 * Convenience wrapper serializing the sealed envelope to formatted JSON text.
 */
export async function sealBackupToText(snapshot, code) {
  const envelope = await sealBackup(snapshot, code);
  return JSON.stringify(envelope, null, 2);
}

/**
 * Convenience wrapper parsing and opening an encrypted envelope from JSON text.
 */
export async function openBackupFromText(text, code) {
  if (typeof text !== 'string') {
    return { ok: false, code: 'backup_invalid_format' };
  }

  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch {
    return { ok: false, code: 'backup_invalid_format' };
  }

  return openBackup(envelope, code);
}
