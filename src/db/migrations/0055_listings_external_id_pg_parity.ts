// SPDX-License-Identifier: AGPL-3.0-only
import type Database from 'better-sqlite3';
import type { DatabaseProvider } from '../provider/interface.js';

export const name = '0055_listings_external_id_pg_parity';
export const backwardCompatible = true;

/**
 * listings.external_id parity across backends.
 *
 * SQLite gained external_id via 0034 (idempotent ALTER TABLE), but the
 * PostgreSQL path never did — and no code read or wrote the column, so
 * remote marketplace ids were coerced with parseInt() into the local
 * primary key space (wrong linkage, duplicate remote creates).
 * This migration adds the column on PostgreSQL (no-op on SQLite where
 * 0034 already applied it) so ListingRepository can persist the remote
 * id separately from the local id. Purely additive: safe on rollback.
 */
export function up(db: Database.Database): void {
  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='listings'`)
    .pluck()
    .all() as string[];
  if (tables.length === 0) return;

  const cols = db.prepare(`PRAGMA table_info(listings)`).all() as { name: string }[];
  if (!new Set(cols.map((c) => c.name)).has('external_id')) {
    db.exec(`ALTER TABLE listings ADD COLUMN external_id TEXT`);
  }
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_listings_marketplace_external
      ON listings(marketplace, external_id)`,
  );
}

export async function upPg(db: DatabaseProvider): Promise<void> {
  const listingsExist = await db.queryOne<{ exists: number }>(
    `SELECT 1 as exists FROM information_schema.tables WHERE table_name = 'listings'`,
  );
  if (!listingsExist?.exists) return;

  const cols = await db.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'listings'`,
  );
  if (!new Set(cols.map((c: { column_name: string }) => c.column_name)).has('external_id')) {
    await db.exec(`ALTER TABLE listings ADD COLUMN external_id TEXT`);
  }
  await db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_listings_marketplace_external
      ON listings(marketplace, external_id)`,
  );
}

export function down(): void {}
