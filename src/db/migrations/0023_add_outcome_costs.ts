import type Database from 'better-sqlite3';

export const name = '0023_add_outcome_costs';

export function up(db: Database.Database): void {
  const columns = db.prepare("SELECT name FROM pragma_table_info('outcomes')").all() as {
    name: string;
  }[];
  const existing = new Set(columns.map((c) => c.name));

  if (!existing.has('acquisition_cost_eur')) {
    db.exec(`
      ALTER TABLE outcomes
      ADD COLUMN acquisition_cost_eur REAL
    `);
  }
  if (!existing.has('total_renewal_cost_eur')) {
    db.exec(`
      ALTER TABLE outcomes
      ADD COLUMN total_renewal_cost_eur REAL
    `);
  }
}

export function down(_db: Database.Database): void {
  // SQLite does not support DROP COLUMN before 3.35.0.
  // We document that rollback requires restore-from-backup.
}
