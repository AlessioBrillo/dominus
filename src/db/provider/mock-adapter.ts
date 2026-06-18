import type { DatabaseProvider, ExecResult, TransactionIsolationLevel } from './interface.js';

interface MockTable {
  columns: string[];
  rows: Record<string, unknown>[];
  autoIncrementId: number;
}

interface CallRecord {
  method: string;
  sql: string;
  params: unknown[] | undefined;
  timestamp: string;
}

export class MockDatabaseProvider implements DatabaseProvider {
  #tables: Map<string, MockTable> = new Map();
  #calls: CallRecord[] = [];
  #open = true;
  #nextId = 1;

  constructor() {
    this.#tables.set('schema_migrations', {
      columns: ['migration_name', 'applied_at'],
      rows: [],
      autoIncrementId: 0,
    });
  }

  get calls(): CallRecord[] {
    return [...this.#calls];
  }

  clearCalls(): void {
    this.#calls = [];
  }

  addTable(name: string, columns: string[], initialRows: Record<string, unknown>[] = []): void {
    this.#tables.set(name, {
      columns,
      rows: [...initialRows],
      autoIncrementId: initialRows.length,
    });
  }

  getTable(name: string): MockTable | undefined {
    return this.#tables.get(name);
  }

  getAllRows<T>(table: string): T[] {
    return (this.#tables.get(table)?.rows as T[]) ?? [];
  }

  async exec(sql: string, params?: unknown[]): Promise<ExecResult> {
    this.#recordCall('exec', sql, params);
    const normalizedSql = sql.trim().toUpperCase();

    if (normalizedSql.startsWith('CREATE')) {
      return { changes: 0, lastInsertRowid: undefined };
    }

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

  async transaction<T>(
    fn: (trx: DatabaseProvider) => Promise<T>,
    _isolationLevel?: TransactionIsolationLevel,
  ): Promise<T> {
    return fn(this);
  }

  async close(): Promise<void> {
    this.#open = false;
  }

  isOpen(): boolean {
    return this.#open;
  }

  reset(): void {
    this.#tables.clear();
    this.#calls = [];
    this.#open = true;
    this.#nextId = 1;
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
