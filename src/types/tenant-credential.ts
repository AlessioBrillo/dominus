// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Tenant credential vault types (ADR-0085).
 *
 * Credentials are stored encrypted at rest and decrypted in memory only for
 * the duration of a single provider call. The vault is provider-agnostic:
 * one table holds credentials for registrar, parking, adsense, gsc and any
 * future provider type. New providers add rows, not columns.
 */

export type CredentialProviderType = 'registrar' | 'parking' | 'adsense' | 'gsc' | 'marketplace';

export interface TenantCredential {
  tenantId: string;
  providerType: CredentialProviderType;
  providerName: string;
  /** Opaque vendor account identifier (e.g. Cloudflare account ID, AdSense publisher ID). Null when not applicable. */
  accountId: string | null;
  /** OAuth scope or API permission string, e.g. 'dns:edit', 'adsense:read'. Null when not applicable. */
  credentialScope: string | null;
  /** ISO-8601 timestamp when the credential was last set/rotated. */
  updatedAt: string;
  /** ISO-8601 timestamp when the credential row was created. */
  createdAt: string;
}

/** Input for creating or replacing a tenant credential. Plaintext only — never persisted. */
export interface NewTenantCredential {
  tenantId: string;
  providerType: CredentialProviderType;
  providerName: string;
  /** The secret value (API token, OAuth access/refresh token, etc.). Never logged, never stored plaintext. */
  secret: string;
  accountId?: string | null;
  credentialScope?: string | null;
}

/** Metadata-only view safe to return to the caller — never contains the secret. */
export interface TenantCredentialView {
  providerType: CredentialProviderType;
  providerName: string;
  accountId: string | null;
  credentialScope: string | null;
  updatedAt: string;
  createdAt: string;
  /** True when a credential is currently stored for this (tenant, provider). */
  configured: boolean;
}

/** Raw database row. `encryptedCredential` is base64( salt || nonce || tag || ciphertext ). */
export interface TenantCredentialRow {
  tenant_id: string;
  provider_type: string;
  provider_name: string;
  encrypted_credential: string;
  account_id: string | null;
  credential_scope: string | null;
  updated_at: string;
  created_at: string;
}

export function tenantCredentialFromRow(row: TenantCredentialRow): TenantCredential {
  return {
    tenantId: row.tenant_id,
    providerType: row.provider_type as CredentialProviderType,
    providerName: row.provider_name,
    accountId: row.account_id,
    credentialScope: row.credential_scope,
    updatedAt: row.updated_at,
    createdAt: row.created_at,
  };
}

/** Error thrown when the vault cannot encrypt/decrypt because no key is configured. */
export class VaultNotConfiguredError extends Error {
  readonly code = 'VAULT_NOT_CONFIGURED';
  constructor() {
    super(
      'Credential vault is not configured: set VAULT_ENCRYPTION_KEY to store per-tenant credentials',
    );
    this.name = 'VaultNotConfiguredError';
  }
}

/** Error thrown when ciphertext cannot be authenticated or decrypted (tampered or wrong key). */
export class VaultDecryptionError extends Error {
  readonly code = 'VAULT_DECRYPTION_FAILED';
  constructor(context?: Record<string, unknown>) {
    super(
      'Credential decryption failed: the stored credential may have been encrypted with a different key',
      { cause: undefined } as unknown as Error,
    );
    this.name = 'VaultDecryptionError';
    Object.assign(this, { code: 'VAULT_DECRYPTION_FAILED', context });
  }
}

/** Interface implemented by CredentialVaultService and the no-op fallback. */
export interface CredentialVault {
  /** Encrypt a plaintext secret and store it for (tenant, provider). Replaces any existing credential. */
  set(input: NewTenantCredential): Promise<void>;
  /** Decrypt and return the stored secret, or null when none is stored. */
  get(
    tenantId: string,
    providerType: CredentialProviderType,
    providerName: string,
  ): Promise<string | null>;
  /** Remove the stored credential for (tenant, provider). Returns true when a row was deleted. */
  clear(
    tenantId: string,
    providerType: CredentialProviderType,
    providerName: string,
  ): Promise<boolean>;
  /** Return metadata-only views for all configured credentials of a tenant. */
  list(tenantId: string): Promise<TenantCredentialView[]>;
  /** True when the vault has an encryption key and can store/retrieve credentials. */
  readonly isConfigured: boolean;
}
