import type Database from 'better-sqlite3';

export const name = '0035_fix_wayback_cache_divergence';

export function up(db: Database.Database): void {
  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='wayback_cache'`)
    .pluck()
    .all() as string[];
  if (tables.length === 0) return;

  const cols = db.prepare(`PRAGMA table_info(wayback_cache)`).all() as { name: string }[];
  const colNames = new Set(cols.map((c) => c.name));

  if (!colNames.has('cached_json')) {
    db.exec(`ALTER TABLE wayback_cache ADD COLUMN cached_json TEXT`);
  }
}

export function down(): void {}
