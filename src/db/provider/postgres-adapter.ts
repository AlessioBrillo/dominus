import { exec as execCb } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { promisify } from 'node:util';

const exec = promisify(execCb);
import { resolve, dirname } from 'node:path';
import pg from 'pg';
import { getLogger } from '../../logger.js';
import { getTenantId } from '../../utils/tenant-context.js';
import type { DatabaseProvider, ExecResult, BackupResult } from './interface.js';
import { DatabaseError } from './interface.js';
import { PG_MIGRATIONS } from './pg-migrations.js';

const logger = getLogger();

export class PostgresAdapter implements DatabaseProvider {
  readonly #pool: pg.Pool;
  readonly #connectionString: string;
  readonly #schema: string | undefined;
  #open: boolean;

  constructor(pool: pg.Pool, connectionString: string, schema?: string) {
    this.#pool = pool;
    this.#connectionString = connectionString;
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
    const adapter = new PostgresAdapter(pool, connectionString, options.schema);

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

  /** Prepends a SET_CONFIG call when a tenant context is active.
   *  This lets PostgreSQL RLS policies resolve `current_setting('app.tenant_id')`
   *  during the same implicit/transaction. The tenant value is set LOCAL to the
   *  transaction so it never leaks across queries on a pooled connection. */
  #withTenant(text: string): string {
    const tenantId = getTenantId();
    if (!tenantId) return text;
    const escaped = tenantId.replace(/'/g, "''");
    return `SELECT set_config('app.tenant_id', '${escaped}', true); ${text}`;
  }

  async exec(sql: string, params?: unknown[]): Promise<ExecResult> {
    try {
      const result = await this.#pool.query({
        text: this.#withTenant(sql),
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
        text: this.#withTenant(sql),
        values: params ?? [],
      });
      return result.rows as unknown as T[];
    } catch (err) {
      throw this.#wrapError(err);
    }
  }

  async queryOne<T>(sql: string, params?: unknown[]): Promise<T | null> {
    try {
      const result = await this.#pool.query({
        text: this.#withTenant(sql),
        values: params ?? [],
      });
      if (result.rows.length === 0) return null;
      return result.rows[0] as unknown as T;
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

  async backup(destinationPath: string): Promise<BackupResult> {
    const start = Date.now();
    const absPath = resolve(destinationPath);
    const dir = dirname(absPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const connString = this.#connectionString;

    try {
      await exec(
        `pg_dump "${connString}" --format=custom --file="${absPath}" --no-owner --no-privileges`,
        { timeout: 120_000 },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new DatabaseError(`pg_dump backup failed: ${message}`, 'BACKUP_FAILED');
    }

    const s = statSync(absPath);
    return { path: absPath, sizeBytes: s.size, durationMs: Date.now() - start };
  }

  async runMigrations(): Promise<void> {
    await this.#pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id SERIAL PRIMARY KEY,
        migration_name TEXT NOT NULL UNIQUE,
        applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const result = await this.#pool.query<{ migration_name: string }>(
      'SELECT migration_name FROM schema_migrations ORDER BY id',
    );
    const applied = new Set(result.rows.map((r) => r.migration_name));

    for (const migration of PG_MIGRATIONS) {
      if (!applied.has(migration.name)) {
        await migration.up(this);
        await this.#pool.query('INSERT INTO schema_migrations (migration_name) VALUES ($1)', [
          migration.name,
        ]);
        logger.info({ migration: migration.name }, 'Applied PostgreSQL migration');
      }
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

  /** Same tenant-aware SQL prepend as PostgresAdapter.#withTenant. */
  #withTenant(text: string): string {
    const tenantId = getTenantId();
    if (!tenantId) return text;
    const escaped = tenantId.replace(/'/g, "''");
    return `SELECT set_config('app.tenant_id', '${escaped}', true); ${text}`;
  }

  async exec(sql: string, params?: unknown[]): Promise<ExecResult> {
    try {
      const result = await this.#client.query({
        text: this.#withTenant(sql),
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
        text: this.#withTenant(sql),
        values: params ?? [],
      });
      return result.rows as unknown as T[];
    } catch (err) {
      throw this.#wrapError(err);
    }
  }

  async queryOne<T>(sql: string, params?: unknown[]): Promise<T | null> {
    try {
      const result = await this.#client.query({
        text: this.#withTenant(sql),
        values: params ?? [],
      });
      if (result.rows.length === 0) return null;
      return result.rows[0] as unknown as T;
    } catch (err) {
      throw this.#wrapError(err);
    }
  }

  async transaction<T>(fn: (db: DatabaseProvider) => Promise<T>): Promise<T> {
    return fn(this);
  }

  async backup(_destinationPath: string): Promise<BackupResult> {
    throw new DatabaseError('Cannot backup within a transaction', 'TX_BACKUP');
  }

  async runMigrations(): Promise<void> {
    throw new DatabaseError('Cannot run migrations within a transaction', 'TX_MIGRATIONS');
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
