import type Database from 'better-sqlite3';
import type { DatabaseProvider } from '../provider/interface.js';

export const name = '0035_fix_wayback_cache_divergence';

export async function upPg(db: DatabaseProvider): Promise<void> {
  const wbExist = await db.queryOne<{ exists: number }>(
    `SELECT 1 as exists FROM information_schema.tables WHERE table_name = 'wayback_cache'`,
  );
  if (!wbExist?.exists) return;

  const cols = await db.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'wayback_cache'`,
  );
  const colNames = new Set(cols.map((c: { column_name: string }) => c.column_name));

  if (!colNames.has('cached_json')) {
    await db.exec(`ALTER TABLE wayback_cache ADD COLUMN cached_json TEXT`);
  }
}

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
