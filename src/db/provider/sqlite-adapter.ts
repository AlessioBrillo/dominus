import Database from 'better-sqlite3';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { getLogger } from '../../logger.js';
import type { DatabaseProvider, ExecResult, BackupResult } from './interface.js';
import { DatabaseError } from './interface.js';
import { runMigrations as runSqliteMigrations } from '../migrator.js';
const logger = getLogger();

export class SqliteProvider implements DatabaseProvider {
  /** Underlying better-sqlite3 database handle. */
  readonly #db: Database.Database;
  #open = false;
  #txDepth = 0;
  /**
   * When true, close() is a no-op because the underlying Database handle
   * is lifecycle-managed externally (e.g. via database.ts ref-counting).
   */
  readonly #externalLifecycle: boolean;

  constructor(db: Database.Database, _busyTimeout = 30000, externalLifecycle = false) {
    this.#db = db;
    this.#open = true;
    this.#externalLifecycle = externalLifecycle;
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
    return new SqliteProvider(db, options.busyTimeout ?? 30000);
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
    return new SqliteProvider(db, busyTimeout);
  }

  static openInMemory(): SqliteProvider {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    return new SqliteProvider(db, 30000);
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
