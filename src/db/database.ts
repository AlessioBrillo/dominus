import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

let _db: Database.Database | null = null;

export function openDatabase(path: string): Database.Database {
  if (_db !== null) return _db;

  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  _db = new Database(path);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  return _db;
}

export function closeDatabase(): void {
  if (_db !== null) {
    _db.close();
    _db = null;
  }
}
