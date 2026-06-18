import type { DatabaseProvider, ExecResult } from './interface.js';

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

  exec(sql: string, params?: unknown[]): ExecResult {
    this.#recordCall('exec', sql, params);
    const id = this.#nextId++;
    return { changes: 1, lastInsertRowid: id };
  }

  query<T>(_sql: string, _params?: unknown[]): T[] {
    this.#recordCall('query', _sql, _params);
    return [];
  }

  queryOne<T>(_sql: string, _params?: unknown[]): T | null {
    this.#recordCall('queryOne', _sql, _params);
    return null;
  }

  transaction<T>(fn: (db: DatabaseProvider) => T): T {
    return fn(this);
  }

  close(): void {
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
