import type Database from 'better-sqlite3';

export const name = '0019_add_scoring_run_recommended';

export function up(db: Database.Database): void {
  db.exec(`
    ALTER TABLE scoring_runs
    ADD COLUMN weighted_score REAL NOT NULL DEFAULT 0
  `);
  db.exec(`
    ALTER TABLE scoring_runs
    ADD COLUMN recommended INTEGER NOT NULL DEFAULT 0
  `);
}
