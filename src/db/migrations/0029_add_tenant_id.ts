import type Database from 'better-sqlite3';
import type { DatabaseProvider } from '../provider/interface.js';

export const name = '0029_add_tenant_id';

const ENTITY_TABLES = [
  'candidates',
  'scoring_runs',
  'portfolio_entries',
  'trademark_results',
  'outcomes',
  'outcome_scores',
  'watchlist_entries',
  'listings',
  'bids',
  'renewal_alerts',
  'public_scores',
  'auto_listings',
  'events',
  'onboarding_state',
] as const;

export function up(db: Database.Database): void {
  for (const table of ENTITY_TABLES) {
    const columns = db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as {
      name: string;
    }[];
    if (!columns.some((c) => c.name === 'tenant_id')) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default'`);
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_tenant ON ${table}(tenant_id)`);
  }
}

export async function upPg(db: DatabaseProvider): Promise<void> {
  const entityTables = [
    'candidates',
    'scoring_runs',
    'portfolio_entries',
    'trademark_results',
    'outcomes',
    'outcome_scores',
    'watchlist_entries',
    'listings',
    'bids',
    'renewal_alerts',
    'public_scores',
    'auto_listings',
    'events',
    'onboarding_state',
  ];
  for (const table of entityTables) {
    const col = await db.queryOne<{ exists: number }>(
      `SELECT 1 as exists FROM information_schema.columns WHERE table_name = '${table}' AND column_name = 'tenant_id'`,
    );
    if (!col?.exists) {
      await db.exec(`ALTER TABLE ${table} ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default'`);
    }
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_tenant ON ${table}(tenant_id)`);
  }
}

export function down(db: Database.Database): void {
  for (const table of ENTITY_TABLES) {
    db.exec(`DROP INDEX IF EXISTS idx_${table}_tenant`);
    db.exec(`ALTER TABLE ${table} DROP COLUMN tenant_id`);
  }
}
