// SPDX-License-Identifier: AGPL-3.0-only
import type { TenantCredentialRepository } from '../db/repositories/tenant-credential-repository.js';
import type {
  CredentialVault,
  NewTenantCredential,
  TenantCredentialView,
} from '../types/tenant-credential.js';
import { VaultDecryptionError, VaultNotConfiguredError } from '../types/tenant-credential.js';
import { createSecretBox, type SecretBox } from '../utils/secret-box.js';
import { getLogger } from '../logger.js';

const logger = getLogger();

const VAULT_KEY_ENV = 'VAULT_ENCRYPTION_KEY';

/**
 * Encrypted credential storage format (base64):
 *
 *   base64( salt(16) || nonce(12) || ciphertext || tag(16) )
 *
 * The salt is used with scrypt to derive a per-row data-encryption key from
 * the operator's VAULT_ENCRYPTION_KEY. AES-256-GCM provides authenticated
 * encryption: tampered ciphertext fails decryption before any plaintext is
 * ever returned.
 *
 * The envelope is implemented by the shared secret box (src/utils/secret-box.ts),
 * so the vault and the per-tenant notification settings use one format and
 * one master key.
 */
export class CredentialVaultService implements CredentialVault {
  readonly #box: SecretBox | null;
  readonly #repo: TenantCredentialRepository;
  readonly isConfigured: boolean;

  constructor(masterKey: string | undefined, repo: TenantCredentialRepository) {
    this.#repo = repo;
    if (masterKey === undefined || masterKey.length === 0) {
      this.#box = null;
      this.isConfigured = false;
      logger.warn(
        { env: VAULT_KEY_ENV },
        'CredentialVaultService: VAULT_ENCRYPTION_KEY is not set — credential writes are refused, reads return null',
      );
      return;
    }
    this.#box = createSecretBox(masterKey);
    this.isConfigured = true;
  }

  async set(input: NewTenantCredential): Promise<void> {
    if (!this.isConfigured || this.#box === null) {
      throw new VaultNotConfiguredError();
    }

    const encoded = this.#box.encrypt(input.secret);

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
    if (!this.isConfigured || this.#box === null) {
      return null;
    }

    const row = await this.#repo.find(tenantId, providerType, providerName);
    if (row === null) return null;

    try {
      return this.#box.decrypt(row.encrypted_credential);
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
    if (!this.isConfigured || this.#box === null) {
      throw new VaultNotConfiguredError();
    }
    return this.#repo.delete(tenantId, providerType, providerName);
  }

  async list(tenantId: string): Promise<TenantCredentialView[]> {
    return this.#repo.list(tenantId);
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
