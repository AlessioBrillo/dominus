// SPDX-License-Identifier: AGPL-3.0-only
import type Database from 'better-sqlite3';
import type { DatabaseProvider } from '../provider/interface.js';

export const name = '0048_add_tenant_domain_composite_indexes';
export const backwardCompatible = true;

// Tables queried with `WHERE domain = ? AND tenant_id = ?` where `domain` is
// not UNIQUE (multiple rows per domain). The single-column domain and tenant
// indexes force PostgreSQL to scan via one of them and filter the other; the
// composite serves the multi-tenant lookup directly.
const COMPOSITE_INDEXES = [
  { table: 'outcomes', index: 'idx_outcomes_tenant_domain' },
  { table: 'bids', index: 'idx_bids_tenant_domain' },
  { table: 'auto_listings', index: 'idx_auto_listings_tenant_domain' },
  { table: 'renewal_alerts', index: 'idx_renewal_alerts_tenant_domain' },
] as const;

export function up(db: Database.Database): void {
  for (const { table, index } of COMPOSITE_INDEXES) {
    db.exec(`CREATE INDEX IF NOT EXISTS ${index} ON ${table}(tenant_id, domain)`);
  }
}

export function down(db: Database.Database): void {
  for (const { index } of COMPOSITE_INDEXES) {
    db.exec(`DROP INDEX IF EXISTS ${index}`);
  }
}

export async function upPg(db: DatabaseProvider): Promise<void> {
  for (const { table, index } of COMPOSITE_INDEXES) {
    await db.exec(`CREATE INDEX IF NOT EXISTS ${index} ON ${table}(tenant_id, domain)`);
  }
}
