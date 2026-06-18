export interface ExecResult {
  changes: number;
  lastInsertRowid: number | undefined;
}

export interface TransactionIsolationLevel {
  readUncommitted?: boolean;
  readCommitted?: boolean;
  repeatableRead?: boolean;
  serializable?: boolean;
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
  exec(sql: string, params?: unknown[]): Promise<ExecResult>;
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
  queryOne<T>(sql: string, params?: unknown[]): Promise<T | null>;
  transaction<T>(
    fn: (trx: DatabaseProvider) => Promise<T>,
    isolationLevel?: TransactionIsolationLevel,
  ): Promise<T>;
  close(): Promise<void>;
  isOpen(): boolean;
}

export type { DatabaseProvider as DatabaseProviderType };
