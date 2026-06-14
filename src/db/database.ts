import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

let _db: Database.Database | null = null;
let _refCount = 0;
let _currentPath: string | null = null;

export function openDatabase(path: string): Database.Database {
  if (_db !== null) {
    _refCount++;
    return _db;
  }

  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  _db = new Database(path);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  _db.pragma('busy_timeout = 5000');
  _refCount = 1;
  _currentPath = resolve(path);
  return _db;
}

export function closeDatabase(): void {
  if (_db !== null) {
    _refCount--;
    if (_refCount <= 0) {
      _db.close();
      _db = null;
      _currentPath = null;
      _refCount = 0;
    }
  }
}

export function resetDatabase(): void {
  closeDatabase();
}

export function forceReopen(path?: string): Database.Database {
  closeDatabase();
  return openDatabase(path ?? _currentPath ?? './data/dominus.db');
}

/**
 * Inject a database instance for testing purposes.
 * Replaces the singleton with the given instance. The caller is responsible
 * for closing the injected instance.
 */
export function setDatabaseForTest(db: Database.Database): void {
  if (_db !== null && _db !== db) {
    _db.close();
  }
  _db = db;
  _refCount = 1;
  _currentPath = null;
}

/** Returns the currently active database instance, or null if none. */
export function getDatabase(): Database.Database | null {
  return _db;
}
