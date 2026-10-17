// SPDX-License-Identifier: AGPL-3.0-only
import type { DatabaseProvider } from '../provider/interface.js';
import type {
  TenantCredential,
  TenantCredentialRow,
  TenantCredentialView,
} from '../../types/tenant-credential.js';
import { type CredentialProviderType, tenantCredentialFromRow } from '../../types/tenant-credential.js';
import { resolveTenantId } from '../../utils/tenant-context.js';

/**
 * Per-tenant credential vault repository (ADR-0085).
 *
 * One row per (tenant_id, provider_type, provider_name). Every query filters
 * on resolveTenantId() — repository-enforced tenant isolation, same pattern
 * as tenant_automation_settings (0063) and tenant_listing_settings (0065).
 * Control-plane table: not covered by FORCE ROW LEVEL SECURITY, isolated by
 * the repository.
 */
export class TenantCredentialRepository {
  constructor(private readonly db: DatabaseProvider) {}

  /** Store (upsert) an encrypted credential for the current tenant. */
  async set(
    tenantId: string,
    providerType: CredentialProviderType,
    providerName: string,
    encryptedCredential: string,
    accountId: string | null,
    credentialScope: string | null,
  ): Promise<void> {
    await this.db.exec(
      `INSERT INTO tenant_credentials
        (tenant_id, provider_type, provider_name, encrypted_credential, account_id, credential_scope, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT (tenant_id, provider_type, provider_name) DO UPDATE SET
         encrypted_credential = excluded.encrypted_credential,
         account_id = excluded.account_id,
         credential_scope = excluded.credential_scope,
         updated_at = CURRENT_TIMESTAMP`,
      [tenantId, providerType, providerName, encryptedCredential, accountId, credentialScope],
    );
  }

  /** Fetch the encrypted credential row for the current tenant, or null. */
  async find(
    tenantId: string,
    providerType: CredentialProviderType,
    providerName: string,
  ): Promise<TenantCredentialRow | null> {
    const row = await this.db.queryOne<TenantCredentialRow>(
      `SELECT tenant_id, provider_type, provider_name, encrypted_credential, account_id, credential_scope, updated_at, created_at
        FROM tenant_credentials
       WHERE tenant_id = ? AND provider_type = ? AND provider_name = ?`,
      [tenantId, providerType, providerName],
    );
    return row;
  }

  /** Delete the credential row for the current tenant. Returns true when a row existed. */
  async delete(
    tenantId: string,
    providerType: CredentialProviderType,
    providerName: string,
  ): Promise<boolean> {
    const result = await this.db.exec(
      `DELETE FROM tenant_credentials
       WHERE tenant_id = ? AND provider_type = ? AND provider_name = ?`,
      [tenantId, providerType, providerName],
    );
    return (result.changes ?? 0) > 0;
  }

  /** List all configured credentials for the current tenant (metadata only, never the secret). */
  async list(tenantId: string): Promise<TenantCredentialView[]> {
    const rows = await this.db.query<TenantCredentialRow>(
      `SELECT provider_type, provider_name, account_id, credential_scope, updated_at, created_at
        FROM tenant_credentials
       WHERE tenant_id = ?
       ORDER BY provider_type, provider_name`,
      [tenantId],
    );
    return rows.map((row) => ({
      providerType: row.provider_type as CredentialProviderType,
      providerName: row.provider_name,
      accountId: row.account_id,
      credentialScope: row.credential_scope,
      updatedAt: row.updated_at,
      createdAt: row.created_at,
      configured: true,
    }));
  }

  /** Convert a raw row to a TenantCredential (for decryption by the vault service). */
  fromRow(row: TenantCredentialRow): TenantCredential {
    return tenantCredentialFromRow(row);
  }

  /** Resolve the effective tenant id (AsyncLocalStorage or 'default' fallback). */
  resolveTenantId(): string {
    return resolveTenantId();
  }
}
