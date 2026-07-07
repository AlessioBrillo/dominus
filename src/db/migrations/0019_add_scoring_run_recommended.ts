import type Database from 'better-sqlite3';
import type { DatabaseProvider } from '../provider/interface.js';

export const name = '0019_add_scoring_run_recommended';

export function up(db: Database.Database): void {
  const cols = (db.pragma('table_info(scoring_runs)') as Array<{ name: string }>).map(
    (c) => c.name,
  );

  if (!cols.includes('weighted_score')) {
    db.exec(`ALTER TABLE scoring_runs ADD COLUMN weighted_score REAL NOT NULL DEFAULT 0`);
  }
  if (!cols.includes('recommended')) {
    db.exec(`ALTER TABLE scoring_runs ADD COLUMN recommended INTEGER NOT NULL DEFAULT 0`);
  }
}

export async function upPg(_db: DatabaseProvider): Promise<void> {
  // PG schema already has these columns from creation
}
