// SPDX-License-Identifier: AGPL-3.0-only
import type Database from 'better-sqlite3';
import { execPg } from '../pg-ddl.js';
import type { DatabaseProvider } from '../provider/interface.js';

export const name = '0045_create_usage_metering';
export const backwardCompatible = true;

const USAGE_RECORDS_DDL = `
CREATE TABLE IF NOT EXISTS usage_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  feature TEXT NOT NULL,
  amount INTEGER NOT NULL DEFAULT 0,
  period_start TEXT NOT NULL,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(tenant_id, feature, period_start)
)
`;

const PLAN_LIMITS_DDL = `
CREATE TABLE IF NOT EXISTS plan_limits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan TEXT NOT NULL,
  feature TEXT NOT NULL,
  limit_value INTEGER,
  UNIQUE(plan, feature)
)
`;

export function up(db: Database.Database): void {
  db.exec(USAGE_RECORDS_DDL);
  db.exec(PLAN_LIMITS_DDL);
  db.exec('CREATE INDEX IF NOT EXISTS idx_usage_records_tenant ON usage_records(tenant_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_usage_records_period ON usage_records(period_start)');

  db.exec(`
    INSERT OR IGNORE INTO plan_limits (plan, feature, limit_value) VALUES
      ('free', 'candidates_scored', 50),
      ('free', 'api_calls', 1000),
      ('free', 'domains_tracked', 25),
      ('pro', 'candidates_scored', 500),
      ('pro', 'api_calls', 10000),
      ('pro', 'domains_tracked', 250),
      ('enterprise', 'candidates_scored', NULL),
      ('enterprise', 'api_calls', NULL),
      ('enterprise', 'domains_tracked', NULL)
  `);
}

export async function upPg(db: DatabaseProvider): Promise<void> {
  await execPg(db, USAGE_RECORDS_DDL);
  await execPg(db, PLAN_LIMITS_DDL);
  await execPg(
    db,
    'CREATE INDEX IF NOT EXISTS idx_usage_records_tenant ON usage_records(tenant_id)',
  );
  await execPg(
    db,
    'CREATE INDEX IF NOT EXISTS idx_usage_records_period ON usage_records(period_start)',
  );

  await execPg(
    db,
    `INSERT INTO plan_limits (plan, feature, limit_value) VALUES
      ('free', 'candidates_scored', 50),
      ('free', 'api_calls', 1000),
      ('free', 'domains_tracked', 25),
      ('pro', 'candidates_scored', 500),
      ('pro', 'api_calls', 10000),
      ('pro', 'domains_tracked', 250),
      ('enterprise', 'candidates_scored', NULL),
      ('enterprise', 'api_calls', NULL),
      ('enterprise', 'domains_tracked', NULL)
    ON CONFLICT(plan, feature) DO NOTHING`,
  );
}

export function down(db: Database.Database): void {
  db.exec('DROP TABLE IF EXISTS usage_records');
  db.exec('DROP TABLE IF EXISTS plan_limits');
}
