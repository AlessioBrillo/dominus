import type Database from 'better-sqlite3';

export const name = '0011_rename_weights_snapshot';

export function up(db: Database.Database): void {
  db.exec(`ALTER TABLE scoring_runs RENAME COLUMN weights_snapshot TO signal_scores`);
}
