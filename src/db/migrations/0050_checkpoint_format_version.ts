// SPDX-License-Identifier: AGPL-3.0-only
import type Database from 'better-sqlite3';
import type { DatabaseProvider } from '../provider/interface.js';

export const name = '0050_checkpoint_format_version';
export const backwardCompatible = true;

/**
 * Adds format_version to pipeline_checkpoints so a resumed run can detect
 * checkpoint rows written by an older binary (schema or payload drift) and
 * start fresh instead of replaying stale verdicts (see ADR-0037 hardening).
 */
export function up(db: Database.Database): void {
  const existing = db
    .prepare(
      "SELECT name FROM pragma_table_info('pipeline_checkpoints') WHERE name = 'format_version'",
    )
    .get();
  if (!existing) {
    db.exec(
      `ALTER TABLE pipeline_checkpoints ADD COLUMN format_version INTEGER NOT NULL DEFAULT 1`,
    );
  }
}

export async function upPg(db: DatabaseProvider): Promise<void> {
  const colExists = await db.queryOne<{ exists: number }>(
    `SELECT 1 as exists FROM information_schema.columns WHERE table_name = 'pipeline_checkpoints' AND column_name = 'format_version'`,
  );
  if (!colExists?.exists) {
    await db.exec(
      `ALTER TABLE pipeline_checkpoints ADD COLUMN format_version INTEGER NOT NULL DEFAULT 1`,
    );
  }
}

export function down(_db: Database.Database): void {
  // SQLite does not support DROP COLUMN; the column is left in place.
}
