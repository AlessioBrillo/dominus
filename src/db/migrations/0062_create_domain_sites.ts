// SPDX-License-Identifier: AGPL-3.0-only
import type Database from 'better-sqlite3';
import type { DatabaseProvider } from '../provider/interface.js';

export const name = '0062_create_domain_sites';
export const backwardCompatible = true;

/**
 * Published for-sale pages (ADR-0083, M2).
 *
 * One row per domain, written by the `site` step of the post-acquisition
 * pipeline. Reads from the public namespace are deliberately tenant-agnostic
 * (the same pattern as public_scores): a published page is, by definition,
 * content the operator chose to make public. Writes stay tenant-scoped.
 */
const SQLITE_DDL = `
CREATE TABLE IF NOT EXISTS domain_sites (
  domain TEXT PRIMARY KEY,
  headline TEXT NOT NULL,
  summary TEXT NOT NULL,
  asking_price_eur REAL,
  score_json TEXT NOT NULL,
  contact TEXT,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  published_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)
`;

const PG_DDL = `
CREATE TABLE IF NOT EXISTS domain_sites (
  domain TEXT PRIMARY KEY,
  headline TEXT NOT NULL,
  summary TEXT NOT NULL,
  asking_price_eur REAL,
  score_json TEXT NOT NULL,
  contact TEXT,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)
`;

const INDEX_DDL =
  'CREATE INDEX IF NOT EXISTS idx_domain_sites_published_at ON domain_sites(published_at)';

export function up(db: Database.Database): void {
  db.exec(SQLITE_DDL);
  db.exec(INDEX_DDL);
}

export async function upPg(db: DatabaseProvider): Promise<void> {
  await db.exec(PG_DDL);
  await db.exec(INDEX_DDL);
}

export function down(db: Database.Database): void {
  db.exec('DROP TABLE IF EXISTS domain_sites');
}
