// SPDX-License-Identifier: AGPL-3.0-only
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  type DatabaseProvider,
  type ExecResult,
  type BackupResult,
  DatabaseError,
} from './provider/interface.js';
import { getLogger } from '../logger.js';

const logger = getLogger();

interface PoolEntry {
  conn: Database.Database;
  inUse: boolean;
  mode: 'read' | 'write';
}

export class DatabasePool {
  readonly #path: string;
  readonly #maxConnections: number;
  readonly #readBusyTimeout: number;
  readonly #writeBusyTimeout: number;
  readonly #entries: PoolEntry[] = [];
  #closed = false;

  constructor(
    path: string,
    maxConnections: number,
    readBusyTimeout: number,
    writeBusyTimeout: number,
  ) {
    this.#path = path;
    this.#maxConnections = maxConnections;
    this.#readBusyTimeout = readBusyTimeout;
    this.#writeBusyTimeout = writeBusyTimeout;
  }

  get totalConnections(): number {
    return this.#entries.length;
  }

  get maxConnections(): number {
    return this.#maxConnections;
  }

  acquire(mode: 'read' | 'write'): Database.Database {
    if (this.#closed) {
      throw new Error('DatabasePool is closed');
    }

    const free = this.#entries.find((e) => !e.inUse && e.mode === mode);
    if (free !== undefined) {
      free.inUse = true;
      return free.conn;
    }

    if (this.#entries.length >= this.#maxConnections) {
      throw new Error(
        `database pool exhausted (${this.#maxConnections}/${this.#maxConnections} in use)`,
      );
    }

    const conn = this.#createConnection(mode);
    this.#entries.push({ conn, inUse: true, mode });
    return conn;
  }

  release(conn: Database.Database): void {
    const entry = this.#entries.find((e) => e.conn === conn);
    if (entry !== undefined) {
      entry.inUse = false;
    }
  }

  close(): void {
    this.#closed = true;
    for (const entry of this.#entries) {
      try {
        entry.conn.close();
      } catch (err) {
        logger.warn({ err }, 'DatabasePool: error closing connection');
      }
    }
    this.#entries.length = 0;
  }

  #createConnection(mode: 'read' | 'write'): Database.Database {
    const dir = dirname(this.#path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const busyTimeout = mode === 'read' ? this.#readBusyTimeout : this.#writeBusyTimeout;
    const conn = new Database(this.#path);
    conn.pragma('journal_mode = WAL');
    conn.pragma('foreign_keys = ON');
    conn.pragma(`busy_timeout = ${busyTimeout}`);
    return conn;
  }
}

export class PooledSqliteProvider implements DatabaseProvider {
  readonly dialect = 'sqlite' as const;
  readonly #pool: DatabasePool;
  readonly #logger = logger;
  #open = true;
  #txDepth = 0;

  constructor(pool: DatabasePool) {
    this.#pool = pool;
  }

  get pool(): DatabasePool {
    return this.#pool;
  }

  async exec(sql: string, params?: unknown[]): Promise<ExecResult> {
    const conn = this.#pool.acquire('write');
    try {
      const stmt = conn.prepare(sql);
      const result = stmt.run(...(params ?? []));
      return {
        changes: Number(result.changes),
        lastInsertRowid:
          result.lastInsertRowid != null ? Number(result.lastInsertRowid) : undefined,
      } as ExecResult;
    } catch (err) {
      throw this.#wrapError(err);
    } finally {
      this.#pool.release(conn);
    }
  }

  async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
    const conn = this.#pool.acquire('read');
    try {
      const stmt = conn.prepare(sql);
      return stmt.all(...(params ?? [])) as T[];
    } catch (err) {
      throw this.#wrapError(err);
    } finally {
      this.#pool.release(conn);
    }
  }

  async queryOne<T>(sql: string, params?: unknown[]): Promise<T | null> {
    const conn = this.#pool.acquire('read');
    try {
      const stmt = conn.prepare(sql);
      const row = stmt.get(...(params ?? [])) as T | undefined;
      return row ?? null;
    } catch (err) {
      throw this.#wrapError(err);
    } finally {
      this.#pool.release(conn);
    }
  }

  async transaction<T>(fn: (db: DatabaseProvider) => Promise<T>): Promise<T> {
    const conn = this.#pool.acquire('write');
    try {
      const depth = this.#txDepth;
      const savepoint = `sp_${depth}`;

      if (depth === 0) {
        conn.exec('BEGIN');
      } else {
        conn.exec(`SAVEPOINT ${savepoint}`);
      }
      this.#txDepth++;

      try {
        const result = await fn(new ExecuteOnlyProvider(conn, this.#wrapError.bind(this)));
        if (depth === 0) {
          conn.exec('COMMIT');
        } else {
          conn.exec(`RELEASE ${savepoint}`);
        }
        this.#txDepth--;
        return result;
      } catch (err) {
        try {
          if (depth === 0) {
            conn.exec('ROLLBACK');
          } else {
            conn.exec(`ROLLBACK TO ${savepoint}`);
          }
        } catch (rollbackErr) {
          this.#logger.error({ rollbackErr, originalErr: err }, 'Transaction rollback failed');
        }
        this.#txDepth--;
        throw err;
      }
    } finally {
      this.#pool.release(conn);
    }
  }

  async backup(destinationPath: string): Promise<BackupResult> {
    const conn = this.#pool.acquire('write');
    const start = Date.now();
    const absPath = resolve(destinationPath);
    const dirPath = dirname(absPath);
    if (!existsSync(dirPath)) {
      mkdirSync(dirPath, { recursive: true });
    }
    try {
      conn.pragma('wal_checkpoint(TRUNCATE)');
      conn.exec(`VACUUM INTO '${absPath.replace(/'/g, "''")}'`);
      const s = statSync(absPath);
      return { path: absPath, sizeBytes: s.size, durationMs: Date.now() - start };
    } finally {
      this.#pool.release(conn);
    }
  }

  async runMigrations(): Promise<void> {
    const { runMigrations } = await import('./migrator.js');
    const conn = this.#pool.acquire('write');
    try {
      runMigrations(conn);
    } finally {
      this.#pool.release(conn);
    }
  }

  async close(): Promise<void> {
    this.#open = false;
    this.#pool.close();
  }

  isOpen(): boolean {
    return this.#open;
  }

  async tryLock(lockName: string, ttlMs: number): Promise<boolean> {
    const conn = this.#pool.acquire('write');
    try {
      const expiresAt = Date.now() + ttlMs;
      const workerId = `pooled:${process.pid}`;
      conn
        .prepare(
          "DELETE FROM pipeline_locks WHERE lock_name = ? AND expires_at < datetime(?, 'unixepoch')",
        )
        .run(lockName, Date.now() / 1000);
      const result = conn
        .prepare(
          "INSERT OR IGNORE INTO pipeline_locks (lock_name, locked_at, expires_at, worker_id) VALUES (?, datetime('now'), datetime(? / 1000, 'unixepoch'), ?)",
        )
        .run(lockName, expiresAt, workerId);
      return result.changes > 0;
    } catch {
      return false;
    } finally {
      this.#pool.release(conn);
    }
  }

  async renewLock(lockName: string, ttlMs: number): Promise<boolean> {
    const conn = this.#pool.acquire('write');
    try {
      const expiresAt = Date.now() + ttlMs;
      const workerId = `pooled:${process.pid}`;
      const result = conn
        .prepare(
          "UPDATE pipeline_locks SET expires_at = datetime(? / 1000, 'unixepoch') WHERE lock_name = ? AND expires_at >= datetime('now') AND worker_id = ?",
        )
        .run(expiresAt, lockName, workerId);
      return result.changes > 0;
    } catch {
      return false;
    } finally {
      this.#pool.release(conn);
    }
  }

  async unlock(lockName: string): Promise<void> {
    const conn = this.#pool.acquire('write');
    try {
      const workerId = `pooled:${process.pid}`;
      conn
        .prepare('DELETE FROM pipeline_locks WHERE lock_name = ? AND worker_id = ?')
        .run(lockName, workerId);
    } catch {
      // Non-fatal
    } finally {
      this.#pool.release(conn);
    }
  }

  async tryLockWithFence(
    lockName: string,
    ttlMs: number,
  ): Promise<{ acquired: boolean; fenceToken: string | undefined }> {
    const conn = this.#pool.acquire('write');
    try {
      const expiresAt = Date.now() + ttlMs;
      const workerId = `pooled:${process.pid}`;
      const fenceToken = randomUUID();
      conn
        .prepare(
          "DELETE FROM pipeline_locks WHERE lock_name = ? AND expires_at < datetime(?, 'unixepoch')",
        )
        .run(lockName, Date.now() / 1000);
      const result = conn
        .prepare(
          "INSERT OR IGNORE INTO pipeline_locks (lock_name, locked_at, expires_at, worker_id, fence_token) VALUES (?, datetime('now'), datetime(? / 1000, 'unixepoch'), ?, ?)",
        )
        .run(lockName, expiresAt, workerId, fenceToken);
      if (result.changes > 0) {
        return { acquired: true, fenceToken };
      }
      // Check if we already hold this lock
      const existing = conn
        .prepare(
          "SELECT fence_token FROM pipeline_locks WHERE lock_name = ? AND worker_id = ? AND expires_at >= datetime('now')",
        )
        .get(lockName, workerId) as { fence_token: string } | undefined;
      if (existing?.fence_token) {
        return { acquired: true, fenceToken: existing.fence_token };
      }
      return { acquired: false, fenceToken: undefined };
    } catch {
      return { acquired: false, fenceToken: undefined };
    } finally {
      this.#pool.release(conn);
    }
  }

  async renewLockWithFence(lockName: string, ttlMs: number, fenceToken: string): Promise<boolean> {
    const conn = this.#pool.acquire('write');
    try {
      const expiresAt = Date.now() + ttlMs;
      const workerId = `pooled:${process.pid}`;
      const result = conn
        .prepare(
          "UPDATE pipeline_locks SET expires_at = datetime(? / 1000, 'unixepoch'), renewed_count = renewed_count + 1, last_renewed_at = datetime('now') WHERE lock_name = ? AND expires_at >= datetime('now') AND worker_id = ? AND fence_token = ?",
        )
        .run(expiresAt, lockName, workerId, fenceToken);
      return result.changes > 0;
    } catch {
      return false;
    } finally {
      this.#pool.release(conn);
    }
  }

  async unlockWithFence(lockName: string, fenceToken: string): Promise<void> {
    const conn = this.#pool.acquire('write');
    try {
      const workerId = `pooled:${process.pid}`;
      conn
        .prepare(
          'DELETE FROM pipeline_locks WHERE lock_name = ? AND worker_id = ? AND fence_token = ?',
        )
        .run(lockName, workerId, fenceToken);
    } catch {
      // Non-fatal
    } finally {
      this.#pool.release(conn);
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

class ExecuteOnlyProvider implements DatabaseProvider {
  readonly dialect = 'sqlite' as const;

  constructor(
    private readonly conn: Database.Database,
    private readonly wrapError: (err: unknown) => DatabaseError,
  ) {}

  async exec(sql: string, params?: unknown[]): Promise<ExecResult> {
    try {
      const stmt = this.conn.prepare(sql);
      const result = stmt.run(...(params ?? []));
      return {
        changes: Number(result.changes),
        lastInsertRowid:
          result.lastInsertRowid != null ? Number(result.lastInsertRowid) : undefined,
      } as ExecResult;
    } catch (err) {
      throw this.wrapError(err);
    }
  }

  async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
    try {
      const stmt = this.conn.prepare(sql);
      return stmt.all(...(params ?? [])) as T[];
    } catch (err) {
      throw this.wrapError(err);
    }
  }

  async queryOne<T>(sql: string, params?: unknown[]): Promise<T | null> {
    try {
      const stmt = this.conn.prepare(sql);
      const row = stmt.get(...(params ?? [])) as T | undefined;
      return row ?? null;
    } catch (err) {
      throw this.wrapError(err);
    }
  }

  async transaction<T>(_fn: (db: DatabaseProvider) => Promise<T>): Promise<T> {
    throw new Error('nested transaction on ExecuteOnlyProvider');
  }

  async close(): Promise<void> {
    // no-op — pool manages lifecycle
  }

  isOpen(): boolean {
    return this.conn.open;
  }

  async backup(_destinationPath: string): Promise<BackupResult> {
    throw new Error('backup not available on ExecuteOnlyProvider');
  }

  async runMigrations(): Promise<void> {
    throw new Error('migrations not available on ExecuteOnlyProvider');
  }

  async tryLock(_lockName: string, _ttlMs: number): Promise<boolean> {
    throw new Error('lock not available on ExecuteOnlyProvider');
  }

  async renewLock(_lockName: string, _ttlMs: number): Promise<boolean> {
    throw new Error('lock not available on ExecuteOnlyProvider');
  }

  async unlock(_lockName: string): Promise<void> {
    throw new Error('lock not available on ExecuteOnlyProvider');
  }

  async tryLockWithFence(
    _lockName: string,
    _ttlMs: number,
  ): Promise<{ acquired: boolean; fenceToken: string | undefined }> {
    throw new Error('lock not available on ExecuteOnlyProvider');
  }

  async renewLockWithFence(
    _lockName: string,
    _ttlMs: number,
    _fenceToken: string,
  ): Promise<boolean> {
    throw new Error('lock not available on ExecuteOnlyProvider');
  }

  async unlockWithFence(_lockName: string, _fenceToken: string): Promise<void> {
    throw new Error('lock not available on ExecuteOnlyProvider');
  }
}
