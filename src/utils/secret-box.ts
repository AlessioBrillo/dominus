// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Authenticated encryption for secrets that belong to a tenant.
 *
 * The format is the one the credential vault already uses, so a secret
 * encrypted here and one encrypted by the vault share the same envelope:
 *
 *   base64( salt(16) || nonce(12) || ciphertext || tag(16) )
 *
 * The salt is used with scrypt to derive a per-secret data-encryption key
 * from the operator's master key. AES-256-GCM provides authenticated
 * encryption: tampered ciphertext fails decryption before any plaintext is
 * ever returned.
 *
 * The master key is never stored, never logged and never leaves the process.
 */
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  type BinaryLike,
} from 'node:crypto';

const SALT_LENGTH = 16;
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;
const SCRYPT_KEY_LENGTH = 32;
const SCRYPT_COST = 16384;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLEL = 1;

export interface SecretBox {
  /** base64(salt || nonce || ciphertext || tag) */
  encrypt(plaintext: string): string;
  /** Throws when the ciphertext is malformed or the key is wrong. */
  decrypt(encoded: string): string;
}

function deriveKey(masterKey: string, salt: Buffer): Buffer {
  return scryptSync(masterKey, salt, SCRYPT_KEY_LENGTH, {
    N: SCRYPT_COST,
    r: SCRYPT_BLOCK_SIZE,
    p: SCRYPT_PARALLEL,
  });
}

/**
 * A secret box over the operator master key. The same master key produces
 * the same format as the credential vault, so the two can be swapped freely.
 */
export function createSecretBox(masterKey: string): SecretBox {
  return {
    encrypt(plaintext: string): string {
      const salt = randomBytes(SALT_LENGTH);
      const derived = deriveKey(masterKey, salt);
      const nonce = randomBytes(NONCE_LENGTH);
      const cipher = createCipheriv('aes-256-gcm', derived, nonce);
      const encrypted = Buffer.concat([
        cipher.update(Buffer.from(plaintext, 'utf8')),
        cipher.final(),
      ]);
      const tag = cipher.getAuthTag();
      return Buffer.concat([salt, nonce, encrypted, tag]).toString('base64');
    },

    decrypt(encoded: string): string {
      const payload = Buffer.from(encoded, 'base64');
      if (payload.length < SALT_LENGTH + NONCE_LENGTH + TAG_LENGTH) {
        throw new Error('Malformed encrypted payload');
      }
      const salt = payload.subarray(0, SALT_LENGTH);
      const nonce = payload.subarray(SALT_LENGTH, SALT_LENGTH + NONCE_LENGTH);
      const tag = payload.subarray(payload.length - TAG_LENGTH);
      const ciphertext = payload.subarray(SALT_LENGTH + NONCE_LENGTH, payload.length - TAG_LENGTH);
      const derived = deriveKey(masterKey, salt);
      const decipher = createDecipheriv('aes-256-gcm', derived, nonce);
      decipher.setAuthTag(tag as BinaryLike);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    },
  };
}
