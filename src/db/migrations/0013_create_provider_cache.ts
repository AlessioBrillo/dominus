import type Database from 'better-sqlite3';
import { execPg } from '../pg-ddl.js';
import type { DatabaseProvider } from '../provider/interface.js';

export const name = '0013_create_provider_cache';

export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cache_key TEXT NOT NULL,
      provider_name TEXT NOT NULL,
      value TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL
    )
  `);
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_cache_lookup
      ON provider_cache(cache_key, provider_name)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_provider_cache_expires
      ON provider_cache(expires_at)
  `);
}

export async function upPg(db: DatabaseProvider): Promise<void> {
  await execPg(
    db,
    `
    CREATE TABLE IF NOT EXISTS provider_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cache_key TEXT NOT NULL,
      provider_name TEXT NOT NULL,
      value TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL
    )
  `,
  );
  await execPg(
    db,
    `
    CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_cache_lookup
      ON provider_cache(cache_key, provider_name)
  `,
  );
  await execPg(
    db,
    `
    CREATE INDEX IF NOT EXISTS idx_provider_cache_expires
      ON provider_cache(expires_at)
  `,
  );
}
