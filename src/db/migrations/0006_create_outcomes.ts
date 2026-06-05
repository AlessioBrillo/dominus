import type Database from 'better-sqlite3';
import { OUTCOMES_DDL, OUTCOMES_INDEX_DDL, OUTCOMES_TYPE_INDEX_DDL } from '../schema.js';

/**
 * Real-world outcomes for portfolio domains. The `type` column is a free
 * TEXT (validated at the application boundary) so the taxonomy can evolve
 * without a migration. The future weight-retraining loop will read this
 * table to compare predictions against realised events.
 *
 * Forward-only: no backfill. Safe on existing databases because we only
 * create a new table + two indexes.
 */

export const name = '0006_create_outcomes';

export function up(db: Database.Database): void {
  db.exec(OUTCOMES_DDL);
  db.exec(OUTCOMES_INDEX_DDL);
  db.exec(OUTCOMES_TYPE_INDEX_DDL);
}
