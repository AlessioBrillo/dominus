// SPDX-License-Identifier: AGPL-3.0-only
import type Database from 'better-sqlite3';
import type { DatabaseProvider } from '../provider/interface.js';

export const name = '0056_add_candidate_verdict_provenance';
export const backwardCompatible = true;

/**
 * candidates.verdict_provenance: JSON-serialized VerdictProvenance chain
 * (DNS/RDAP/Trademark audit trail, see src/types/domain-status.ts).
 * Nullable and additive: a previous-image rollback simply never reads the
 * column, and existing rows read back as NULL / undefined.
 */
export function up(db: Database.Database): void {
  const cols = db.prepare(`PRAGMA table_info(candidates)`).all() as { name: string }[];
  if (!new Set(cols.map((c) => c.name)).has('verdict_provenance')) {
    db.exec(`ALTER TABLE candidates ADD COLUMN verdict_provenance TEXT`);
  }
}

export async function upPg(db: DatabaseProvider): Promise<void> {
  const cols = await db.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'candidates'`,
  );
  if (!new Set(cols.map((c) => c.column_name)).has('verdict_provenance')) {
    await db.exec(`ALTER TABLE candidates ADD COLUMN verdict_provenance TEXT`);
  }
}

export function down(): void {}
