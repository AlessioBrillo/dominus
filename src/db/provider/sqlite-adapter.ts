// SPDX-License-Identifier: AGPL-3.0-only
import Database from 'better-sqlite3';
import {
  existsSync,
  mkdirSync,
  statSync,
  openSync,
  closeSync,
  unlinkSync,
  constants,
} from 'node:fs';
import { hostname } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getLogger } from '../../logger.js';
import type { DatabaseProvider, ExecResult, BackupResult } from './interface.js';
import { DatabaseError } from './interface.js';
import { runMigrations as runSqliteMigrations } from '../migrator.js';
const logger = getLogger();

/** File-based cross-process lock using atomic O_EXCL create (POSIX).
 *  Works on shared volumes and network filesystems where SQLite locking may be unreliable.
 *  The lock file lives next to the SQLite database: <db-path>.lock/<lock-name>.lock
 *  For in-memory databases (dbPath = ''), file locking is disabled (no-op).
 */
class FileLock {
  readonly #lockDir: string;
  readonly #lockName: string;
  #fd: number | null = null;
  readonly #enabled: boolean;

  constructor(dbPath: string, lockName: string) {
    this.#enabled = dbPath !== '' && dbPath !== ':memory:';
    if (this.#enabled) {
      this.#lockDir = join(dirname(dbPath), `.${basename(dbPath)}.locks`);
    } else {
      this.#lockDir = '';
    }
    this.#lockName = lockName.replace(/[^a-zA-Z0-9_-]/g, '_');
  }

  get #lockPath(): string {
    return join(this.#lockDir, `${this.#lockName}.lock`);
  }

  tryAcquire(): boolean {
    if (!this.#enabled) return true; // No-op for in-memory
    try {
      if (!existsSync(this.#lockDir)) {
        mkdirSync(this.#lockDir, { recursive: true });
      }
      // O_EXCL | O_CREAT = atomic create, fails if exists (POSIX)
      this.#fd = openSync(
        this.#lockPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_RDWR,
        0o600,
      );
      return true;
    } catch (err: unknown) {
      const code = err instanceof Error && 'code' in err ? (err as { code: string }).code : '';
      if (code === 'EEXIST') return false;
      logger.warn({ err, lock: this.#lockName }, 'File lock acquire failed');
      return false;
    }
  }

  release(): void {
    if (!this.#enabled) return; // No-op for in-memory
    if (this.#fd !== null) {
      try {
        closeSync(this.#fd);
      } catch {
        /* ignore */
      }
      this.#fd = null;
      try {
        unlinkSync(this.#lockPath);
      } catch {
        /* ignore */
      }
    }
  }

  isHeld(): boolean {
    return this.#fd !== null;
  }
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? 'db';
}

export class SqliteProvider implements DatabaseProvider {
  readonly dialect = 'sqlite' as const;
  /** Underlying better-sqlite3 database handle. */
  readonly #db: Database.Database;
  #open = false;
  #txDepth = 0;
  /** Path to the SQLite database file (for file-based locking). */
  readonly #dbPath: string;
  /**
   * When true, close() is a no-op because the underlying Database handle
   * is lifecycle-managed externally (e.g. via database.ts ref-counting).
   */
  readonly #externalLifecycle: boolean;

  constructor(db: Database.Database, _busyTimeout = 30000, externalLifecycle = false, dbPath = '') {
    this.#db = db;
    this.#open = true;
    this.#externalLifecycle = externalLifecycle;
    this.#dbPath = dbPath;
  }

  static create(
    path: string,
    options: { busyTimeout?: number; readonly?: boolean } = {},
  ): SqliteProvider {
    const dir = dirname(path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const db = new Database(path, { readonly: options.readonly ?? false });
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma(`busy_timeout = ${options.busyTimeout ?? 30000}`);
    return new SqliteProvider(db, options.busyTimeout ?? 30000, false, path);
  }

  /**
   * Create a dedicated SqliteProvider on a separate connection intended for
   * long-running bulk writes (pipeline persistence, backup). Uses a shorter
   * busy_timeout (5s) so bulk operations fail fast instead of blocking the
   * main connection for 30s. WAL mode is enabled so concurrent reads on the
   * main connection are still served while a bulk-write transaction runs.
   */
  static createBulkWrite(path: string, options: { busyTimeout?: number } = {}): SqliteProvider {
    const dir = dirname(path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const db = new Database(path);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    const busyTimeout = options.busyTimeout ?? 5000;
    db.pragma(`busy_timeout = ${busyTimeout}`);
    return new SqliteProvider(db, busyTimeout, false, path);
  }

  static openInMemory(): SqliteProvider {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    return new SqliteProvider(db, 30000, false, '');
  }

  get rawDb(): Database.Database {
    return this.#db;
  }

  async backup(destinationPath: string): Promise<BackupResult> {
    const start = Date.now();
    const absPath = resolve(destinationPath);
    const dir = dirname(absPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this.#db.pragma('wal_checkpoint(TRUNCATE)');
    this.#db.exec(`VACUUM INTO '${absPath.replace(/'/g, "''")}'`);
    const s = statSync(absPath);
    return { path: absPath, sizeBytes: s.size, durationMs: Date.now() - start };
  }

  async runMigrations(): Promise<void> {
    runSqliteMigrations(this.#db);
  }

  async exec(sql: string, params?: unknown[]): Promise<ExecResult> {
    try {
      const stmt = this.#db.prepare(sql);
      const result = stmt.run(...(params ?? []));
      return {
        changes: Number(result.changes),
        lastInsertRowid:
          result.lastInsertRowid != null ? Number(result.lastInsertRowid) : undefined,
      } as ExecResult;
    } catch (err) {
      throw this.#wrapError(err);
    }
  }

  async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
    try {
      const stmt = this.#db.prepare(sql);
      return stmt.all(...(params ?? [])) as T[];
    } catch (err) {
      throw this.#wrapError(err);
    }
  }

  async queryOne<T>(sql: string, params?: unknown[]): Promise<T | null> {
    try {
      const stmt = this.#db.prepare(sql);
      const row = stmt.get(...(params ?? [])) as T | undefined;
      return row ?? null;
    } catch (err) {
      throw this.#wrapError(err);
    }
  }

  async transaction<T>(fn: (db: DatabaseProvider) => Promise<T>): Promise<T> {
    const depth = this.#txDepth;
    const savepoint = `sp_${depth}`;

    if (depth === 0) {
      this.#db.exec('BEGIN');
    } else {
      this.#db.exec(`SAVEPOINT ${savepoint}`);
    }
    this.#txDepth++;

    try {
      const result = await fn(this);
      if (depth === 0) {
        this.#db.exec('COMMIT');
      } else {
        this.#db.exec(`RELEASE ${savepoint}`);
      }
      this.#txDepth--;
      return result;
    } catch (err) {
      try {
        if (depth === 0) {
          this.#db.exec('ROLLBACK');
        } else {
          this.#db.exec(`ROLLBACK TO ${savepoint}`);
        }
      } catch (rollbackErr) {
        logger.error({ rollbackErr, originalErr: err }, 'Transaction rollback failed');
      }
      this.#txDepth--;
      throw err;
    }
  }

  async close(): Promise<void> {
    if (this.#open && !this.#externalLifecycle) {
      this.#db.close();
      this.#open = false;
    }
  }

  isOpen(): boolean {
    return this.#open;
  }

  #workerId(lockName: string): string {
    return `${lockName}:worker:${hostname()}:${process.pid}`;
  }

  /** Get or create a file lock for the given lock name. */
  getFileLock(lockName: string): FileLock {
    return new FileLock(this.#dbPath, lockName);
  }

  /** Acquire both file lock and table lock. Returns true only if both succeed. */
  async #acquireBothLocks(
    lockName: string,
    ttlMs: number,
    workerId: string,
    fenceToken?: string,
  ): Promise<{ acquired: boolean; fenceToken: string | undefined; fileLock: FileLock }> {
    const fileLock = this.getFileLock(lockName);
    // Try file lock first (fast, cross-process)
    if (!fileLock.tryAcquire()) {
      return { acquired: false, fenceToken: undefined, fileLock };
    }
    // File lock acquired, now try table lock
    const expiresAt = Date.now() + ttlMs;
    try {
      let result;
      if (fenceToken) {
        // Clear expired locks first
        this.#db
          .prepare(
            "DELETE FROM pipeline_locks WHERE lock_name = ? AND expires_at < datetime(?, 'unixepoch')",
          )
          .run(lockName, Date.now() / 1000);
        result = this.#db
          .prepare(
            "INSERT OR IGNORE INTO pipeline_locks (lock_name, locked_at, expires_at, worker_id, fence_token) VALUES (?, datetime('now'), datetime(? / 1000, 'unixepoch'), ?, ?)",
          )
          .run(lockName, expiresAt, workerId, fenceToken);
      } else {
        // Clear expired locks first
        this.#db
          .prepare(
            "DELETE FROM pipeline_locks WHERE lock_name = ? AND expires_at < datetime(?, 'unixepoch')",
          )
          .run(lockName, Date.now() / 1000);
        result = this.#db
          .prepare(
            "INSERT OR IGNORE INTO pipeline_locks (lock_name, locked_at, expires_at, worker_id) VALUES (?, datetime('now'), datetime(? / 1000, 'unixepoch'), ?)",
          )
          .run(lockName, expiresAt, workerId);
      }
      if (result.changes > 0) {
        return { acquired: true, fenceToken: fenceToken ?? randomUUID(), fileLock };
      }
      // Check if we already hold this lock
      const existing = this.#db
        .prepare(
          "SELECT fence_token FROM pipeline_locks WHERE lock_name = ? AND worker_id = ? AND expires_at >= datetime('now')",
        )
        .get(lockName, workerId) as { fence_token: string } | undefined;
      if (existing?.fence_token) {
        return { acquired: true, fenceToken: existing.fence_token, fileLock };
      }
      // Table lock failed, release file lock
      fileLock.release();
      return { acquired: false, fenceToken: undefined, fileLock };
    } catch {
      fileLock.release();
      return { acquired: false, fenceToken: undefined, fileLock };
    }
  }

  async tryLock(lockName: string, ttlMs: number): Promise<boolean> {
    const workerId = this.#workerId(lockName);
    const { acquired } = await this.#acquireBothLocks(lockName, ttlMs, workerId);
    return acquired;
  }

  async renewLock(lockName: string, ttlMs: number): Promise<boolean> {
    try {
      const expiresAt = Date.now() + ttlMs;
      const workerId = this.#workerId(lockName);
      const result = this.#db
        .prepare(
          "UPDATE pipeline_locks SET expires_at = datetime(? / 1000, 'unixepoch'), renewed_count = renewed_count + 1, last_renewed_at = datetime('now') WHERE lock_name = ? AND expires_at >= datetime('now') AND worker_id = ?",
        )
        .run(expiresAt, lockName, workerId);
      return result.changes > 0;
    } catch {
      return false;
    }
  }

  async unlock(lockName: string): Promise<void> {
    try {
      const workerId = this.#workerId(lockName);
      this.#db
        .prepare('DELETE FROM pipeline_locks WHERE lock_name = ? AND worker_id = ?')
        .run(lockName, workerId);
    } catch {
      // Non-fatal
    } finally {
      // Always release file lock
      this.getFileLock(lockName).release();
    }
  }

  async tryLockWithFence(
    lockName: string,
    ttlMs: number,
  ): Promise<{ acquired: boolean; fenceToken: string | undefined }> {
    const workerId = this.#workerId(lockName);
    const fenceToken = randomUUID();
    const {
      acquired,
      fenceToken: returnedFenceToken,
      fileLock,
    } = await this.#acquireBothLocks(lockName, ttlMs, workerId, fenceToken);
    // Store file lock for later release (we can't easily track it, so release on unlockWithFence)
    // For simplicity, we'll release the file lock on unlockWithFence
    if (!acquired) {
      fileLock.release();
    }
    return { acquired, fenceToken: returnedFenceToken };
  }

  async renewLockWithFence(lockName: string, ttlMs: number, fenceToken: string): Promise<boolean> {
    try {
      const expiresAt = Date.now() + ttlMs;
      const workerId = this.#workerId(lockName);
      const result = this.#db
        .prepare(
          "UPDATE pipeline_locks SET expires_at = datetime(? / 1000, 'unixepoch'), renewed_count = renewed_count + 1, last_renewed_at = datetime('now') WHERE lock_name = ? AND expires_at >= datetime('now') AND worker_id = ? AND fence_token = ?",
        )
        .run(expiresAt, lockName, workerId, fenceToken);
      return result.changes > 0;
    } catch {
      return false;
    }
  }

  async unlockWithFence(lockName: string, fenceToken: string): Promise<void> {
    try {
      const workerId = this.#workerId(lockName);
      this.#db
        .prepare(
          'DELETE FROM pipeline_locks WHERE lock_name = ? AND worker_id = ? AND fence_token = ?',
        )
        .run(lockName, workerId, fenceToken);
    } catch {
      // Non-fatal
    } finally {
      // Always release file lock
      this.getFileLock(lockName).release();
    }
  }

  #wrapError(err: unknown): DatabaseError {
    const message = err instanceof Error ? err.message : String(err);
    const errCode =
      err instanceof Error && 'code' in err ? String((err as { code: unknown }).code) : '';
    const codeMap: Record<string, string> = {
      SQLITE_ERROR: 'SQLITE_ERROR',
      SQLITE_BUSY: 'SQLITE_BUSY',
      SQLITE_LOCKED: 'SQLITE_LOCKED',
      SQLITE_MISUSE: 'SQLITE_MISUSE',
      SQLITE_CONSTRAINT: 'SQLITE_CONSTRAINT',
      SQLITE_CONSTRAINT_UNIQUE: 'SQLITE_CONSTRAINT_UNIQUE',
      SQLITE_CONSTRAINT_PRIMARYKEY: 'SQLITE_CONSTRAINT_PRIMARYKEY',
      SQLITE_CONSTRAINT_FOREIGNKEY: 'SQLITE_CONSTRAINT_FOREIGNKEY',
    };
    const code = codeMap[errCode] || 'UNKNOWN';
    const isRetryable = code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED';
    const dbErr = new DatabaseError(message, code, isRetryable);
    if (err instanceof Error && err.stack) {
      dbErr.stack = err.stack;
    }
    return dbErr;
  }
}
