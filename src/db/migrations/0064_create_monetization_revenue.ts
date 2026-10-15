// SPDX-License-Identifier: AGPL-3.0-only
import type Database from 'better-sqlite3';
import type { DatabaseProvider } from '../provider/interface.js';

export const name = '0064_create_monetization_revenue';
export const backwardCompatible = true;

/**
 * Ad-revenue records (ADR-0083, M3).
 *
 * One row per (domain, revenue date, source, tenant): the unique index
 * makes ingestion idempotent — a repeated fetch of the same day is an
 * UPDATE of the amount, never a duplicate. Revenue is a read: this table
 * only records what a monetization provider reported, and the carry-cost
 * verdict of M5 reads it.
 *
 * Tenant isolation is repository-enforced via resolveTenantId() like the
 * other post-1.0 tables.
 */
const DDL_SQLITE = `
CREATE TABLE IF NOT EXISTS monetization_revenue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL,
  revenue_date TEXT NOT NULL,
  amount_eur REAL NOT NULL,
  source TEXT NOT NULL,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
  tenant_id TEXT NOT NULL DEFAULT 'default',
  UNIQUE(domain, revenue_date, source, tenant_id)
)
`;

const DDL_PG = `
CREATE TABLE IF NOT EXISTS monetization_revenue (
  id SERIAL PRIMARY KEY,
  domain TEXT NOT NULL,
  revenue_date TEXT NOT NULL,
  amount_eur DOUBLE PRECISION NOT NULL,
  source TEXT NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  tenant_id TEXT NOT NULL DEFAULT 'default',
  UNIQUE(domain, revenue_date, source, tenant_id)
)
`;

const INDEX_SQLITE =
  'CREATE INDEX IF NOT EXISTS idx_monetization_revenue_domain_date ON monetization_revenue(domain, revenue_date)';

const INDEX_PG =
  'CREATE INDEX IF NOT EXISTS idx_monetization_revenue_domain_date ON monetization_revenue(domain, revenue_date)';

export function up(db: Database.Database): void {
  db.exec(DDL_SQLITE);
  db.exec(INDEX_SQLITE);
}

export async function upPg(db: DatabaseProvider): Promise<void> {
  await db.exec(DDL_PG);
  await db.exec(INDEX_PG);
}

export function down(db: Database.Database): void {
  db.exec('DROP TABLE IF EXISTS monetization_revenue');
}
