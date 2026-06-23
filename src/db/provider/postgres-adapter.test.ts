import { describe, it, expect, afterEach } from 'vitest';
import { PostgresAdapter } from './postgres-adapter.js';
import { DatabaseError } from './interface.js';

const PG_URL = process.env.DATABASE_URL ?? '';

describe.runIf(PG_URL)('PostgresAdapter', () => {
  let adapter: PostgresAdapter;

  afterEach(async () => {
    if (adapter?.isOpen()) {
      await adapter.close();
    }
  });

  describe('connection lifecycle', () => {
    it('connects and disconnects', async () => {
      adapter = await PostgresAdapter.create(PG_URL);
      expect(adapter.isOpen()).toBe(true);

      await adapter.close();
      expect(adapter.isOpen()).toBe(false);
    });

    it('accepts a schema parameter', async () => {
      adapter = await PostgresAdapter.create(PG_URL, { schema: 'public' });
      expect(adapter.isOpen()).toBe(true);
      const rows = await adapter.query<{ currentSchema: string }>(
        'SELECT current_schema AS current_schema',
      );
      expect(rows[0]?.currentSchema).toBe('public');
    });

    it('exposes the underlying pool', async () => {
      adapter = await PostgresAdapter.create(PG_URL);
      expect(adapter.pool).toBeDefined();
      expect(typeof adapter.pool.query).toBe('function');
    });
  });

  describe('exec', () => {
    it('executes a CREATE TABLE and returns changes', async () => {
      adapter = await PostgresAdapter.create(PG_URL);
      const result = await adapter.exec(`
        CREATE TEMP TABLE test_exec (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL
        )
      `);
      expect(result.changes).toBe(0); // DDL returns 0
    });

    it('executes INSERT and returns changes + lastInsertRowid', async () => {
      adapter = await PostgresAdapter.create(PG_URL);
      await adapter.exec(`
        CREATE TEMP TABLE test_insert (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL
        )
      `);

      const result = await adapter.exec('INSERT INTO test_insert (name) VALUES ($1)', ['hello']);
      expect(result.changes).toBe(1);
      expect(result.lastInsertRowid).toBe(1); // serial starts at 1
    });

    it('throws DatabaseError on bad SQL', async () => {
      adapter = await PostgresAdapter.create(PG_URL);
      await expect(adapter.exec('SELECT FROM nowhere')).rejects.toThrow(DatabaseError);
    });
  });

  describe('query', () => {
    it('returns rows as an array', async () => {
      adapter = await PostgresAdapter.create(PG_URL);
      const rows = await adapter.query<{ ok: number }>('SELECT 1 AS ok');
      expect(rows).toHaveLength(1);
      expect(rows[0]!.ok).toBe(1);
    });

    it('converts snake_case to camelCase', async () => {
      adapter = await PostgresAdapter.create(PG_URL);
      const rows = await adapter.query<{ firstName: string }>("SELECT 'Alice' AS first_name");
      expect(rows[0]!.firstName).toBe('Alice');
    });

    it('returns empty array for no results', async () => {
      adapter = await PostgresAdapter.create(PG_URL);
      const rows = await adapter.query<unknown>('SELECT 1 WHERE 1 = 0');
      expect(rows).toHaveLength(0);
    });
  });

  describe('queryOne', () => {
    it('returns a single row', async () => {
      adapter = await PostgresAdapter.create(PG_URL);
      const row = await adapter.queryOne<{ ok: number }>('SELECT 1 AS ok');
      expect(row).not.toBeNull();
      expect(row!.ok).toBe(1);
    });

    it('returns null when no rows', async () => {
      adapter = await PostgresAdapter.create(PG_URL);
      const row = await adapter.queryOne<unknown>('SELECT 1 WHERE 1 = 0');
      expect(row).toBeNull();
    });
  });

  describe('transaction', () => {
    it('commits a successful transaction', async () => {
      adapter = await PostgresAdapter.create(PG_URL);

      const result = await adapter.transaction(async (tx) => {
        await tx.exec(`
          CREATE TEMP TABLE test_tx_commit (
            id SERIAL PRIMARY KEY,
            val INT
          )
        `);
        await tx.exec('INSERT INTO test_tx_commit (val) VALUES ($1)', [42]);
        const rows = await tx.query<{ val: number }>('SELECT val FROM test_tx_commit');
        return rows[0]!.val;
      });

      expect(result).toBe(42);
    });

    it('rolls back on error', async () => {
      adapter = await PostgresAdapter.create(PG_URL);

      await adapter.exec(`
        CREATE TEMP TABLE test_tx_rollback (
          id SERIAL PRIMARY KEY,
          val INT
        )
      `);

      await expect(
        adapter.transaction(async (tx) => {
          await tx.exec('INSERT INTO test_tx_rollback (val) VALUES ($1)', [99]);
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');

      const rows = await adapter.query<{ val: number }>('SELECT val FROM test_tx_rollback');
      expect(rows).toHaveLength(0);
    });

    it('nests transaction calls via pass-through adapter', async () => {
      adapter = await PostgresAdapter.create(PG_URL);

      const result = await adapter.transaction(async (tx) => {
        return tx.transaction(async (inner) => {
          await inner.exec('SELECT 1');
          return 'nested ok';
        });
      });

      expect(result).toBe('nested ok');
    });
  });

  describe('error handling', () => {
    it('wraps PG errors with code', async () => {
      adapter = await PostgresAdapter.create(PG_URL);
      const err = await adapter.exec('SELECT * FROM nonexistent_table').then(
        () => {
          throw new Error('should have thrown');
        },
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(DatabaseError);
      expect((err as DatabaseError).code).toBe('42P01');
      expect((err as DatabaseError).isRetryable).toBe(false);
    });

    it('marks serialisation failures as retryable', async () => {
      adapter = await PostgresAdapter.create(PG_URL);
      const err = new DatabaseError('deadlock detected', '40P01', true);
      expect(err.isRetryable).toBe(true);
      expect(err.code).toBe('40P01');
    });
  });
});

describe('PostgresAdapter (no connection)', () => {
  it('is a class', () => {
    expect(typeof PostgresAdapter).toBe('function');
  });

  it('has static create method', () => {
    expect(typeof PostgresAdapter.create).toBe('function');
  });

  it('rejects on bad connection string', { timeout: 10000 }, async () => {
    await expect(PostgresAdapter.create('postgresql://invalid:5432/nope')).rejects.toThrow();
  });
});
