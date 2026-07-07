import type Database from 'better-sqlite3';
import { execPg } from '../pg-ddl.js';
import type { DatabaseProvider } from '../provider/interface.js';

const RENEWAL_ALERTS_DDL = `
CREATE TABLE IF NOT EXISTS renewal_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL,
  portfolio_entry_id INTEGER NOT NULL REFERENCES portfolio_entries(id) ON DELETE CASCADE,
  alert_type TEXT NOT NULL
    CHECK(alert_type IN ('renewal_imminent','renewal_critical','renewal_past_due','score_dropped')),
  severity TEXT NOT NULL
    CHECK(severity IN ('info','warning','critical')),
  message TEXT NOT NULL,
  details TEXT,
  acknowledged_at TEXT,
  notified_channels TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)
`;

const RENEWAL_ALERTS_DOMAIN_IDX_DDL = `
CREATE INDEX IF NOT EXISTS idx_renewal_alerts_domain
  ON renewal_alerts(domain)
`;

const RENEWAL_ALERTS_UNACK_IDX_DDL = `
CREATE INDEX IF NOT EXISTS idx_renewal_alerts_unack
  ON renewal_alerts(acknowledged_at)
`;

const RENEWAL_ALERTS_UNIQUE_DDL = `
CREATE UNIQUE INDEX IF NOT EXISTS uq_renewal_alerts_domain_type
  ON renewal_alerts(domain, alert_type)
`;

export const name = '0009_create_renewal_alerts';

export function up(db: Database.Database): void {
  db.exec(RENEWAL_ALERTS_DDL);
  db.exec(RENEWAL_ALERTS_DOMAIN_IDX_DDL);
  db.exec(RENEWAL_ALERTS_UNACK_IDX_DDL);
  db.exec(RENEWAL_ALERTS_UNIQUE_DDL);
}

export async function upPg(db: DatabaseProvider): Promise<void> {
  await execPg(db, RENEWAL_ALERTS_DDL);
  await execPg(db, RENEWAL_ALERTS_DOMAIN_IDX_DDL);
  await execPg(db, RENEWAL_ALERTS_UNACK_IDX_DDL);
  await execPg(db, RENEWAL_ALERTS_UNIQUE_DDL);
}
