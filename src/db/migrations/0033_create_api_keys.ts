import type Database from 'better-sqlite3';

export const name = '0033_create_api_keys';

export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id       TEXT    NOT NULL DEFAULT 'default',
      name            TEXT    NOT NULL,
      key_hash        TEXT    NOT NULL,
      key_prefix      TEXT    NOT NULL,
      role            TEXT    NOT NULL DEFAULT 'admin',
      expires_at      TEXT,
      last_used_at    TEXT,
      created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_api_keys_tenant ON api_keys(tenant_id)');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys(key_prefix)');
}

export function down(db: Database.Database): void {
  db.exec('DROP TABLE IF EXISTS api_keys');
}
