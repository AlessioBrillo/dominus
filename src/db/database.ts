import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { getLogger } from '../logger.js';
import { SqliteProvider } from './provider/sqlite-adapter.js';
import type { DatabaseProvider } from './provider/interface.js';

const logger = getLogger();

let _db: Database.Database | null = null;
let _refCount = 0;
let _currentPath: string | null = null;

/**
 * Dedicated connection for long-running bulk operations (pipeline, backup).
 * Managed via acquireBulkWriteConnection / releaseBulkWriteConnection.
 * The corresponding SqliteProvider wrapper is created by
 * createBulkWriteDatabaseProvider() and must be closed by the caller.
 */
let _bulkDb: Database.Database | null = null;
let _bulkRefCount = 0;

export function openDatabase(path: string, busyTimeout: number = 30000): Database.Database {
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
  _db.pragma(`busy_timeout = ${busyTimeout}`);
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
  releaseBulkWriteConnection();
}

export function forceReopen(path?: string): Database.Database {
  closeDatabase();
  return openDatabase(path ?? _currentPath ?? './data/dominus.db');
}

/**
 * Acquire a dedicated write connection for long-running bulk operations.
 * WAL mode allows concurrent readers on the main connection while a bulk
 * write transaction runs on this dedicated connection. Callers MUST
 * {@link releaseBulkWriteConnection} when done.
 */
export function acquireBulkWriteConnection(
  path?: string,
  busyTimeout: number = 60000,
): Database.Database {
  if (_bulkDb !== null) {
    _bulkRefCount++;
    return _bulkDb;
  }

  const dbPath = path ?? _currentPath ?? './data/dominus.db';
  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  _bulkDb = new Database(dbPath);
  _bulkDb.pragma('journal_mode = WAL');
  _bulkDb.pragma('foreign_keys = ON');
  _bulkDb.pragma(`busy_timeout = ${busyTimeout}`);

  logger.info({ dbPath }, 'Acquired bulk-write database connection');
  _bulkRefCount = 1;
  return _bulkDb;
}

/**
 * Release a dedicated bulk-write connection acquired via
 * {@link acquireBulkWriteConnection}. Safe to call multiple times.
 */
export function releaseBulkWriteConnection(): void {
  if (_bulkDb !== null) {
    _bulkRefCount--;
    if (_bulkRefCount <= 0) {
      _bulkDb.close();
      _bulkDb = null;
      _bulkRefCount = 0;
      logger.info('Released bulk-write database connection');
    }
  }
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

/**
 * Returns a DatabaseProvider wrapping the active database connection.
 * Creates the connection first if it hasn't been opened yet.
 */
export function getDatabaseProvider(): DatabaseProvider {
  if (_db === null) {
    openDatabase(_currentPath ?? './data/dominus.db');
  }
  return new SqliteProvider(_db!);
}

/**
 * Create (or reuse) a dedicated SqliteProvider on a separate SQLite connection
 * for long-running bulk writes. Uses a short busy_timeout (5s) to fail fast
 * on contention. The caller is responsible for calling close() on the returned
 * provider when the application shuts down.
 *
 * WAL mode is active on both connections so the main connection continues to
 * serve reads while a bulk-write transaction runs on this dedicated connection.
 * In PostgreSQL mode (DATABASE_URL set), the pool handles connection management
 * internally and this function returns undefined.
 */
export function createBulkWriteDatabaseProvider(
  path?: string,
  busyTimeout: number = 5000,
): SqliteProvider | undefined {
  if (_currentPath === null && path === undefined) return undefined;
  const dbPath = path ?? _currentPath!;
  return SqliteProvider.createBulkWrite(dbPath, { busyTimeout });
}
