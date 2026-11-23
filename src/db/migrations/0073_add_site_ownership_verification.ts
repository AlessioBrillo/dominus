// SPDX-License-Identifier: AGPL-3.0-only
import type Database from 'better-sqlite3';
import type { DatabaseProvider } from '../provider/interface.js';

export const name = '0073_add_site_ownership_verification';
export const backwardCompatible = true;

/**
 * Proof of control for a published for-sale page.
 *
 * A portfolio entry is not evidence of title. Publication now requires the
 * seller to publish a DNS TXT record `_dominus.<domain>` containing a token
 * generated for that page. Only after the record is checked is the page
 * allowed to carry a structured Offer. The token is stored hashed.
 */
const SQLITE = [
  'ALTER TABLE domain_sites ADD COLUMN ownership_verified_at TEXT',
  'ALTER TABLE domain_sites ADD COLUMN ownership_token TEXT',
];
const PG = [
  'ALTER TABLE domain_sites ADD COLUMN IF NOT EXISTS ownership_verified_at TIMESTAMPTZ',
  'ALTER TABLE domain_sites ADD COLUMN IF NOT EXISTS ownership_token TEXT',
];

function hasColumn(db: Database.Database, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info('domain_sites')`).all() as Array<{ name: string }>;
  return columns.some((c) => c.name === column);
}

export function up(db: Database.Database): void {
  for (let i = 0; i < SQLITE.length; i++) {
    const column = i === 0 ? 'ownership_verified_at' : 'ownership_token';
    if (!hasColumn(db, column)) db.exec(SQLITE[i]!);
  }
}

export function down(_db: Database.Database): void {
  // The columns stay: dropping them is destructive and the previous image
  // ignores extra columns.
}

export async function upPg(db: DatabaseProvider): Promise<void> {
  for (const ddl of PG) await db.exec(ddl);
}
