import type Database from 'better-sqlite3';
import type { DatabaseProvider } from '../provider/interface.js';

export const name = '0016_add_backtest_costs';

export function up(db: Database.Database): void {
  const columns = db.prepare("SELECT name FROM pragma_table_info('backtest_signals')").all() as {
    name: string;
  }[];
  const existing = new Set(columns.map((c) => c.name));

  if (!existing.has('acquisition_cost_eur')) {
    db.exec(`
      ALTER TABLE backtest_signals
      ADD COLUMN acquisition_cost_eur REAL NOT NULL DEFAULT 0
    `);
  }
  if (!existing.has('total_renewal_cost_paid_eur')) {
    db.exec(`
      ALTER TABLE backtest_signals
      ADD COLUMN total_renewal_cost_paid_eur REAL NOT NULL DEFAULT 0
    `);
  }
}

export async function upPg(_db: DatabaseProvider): Promise<void> {
  // PG schema already has these columns from creation
}
