// SPDX-License-Identifier: AGPL-3.0-only
import type Database from 'better-sqlite3';
import type { DatabaseProvider } from '../provider/interface.js';

export const name = '0066_create_tenant_credentials';
export const backwardCompatible = true;

/**
 * Tenant credential vault (ADR-0085).
 *
 * One row per (tenant_id, provider_type, provider_name). The secret is
 * never stored plaintext — `encrypted_credential` holds
 * base64(salt || nonce || ciphertext || tag) produced by
 * CredentialVaultService (AES-256-GCM over a scrypt-derived key from
 * VAULT_ENCRYPTION_KEY).
 *
 * Control-plane table: tenant isolation is repository-enforced through
 * resolveTenantId(), like tenant_automation_settings (0063) and
 * tenant_listing_settings (0065). Not covered by FORCE ROW LEVEL SECURITY.
 */
const DDL_SQLITE = `
CREATE TABLE IF NOT EXISTS tenant_credentials (
  tenant_id TEXT NOT NULL,
  provider_type TEXT NOT NULL CHECK(provider_type IN ('registrar','parking','adsense','gsc','marketplace')),
  provider_name TEXT NOT NULL,
  encrypted_credential TEXT NOT NULL,
  account_id TEXT,
  credential_scope TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tenant_id, provider_type, provider_name)
)
`;

const DDL_PG = `
CREATE TABLE IF NOT EXISTS tenant_credentials (
  tenant_id TEXT NOT NULL,
  provider_type TEXT NOT NULL CHECK(provider_type IN ('registrar','parking','adsense','gsc','marketplace')),
  provider_name TEXT NOT NULL,
  encrypted_credential TEXT NOT NULL,
  account_id TEXT,
  credential_scope TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, provider_type, provider_name)
)
`;

const INDEX_SQLITE =
  'CREATE INDEX IF NOT EXISTS idx_tenant_credentials_provider ON tenant_credentials(provider_type, provider_name)';

const INDEX_PG =
  'CREATE INDEX IF NOT EXISTS idx_tenant_credentials_provider ON tenant_credentials(provider_type, provider_name)';

export function up(db: Database.Database): void {
  db.exec(DDL_SQLITE);
  db.exec(INDEX_SQLITE);
}

export async function upPg(db: DatabaseProvider): Promise<void> {
  await db.exec(DDL_PG);
  await db.exec(INDEX_PG);
}

export function down(db: Database.Database): void {
  db.exec('DROP TABLE IF EXISTS tenant_credentials');
}
