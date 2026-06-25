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
}
