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

export interface DatabaseProvider {
  exec(sql: string, params?: unknown[]): ExecResult;
  query<T>(sql: string, params?: unknown[]): T[];
  queryOne<T>(sql: string, params?: unknown[]): T | null;
  transaction<T>(fn: (db: DatabaseProvider) => T): T;
  close(): void;
  isOpen(): boolean;
}
