// SPDX-License-Identifier: AGPL-3.0-only
import type Database from 'better-sqlite3';
import type { DatabaseProvider } from '../provider/interface.js';

export const name = '0053_create_pitr_health';
export const backwardCompatible = true;

/**
 * PITR manifest (ADR-0054): one row per completed base backup, written by
 * deploy/postgres/base-backup.sh on the db node and read by the app's
 * pitr-health scheduler job.
 *
 * Before this migration the app inferred the newest base backup from the
 * BACKUP_DIR filesystem, which couples the app container to the db node's
 * local backup directory. The manifest moves the source of truth into the
 * database: the scheduler reads the newest finished_at from here instead.
 *
 * PG-only: the SQLite community edition has no PITR, so no table is
 * created there (up() is a no-op). The app role runs migrations and owns
 * the table; explicit grants are given to the `dominus` owner role so the
 * backup script (psql as dominus) can insert rows. The grant is wrapped in
 * a role-existence check because community deployments may not create the
 * `dominus` role.
 */
const DDL = `CREATE TABLE IF NOT EXISTS pitr_health (
  id SERIAL PRIMARY KEY,
  finished_at TIMESTAMPTZ NOT NULL,
  base_name TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  host TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pitr_health_finished_at
  ON pitr_health (finished_at DESC);
DO $pitr_manifest$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'dominus') THEN
    GRANT SELECT, INSERT, DELETE ON pitr_health TO dominus;
    GRANT USAGE, SELECT ON SEQUENCE pitr_health_id_seq TO dominus;
  END IF;
END
$pitr_manifest$;`;

export function up(_db: Database.Database): void {
  // SQLite has no point-in-time recovery; this is a PG-only manifest.
}

export function down(_db: Database.Database): void {
  // No-op
}

export async function upPg(db: DatabaseProvider): Promise<void> {
  await db.exec(DDL);
}
