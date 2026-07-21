import type Database from 'better-sqlite3';
import { execPg } from '../pg-ddl.js';
import type { DatabaseProvider } from '../provider/interface.js';

export const name = '0041_create_funnel_entries';

export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS funnel_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      domain TEXT NOT NULL,
      tld TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT '',
      priority_score REAL NOT NULL,
      budget_allocation_eur REAL NOT NULL,
      expected_return_eur REAL NOT NULL,
      expected_value REAL NOT NULL,
      confidence REAL NOT NULL,
      suggested_buy_max REAL NOT NULL,
      suggested_list_price REAL NOT NULL,
      trademark_clear INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      tenant_id TEXT NOT NULL DEFAULT 'default'
    )
  `);
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_funnel_entries_run_domain
      ON funnel_entries(run_id, domain)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_funnel_entries_run
      ON funnel_entries(run_id)
  `);
}

export async function upPg(db: DatabaseProvider): Promise<void> {
  await execPg(
    db,
    `
    CREATE TABLE IF NOT EXISTS funnel_entries (
      id BIGSERIAL PRIMARY KEY,
      run_id TEXT NOT NULL,
      domain TEXT NOT NULL,
      tld TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT '',
      priority_score DOUBLE PRECISION NOT NULL,
      budget_allocation_eur DOUBLE PRECISION NOT NULL,
      expected_return_eur DOUBLE PRECISION NOT NULL,
      expected_value DOUBLE PRECISION NOT NULL,
      confidence DOUBLE PRECISION NOT NULL,
      suggested_buy_max DOUBLE PRECISION NOT NULL,
      suggested_list_price DOUBLE PRECISION NOT NULL,
      trademark_clear INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      tenant_id TEXT NOT NULL DEFAULT 'default'
    )
  `,
  );
  await execPg(
    db,
    `
    CREATE UNIQUE INDEX IF NOT EXISTS idx_funnel_entries_run_domain
      ON funnel_entries(run_id, domain)
  `,
  );
  await execPg(
    db,
    `
    CREATE INDEX IF NOT EXISTS idx_funnel_entries_run
      ON funnel_entries(run_id)
  `,
  );
}
