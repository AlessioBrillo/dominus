// SPDX-License-Identifier: AGPL-3.0-only
import {
  createDecipheriv,
  createCipheriv,
  randomBytes,
  scryptSync,
  type BinaryLike,
} from 'node:crypto';
import type { TenantCredentialRepository } from '../db/repositories/tenant-credential-repository.js';
import type {
  CredentialVault,
  NewTenantCredential,
  TenantCredentialView,
} from '../types/tenant-credential.js';
import { VaultDecryptionError, VaultNotConfiguredError } from '../types/tenant-credential.js';
import { getLogger } from '../logger.js';

const logger = getLogger();

const VAULT_KEY_ENV = 'VAULT_ENCRYPTION_KEY';
const SALT_LENGTH = 16;
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;
const SCRYPT_KEY_LENGTH = 32;
const SCRYPT_COST = 16384;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLEL = 1;

/**
 * Encrypted credential storage format (base64):
 *
 *   base64( salt(16) || nonce(12) || ciphertext || tag(16) )
 *
 * The salt is used with scrypt to derive a per-row data-encryption key from
 * the operator's VAULT_ENCRYPTION_KEY. AES-256-GCM provides authenticated
 * encryption: tampered ciphertext fails decryption before any plaintext is
 * ever returned.
 */
export class CredentialVaultService implements CredentialVault {
  readonly #masterKey: Buffer | null;
  readonly #repo: TenantCredentialRepository;
  readonly isConfigured: boolean;

  constructor(masterKey: string | undefined, repo: TenantCredentialRepository) {
    this.#repo = repo;
    if (masterKey === undefined || masterKey.length === 0) {
      this.#masterKey = null;
      this.isConfigured = false;
      logger.warn(
        { env: VAULT_KEY_ENV },
        'CredentialVaultService: VAULT_ENCRYPTION_KEY is not set — credential writes are refused, reads return null',
      );
      return;
    }
    this.#masterKey = Buffer.from(masterKey, 'utf8');
    this.isConfigured = true;
  }

  async set(input: NewTenantCredential): Promise<void> {
    if (!this.isConfigured || this.#masterKey === null) {
      throw new VaultNotConfiguredError();
    }

    const salt = randomBytes(SALT_LENGTH);
    const derived = scryptSync(this.#masterKey, salt, SCRYPT_KEY_LENGTH, {
      N: SCRYPT_COST,
      r: SCRYPT_BLOCK_SIZE,
      p: SCRYPT_PARALLEL,
    });

    const nonce = randomBytes(NONCE_LENGTH);
    const cipher = createCipheriv('aes-256-gcm', derived, nonce);
    const secretBuffer = Buffer.from(input.secret, 'utf8');
    const encrypted = Buffer.concat([cipher.update(secretBuffer), cipher.final()]);
    const tag = cipher.getAuthTag();

    const payload = Buffer.concat([salt, nonce, encrypted, tag]);
    const encoded = payload.toString('base64');

    await this.#repo.set(
      input.tenantId,
      input.providerType,
      input.providerName,
      encoded,
      input.accountId ?? null,
      input.credentialScope ?? null,
    );
  }

  async get(
    tenantId: string,
    providerType: 'registrar' | 'parking' | 'adsense' | 'gsc' | 'marketplace',
    providerName: string,
  ): Promise<string | null> {
    if (!this.isConfigured || this.#masterKey === null) {
      return null;
    }

    const row = await this.#repo.find(tenantId, providerType, providerName);
    if (row === null) return null;

    try {
      return this.#decrypt(row.encrypted_credential);
    } catch (err: unknown) {
      logger.warn(
        {
          tenantId,
          providerType,
          providerName,
          err: err instanceof Error ? err.message : String(err),
        },
        'CredentialVaultService: decryption failed — credential may have been encrypted with a different key',
      );
      throw new VaultDecryptionError({
        tenantId,
        providerType,
        providerName,
      });
    }
  }

  async clear(
    tenantId: string,
    providerType: 'registrar' | 'parking' | 'adsense' | 'gsc' | 'marketplace',
    providerName: string,
  ): Promise<boolean> {
    if (!this.isConfigured || this.#masterKey === null) {
      throw new VaultNotConfiguredError();
    }
    return this.#repo.delete(tenantId, providerType, providerName);
  }

  async list(tenantId: string): Promise<TenantCredentialView[]> {
    return this.#repo.list(tenantId);
  }

  #decrypt(encoded: string): string {
    const payload = Buffer.from(encoded, 'base64');
    if (payload.length < SALT_LENGTH + NONCE_LENGTH + TAG_LENGTH) {
      throw new VaultDecryptionError();
    }

    const salt = payload.subarray(0, SALT_LENGTH);
    const nonce = payload.subarray(SALT_LENGTH, SALT_LENGTH + NONCE_LENGTH);
    const tagStart = payload.length - TAG_LENGTH;
    const ciphertext = payload.subarray(SALT_LENGTH + NONCE_LENGTH, tagStart);
    const tag = payload.subarray(tagStart);

    const derived = scryptSync(this.#masterKey as Buffer, salt, SCRYPT_KEY_LENGTH, {
      N: SCRYPT_COST,
      r: SCRYPT_BLOCK_SIZE,
      p: SCRYPT_PARALLEL,
    });

    const decipher = createDecipheriv('aes-256-gcm', derived, nonce);
    decipher.setAuthTag(tag as BinaryLike);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('utf8');
  }
}

/**
 * No-op vault used when VAULT_ENCRYPTION_KEY is unset. Writes are refused
 * (fail-closed), reads return null. Providers degrade to their existing
 * env-based configuration (community edition, single-tenant).
 */
export class NoOpCredentialVault implements CredentialVault {
  readonly isConfigured = false;

  async set(): Promise<void> {
    throw new VaultNotConfiguredError();
  }

  async get(): Promise<string | null> {
    return null;
  }

  async clear(): Promise<boolean> {
    return false;
  }

  async list(): Promise<TenantCredentialView[]> {
    return [];
  }
}
