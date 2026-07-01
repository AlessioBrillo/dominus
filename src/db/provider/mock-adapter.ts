import type { DatabaseProvider, ExecResult, BackupResult } from './interface.js';

interface CallRecord {
  method: string;
  sql: string;
  params: unknown[] | undefined;
  timestamp: string;
}

export class MockDatabaseProvider implements DatabaseProvider {
  #calls: CallRecord[] = [];
  #open = true;
  #nextId = 1;
  #tables: Set<string> = new Set();

  constructor() {
    this.#tables.add('schema_migrations');
  }

  get calls(): CallRecord[] {
    return [...this.#calls];
  }

  clearCalls(): void {
    this.#calls = [];
  }

  addTable(name: string): void {
    this.#tables.add(name);
  }

  hasTable(name: string): boolean {
    return this.#tables.has(name);
  }

  async exec(sql: string, params?: unknown[]): Promise<ExecResult> {
    this.#recordCall('exec', sql, params);
    const id = this.#nextId++;
    return { changes: 1, lastInsertRowid: id };
  }

  async query<T>(_sql: string, _params?: unknown[]): Promise<T[]> {
    this.#recordCall('query', _sql, _params);
    return [];
  }

  async queryOne<T>(_sql: string, _params?: unknown[]): Promise<T | null> {
    this.#recordCall('queryOne', _sql, _params);
    return null;
  }

  async transaction<T>(fn: (db: DatabaseProvider) => Promise<T>): Promise<T> {
    return fn(this);
  }

  async backup(destinationPath: string): Promise<BackupResult> {
    this.#recordCall('backup', destinationPath, undefined);
    return { path: destinationPath, sizeBytes: 0, durationMs: 0 };
  }

  async runMigrations(): Promise<void> {
    this.#recordCall('runMigrations', '', undefined);
  }

  async tryLock(_lockName: string, _ttlMs: number): Promise<boolean> {
    this.#recordCall('tryLock', _lockName, [_ttlMs]);
    return true;
  }

  async unlock(_lockName: string): Promise<void> {
    this.#recordCall('unlock', _lockName, undefined);
  }

  async close(): Promise<void> {
    this.#open = false;
  }

  isOpen(): boolean {
    return this.#open;
  }

  reset(): void {
    this.#calls = [];
    this.#open = true;
    this.#nextId = 1;
    this.#tables.clear();
    this.#tables.add('schema_migrations');
  }

  #recordCall(method: string, sql: string, params?: unknown[]): void {
    this.#calls.push({
      method,
      sql,
      params: params?.length ? [...params] : undefined,
      timestamp: new Date().toISOString(),
    });
  }
}
