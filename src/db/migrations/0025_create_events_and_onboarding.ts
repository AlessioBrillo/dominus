import type Database from 'better-sqlite3';

export const name = '0025_create_events_and_onboarding';

export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id   TEXT    NOT NULL DEFAULT 'default',
      anon_id     TEXT,
      type        TEXT    NOT NULL,
      props       TEXT,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_events_type
      ON events(type, created_at)
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_events_tenant
      ON events(tenant_id, created_at DESC)
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS onboarding_state (
      tenant_id      TEXT    NOT NULL PRIMARY KEY DEFAULT 'default',
      current_step   TEXT    NOT NULL DEFAULT 'welcome',
      step_data      TEXT,
      completed_at   TEXT,
      created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at     TEXT    NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

export function down(db: Database.Database): void {
  db.exec(`DROP INDEX IF EXISTS idx_events_tenant`);
  db.exec(`DROP INDEX IF EXISTS idx_events_type`);
  db.exec(`DROP TABLE IF EXISTS events`);
  db.exec(`DROP TABLE IF EXISTS onboarding_state`);
}
