import pg from 'pg';
import { getLogger } from '../../logger.js';
import type { DatabaseProvider, ExecResult } from './interface.js';
import { DatabaseError } from './interface.js';

const logger = getLogger();

function toCamelCase(key: string): string {
  return key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

function rowToCamel(row: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(row)) {
    result[toCamelCase(key)] = row[key];
  }
  return result;
}

export class PostgresAdapter implements DatabaseProvider {
  readonly #pool: pg.Pool;
  readonly #schema: string | undefined;
  #open: boolean;

  constructor(pool: pg.Pool, schema?: string) {
    this.#pool = pool;
    this.#schema = schema;
    this.#open = true;
  }

  static async create(
    connectionString: string,
    options: { max?: number; schema?: string } = {},
  ): Promise<PostgresAdapter> {
    const pool = new pg.Pool({
      connectionString,
      max: options.max ?? 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
    const adapter = new PostgresAdapter(pool, options.schema);

    const client = await pool.connect();
    try {
      await client.query('SELECT 1');
      if (options.schema) {
        await client.query(`SET search_path TO "${options.schema}"`);
      }
      logger.info({ schema: options.schema ?? 'public' }, 'PostgreSQL connection established');
    } finally {
      client.release();
    }

    return adapter;
  }

  get pool(): pg.Pool {
    return this.#pool;
  }

  async exec(sql: string, params?: unknown[]): Promise<ExecResult> {
    try {
      const result = await this.#pool.query({
        text: sql,
        values: params ?? [],
      });
      return {
        changes: result.rowCount ?? 0,
        lastInsertRowid: result.rows[0]?.id != null ? Number(result.rows[0].id) : undefined,
      } as ExecResult;
    } catch (err) {
      throw this.#wrapError(err);
    }
  }

  async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
    try {
      const result = await this.#pool.query({
        text: sql,
        values: params ?? [],
      });
      return result.rows.map((r) => rowToCamel(r as Record<string, unknown>)) as unknown as T[];
    } catch (err) {
      throw this.#wrapError(err);
    }
  }

  async queryOne<T>(sql: string, params?: unknown[]): Promise<T | null> {
    try {
      const result = await this.#pool.query({
        text: sql,
        values: params ?? [],
      });
      if (result.rows.length === 0) return null;
      return rowToCamel(result.rows[0] as Record<string, unknown>) as unknown as T;
    } catch (err) {
      throw this.#wrapError(err);
    }
  }

  async transaction<T>(fn: (db: DatabaseProvider) => Promise<T>): Promise<T> {
    const client = await this.#pool.connect();
    const txAdapter = new PostgresTransactionAdapter(client, this.#schema);
    try {
      await client.query('BEGIN');
      const result = await fn(txAdapter);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        logger.error({ rollbackErr, originalErr: err }, 'Transaction rollback failed');
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    if (this.#open) {
      await this.#pool.end();
      this.#open = false;
    }
  }

  isOpen(): boolean {
    return this.#open;
  }

  #wrapError(err: unknown): DatabaseError {
    if (err instanceof DatabaseError) return err;
    const message = err instanceof Error ? err.message : String(err);
    const code =
      err instanceof Error && 'code' in err ? String((err as { code: unknown }).code) : 'UNKNOWN';
    const pgCode = code || 'UNKNOWN';
    const isRetryable =
      pgCode === '40001' ||
      pgCode === '40P01' ||
      pgCode === '57P01' ||
      pgCode === '53300' ||
      pgCode === 'XX000';
    return new DatabaseError(message, pgCode, isRetryable);
  }
}

class PostgresTransactionAdapter implements DatabaseProvider {
  readonly #client: pg.PoolClient;

  constructor(client: pg.PoolClient, _schema?: string) {
    this.#client = client;
  }

  async exec(sql: string, params?: unknown[]): Promise<ExecResult> {
    try {
      const result = await this.#client.query({
        text: sql,
        values: params ?? [],
      });
      return {
        changes: result.rowCount ?? 0,
        lastInsertRowid: result.rows[0]?.id != null ? Number(result.rows[0].id) : undefined,
      } as ExecResult;
    } catch (err) {
      throw this.#wrapError(err);
    }
  }

  async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
    try {
      const result = await this.#client.query({
        text: sql,
        values: params ?? [],
      });
      return result.rows.map((r) => rowToCamel(r as Record<string, unknown>)) as unknown as T[];
    } catch (err) {
      throw this.#wrapError(err);
    }
  }

  async queryOne<T>(sql: string, params?: unknown[]): Promise<T | null> {
    try {
      const result = await this.#client.query({
        text: sql,
        values: params ?? [],
      });
      if (result.rows.length === 0) return null;
      return rowToCamel(result.rows[0] as Record<string, unknown>) as unknown as T;
    } catch (err) {
      throw this.#wrapError(err);
    }
  }

  async transaction<T>(fn: (db: DatabaseProvider) => Promise<T>): Promise<T> {
    return fn(this);
  }

  async close(): Promise<void> {
    // Transaction adapter does not own the client; close is a no-op.
  }

  isOpen(): boolean {
    return true;
  }

  #wrapError(err: unknown): DatabaseError {
    if (err instanceof DatabaseError) return err;
    const message = err instanceof Error ? err.message : String(err);
    const code =
      err instanceof Error && 'code' in err ? String((err as { code: unknown }).code) : 'UNKNOWN';
    const pgCode = code || 'UNKNOWN';
    const isRetryable =
      pgCode === '40001' ||
      pgCode === '40P01' ||
      pgCode === '57P01' ||
      pgCode === '53300' ||
      pgCode === 'XX000';
    return new DatabaseError(message, pgCode, isRetryable);
  }
}
