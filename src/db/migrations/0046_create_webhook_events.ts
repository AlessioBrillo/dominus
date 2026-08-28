// SPDX-License-Identifier: AGPL-3.0-only
import type Database from 'better-sqlite3';
import { execPg } from '../pg-ddl.js';
import type { DatabaseProvider } from '../provider/interface.js';

export const name = '0046_create_webhook_events';
export const backwardCompatible = true;

const WEBHOOK_EVENTS_DDL = `
CREATE TABLE IF NOT EXISTS webhook_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  processed_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(provider, event_id)
)
`;

export function up(db: Database.Database): void {
  db.exec(WEBHOOK_EVENTS_DDL);
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_webhook_events_provider_processed ON webhook_events(provider, processed_at)',
  );
}

export async function upPg(db: DatabaseProvider): Promise<void> {
  await execPg(db, WEBHOOK_EVENTS_DDL);
  await execPg(
    db,
    'CREATE INDEX IF NOT EXISTS idx_webhook_events_provider_processed ON webhook_events(provider, processed_at)',
  );
}

export function down(db: Database.Database): void {
  db.exec('DROP TABLE IF EXISTS webhook_events');
}
