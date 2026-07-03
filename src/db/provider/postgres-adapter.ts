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

/** Convert SQLite `?` placeholders to PostgreSQL `$1`..`$n`. */
function convertPlaceholders(sql: string): string {
  let idx = 0;
  return sql.replace(/\?/g, () => `$${++idx}`);
}

/** Detect if an INSERT statement already has a RETURNING clause. */
function hasReturning(sql: string): boolean {
  return /\bRETURNING\b/i.test(sql);
}

// ─────────────────────────────────────────────────────────────
//  PgExecutor — shared query-level implementation
//  Used by both PostgresAdapter (pool) and PostgresTransactionAdapter (client).
//  Tenant config is managed externally — this class only runs queries.
// ─────────────────────────────────────────────────────────────

type QueryFn = (text: string, values: unknown[]) => Promise<pg.QueryResult>;

interface PgExecutor {
  exec(sql: string, params?: unknown[]): Promise<ExecResult>;
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
  queryOne<T>(sql: string, params?: unknown[]): Promise<T | null>;
  tryLock(lockName: string, ttlMs: number): Promise<boolean>;
  renewLock(lockName: string, ttlMs: number): Promise<boolean>;
  unlock(lockName: string): Promise<void>;
}

function createPgExecutor(queryFn: QueryFn): PgExecutor {
  async function exec(sql: string, params?: unknown[]): Promise<ExecResult> {
    try {
      const isInsert = /^\s*INSERT\s/i.test(sql) && !hasReturning(sql);
      const text = isInsert ? `${convertPlaceholders(sql)} RETURNING id` : convertPlaceholders(sql);
      const result = await queryFn(text, params ?? []);
      return {
        changes: result.rowCount ?? 0,
        lastInsertRowid: result.rows[0]?.id != null ? Number(result.rows[0].id) : undefined,
      };
    } catch (err) {
      throw wrapError(err);
    }
  }

  async function query<T>(sql: string, params?: unknown[]): Promise<T[]> {
    try {
      const result = await queryFn(convertPlaceholders(sql), params ?? []);
      return result.rows as unknown as T[];
    } catch (err) {
      throw wrapError(err);
    }
  }

  async function queryOne<T>(sql: string, params?: unknown[]): Promise<T | null> {
    try {
      const result = await queryFn(convertPlaceholders(sql), params ?? []);
      if (result.rows.length === 0) return null;
      return result.rows[0] as unknown as T;
    } catch (err) {
      throw wrapError(err);
    }
  }

  async function tryLock(lockName: string, ttlMs: number): Promise<boolean> {
    try {
      await queryFn(`DELETE FROM pipeline_locks WHERE lock_name = $1 AND expires_at < NOW()`, [
        lockName,
      ]);
      const result = await queryFn(
        `INSERT INTO pipeline_locks (lock_name, locked_at, expires_at)
         VALUES ($1, NOW(), NOW() + $2::integer * INTERVAL '1 millisecond')
         ON CONFLICT (lock_name) DO NOTHING`,
        [lockName, ttlMs],
      );
      return (result.rowCount ?? 0) > 0;
    } catch {
      return false;
    }
  }

  async function renewLock(lockName: string, ttlMs: number): Promise<boolean> {
    try {
      const result = await queryFn(
        `UPDATE pipeline_locks SET expires_at = NOW() + $2::integer * INTERVAL '1 millisecond'
         WHERE lock_name = $1 AND expires_at >= NOW()`,
        [lockName, ttlMs],
      );
      return (result.rowCount ?? 0) > 0;
    } catch {
      return false;
    }
  }

  async function unlock(lockName: string): Promise<void> {
    try {
      await queryFn('DELETE FROM pipeline_locks WHERE lock_name = $1', [lockName]);
    } catch {
      // Non-fatal
    }
  }

  return { exec, query, queryOne, tryLock, renewLock, unlock };
}

function wrapError(err: unknown): DatabaseError {
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

// ─────────────────────────────────────────────────────────────
//  PostgresAdapter — pool-based DatabaseProvider
// ─────────────────────────────────────────────────────────────

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

  /**
   * Acquire a dedicated client from the pool, set the tenant config at
   * session level (is_local=false), run the work, reset config to 'default',
   * and release the client. This safely scopes the tenant to a single
   * connection lease without multi-statement protocol limitations.
   *
   * The reset step prevents tenant context from leaking to the next
   * consumer of the same pooled connection.
   */
  async #withConnection<T>(fn: (executor: PgExecutor) => Promise<T>): Promise<T> {
    const client = await this.#pool.connect();
    const executor = createPgExecutor((text: string, values: unknown[]) =>
      client.query({ text, values }),
    );
    try {
      const tenantId = getTenantId();
      if (tenantId) {
        await client.query('SELECT set_config($1, $2, false)', ['app.tenant_id', tenantId]);
      }
      const result = await fn(executor);
      if (tenantId) {
        // Reset tenant to default before releasing the connection
        await client
          .query('SELECT set_config($1, $2, false)', ['app.tenant_id', 'default'])
          .catch(() => {});
      }
      return result;
    } finally {
      client.release();
    }
  }

  async exec(sql: string, params?: unknown[]): Promise<ExecResult> {
    try {
      return await this.#withConnection((e) => e.exec(sql, params));
    } catch (err) {
      throw wrapError(err);
    }
  }

  async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
    try {
      return await this.#withConnection((e) => e.query<T>(sql, params));
    } catch (err) {
      throw wrapError(err);
    }
  }

  async queryOne<T>(sql: string, params?: unknown[]): Promise<T | null> {
    try {
      return await this.#withConnection((e) => e.queryOne<T>(sql, params));
    } catch (err) {
      throw wrapError(err);
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

  async tryLock(lockName: string, ttlMs: number): Promise<boolean> {
    try {
      return await this.#withConnection((e) => e.tryLock(lockName, ttlMs));
    } catch {
      return false;
    }
  }

  async renewLock(lockName: string, ttlMs: number): Promise<boolean> {
    try {
      return await this.#withConnection((e) => e.renewLock(lockName, ttlMs));
    } catch {
      return false;
    }
  }

  async unlock(lockName: string): Promise<void> {
    try {
      await this.#withConnection((e) => e.unlock(lockName));
    } catch {
      // Non-fatal
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
}

// ─────────────────────────────────────────────────────────────
//  PostgresTransactionAdapter — client-scoped DatabaseProvider
//  Used within a transaction. Tenant config is set once at
//  transaction begin (by the owning PostgresAdapter) and is
//  transaction-local (is_local=true), so no cleanup is needed.
// ─────────────────────────────────────────────────────────────

class PostgresTransactionAdapter implements DatabaseProvider {
  readonly #executor: PgExecutor;
  readonly #client: pg.PoolClient;

  constructor(client: pg.PoolClient, _schema?: string) {
    this.#client = client;
    this.#executor = createPgExecutor((text: string, values: unknown[]) =>
      client.query({ text, values }),
    );
  }

  async exec(sql: string, params?: unknown[]): Promise<ExecResult> {
    try {
      // Set tenant config within the transaction (is_local=true)
      // before each logical query group. The setting is scoped to
      // the already-open transaction so no extra cleanup is needed.
      await this.#ensureTenantConfig();
      return await this.#executor.exec(sql, params);
    } catch (err) {
      throw wrapError(err);
    }
  }

  async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
    try {
      await this.#ensureTenantConfig();
      return await this.#executor.query<T>(sql, params);
    } catch (err) {
      throw wrapError(err);
    }
  }

  async queryOne<T>(sql: string, params?: unknown[]): Promise<T | null> {
    try {
      await this.#ensureTenantConfig();
      return await this.#executor.queryOne<T>(sql, params);
    } catch (err) {
      throw wrapError(err);
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

  async tryLock(lockName: string, ttlMs: number): Promise<boolean> {
    try {
      await this.#ensureTenantConfig();
      return await this.#executor.tryLock(lockName, ttlMs);
    } catch {
      return false;
    }
  }

  async renewLock(lockName: string, ttlMs: number): Promise<boolean> {
    try {
      await this.#ensureTenantConfig();
      return await this.#executor.renewLock(lockName, ttlMs);
    } catch {
      return false;
    }
  }

  async unlock(lockName: string): Promise<void> {
    try {
      await this.#ensureTenantConfig();
      await this.#executor.unlock(lockName);
    } catch {
      // Non-fatal
    }
  }

  async close(): Promise<void> {
    // Transaction adapter does not own the client; close is a no-op.
  }

  isOpen(): boolean {
    return true;
  }

  /**
   * Set the tenant config for the current transaction when a tenant
   * context is active. Uses is_local=true so the setting is scoped to
   * this transaction and cannot leak to other consumers.
   */
  async #ensureTenantConfig(): Promise<void> {
    const tenantId = getTenantId();
    if (!tenantId) return;
    await this.#client.query('SELECT set_config($1, $2, true)', ['app.tenant_id', tenantId]);
  }
}
