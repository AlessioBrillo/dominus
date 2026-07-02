export interface ExecResult {
  changes: number;
  lastInsertRowid: number | undefined;
}

export class DatabaseError extends Error {
  readonly code: string;
  readonly isRetryable: boolean;
  constructor(message: string, code: string, isRetryable = false) {
    super(message);
    this.name = 'DatabaseError';
    this.code = code;
    this.isRetryable = isRetryable;
  }
}

export interface BackupResult {
  path: string;
  sizeBytes: number;
  durationMs: number;
}

export interface DatabaseProvider {
  exec(sql: string, params?: unknown[]): Promise<ExecResult>;
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
  queryOne<T>(sql: string, params?: unknown[]): Promise<T | null>;
  transaction<T>(fn: (db: DatabaseProvider) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  isOpen(): boolean;
  /** Create a backup of the database at the given destination path. */
  backup(destinationPath: string): Promise<BackupResult>;
  /** Run all pending schema migrations for this provider's dialect. */
  runMigrations(): Promise<void>;
  /**
   * Try to acquire a named advisory lock. Returns true if the lock was
   * acquired, false if another holder already has it.
   *
   * The lock expires after ttlMs milliseconds to prevent stale locks
   * from blocking forever (e.g. after a crash).
   *
   * Implementation: table-based (platform-independent).
   * - SQLite: INSERT OR IGNORE with ON CONFLICT DO UPDATE + expiry check
   * - PostgreSQL: pg_try_advisory_xact_lock as a hint, with table fallback
   */
  tryLock(lockName: string, ttlMs: number): Promise<boolean>;

  /** Renew (extend) an already-held advisory lock's TTL.
   *  Used as a heartbeat to prevent lock expiry during long operations.
   *  Returns false if the lock does not exist (lost or stolen).
   */
  renewLock(lockName: string, ttlMs: number): Promise<boolean>;

  /** Release a previously acquired advisory lock. */
  unlock(lockName: string): Promise<void>;
}
