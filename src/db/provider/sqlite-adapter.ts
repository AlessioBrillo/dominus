import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { getLogger } from '../../logger.js';
import type { DatabaseProvider, ExecResult } from './interface.js';
import { DatabaseError } from './interface.js';
const logger = getLogger();

export class SqliteProvider implements DatabaseProvider {
  #db: Database.Database;
  #open = false;
  #txDepth = 0;

  constructor(db: Database.Database, _busyTimeout = 30000) {
    this.#db = db;
    this.#open = true;
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

  static openInMemory(): SqliteProvider {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    return new SqliteProvider(db, 30000);
  }

  get rawDb(): Database.Database {
    return this.#db;
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
    if (this.#open) {
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
