// SPDX-License-Identifier: AGPL-3.0-only
import type Database from 'better-sqlite3';
import { execPg } from '../pg-ddl.js';
import type { DatabaseProvider } from '../provider/interface.js';

export const name = '0049_add_team_plan';
export const backwardCompatible = true;

const TEAM_LIMITS_DDL = `
  INSERT OR IGNORE INTO plan_limits (plan, feature, limit_value) VALUES
    ('team', 'candidates_scored', 2500),
    ('team', 'api_calls', 50000),
    ('team', 'domains_tracked', 1000)
`;

const TEAM_LIMITS_PG = `
  INSERT INTO plan_limits (plan, feature, limit_value) VALUES
    ('team', 'candidates_scored', 2500),
    ('team', 'api_calls', 50000),
    ('team', 'domains_tracked', 1000)
  ON CONFLICT(plan, feature) DO NOTHING
`;

export const TEAM_SEATS_DDL = `
CREATE TABLE IF NOT EXISTS team_seats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  invited_by TEXT,
  invited_at TEXT NOT NULL DEFAULT (datetime('now')),
  joined_at TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  UNIQUE(tenant_id, user_id)
)
`;

export const TEAM_SEATS_PG = `
CREATE TABLE IF NOT EXISTS team_seats (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  invited_by TEXT,
  invited_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  joined_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'pending',
  UNIQUE(tenant_id, user_id)
)
`;

export function up(db: Database.Database): void {
  db.exec(TEAM_LIMITS_DDL);
  db.exec(TEAM_SEATS_DDL);
  db.exec('CREATE INDEX IF NOT EXISTS idx_team_seats_tenant ON team_seats(tenant_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_team_seats_user ON team_seats(user_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_team_seats_status ON team_seats(status)');
}

export async function upPg(db: DatabaseProvider): Promise<void> {
  await execPg(db, TEAM_LIMITS_PG);
  await execPg(db, TEAM_SEATS_PG);
  await execPg(db, 'CREATE INDEX IF NOT EXISTS idx_team_seats_tenant ON team_seats(tenant_id)');
  await execPg(db, 'CREATE INDEX IF NOT EXISTS idx_team_seats_user ON team_seats(user_id)');
  await execPg(db, 'CREATE INDEX IF NOT EXISTS idx_team_seats_status ON team_seats(status)');
}

export function down(db: Database.Database): void {
  db.exec("DELETE FROM plan_limits WHERE plan = 'team'");
  db.exec('DROP TABLE IF EXISTS team_seats');
}
