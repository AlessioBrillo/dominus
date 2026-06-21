export interface AsyncExecResult {
  changes: number;
  lastInsertRowid: number | undefined;
}

export class AsyncDatabaseError extends Error {
  readonly code: string;
  readonly isRetryable: boolean;
  constructor(message: string, code: string, isRetryable = false) {
    super(message);
    this.name = 'AsyncDatabaseError';
    this.code = code;
    this.isRetryable = isRetryable;
  }
}

export interface AsyncDatabaseProvider {
  exec(sql: string, params?: unknown[]): Promise<AsyncExecResult>;
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
  queryOne<T>(sql: string, params?: unknown[]): Promise<T | null>;
  transaction<T>(fn: (db: AsyncDatabaseProvider) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  isOpen(): boolean;
}
