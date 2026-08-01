// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabasePool, PooledSqliteProvider } from '../database-pool.js';
import type { DatabaseProvider } from '../provider/interface.js';

describe('DatabasePool', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'dominus-pool-test-'));
    dbPath = join(tmpDir, 'test.db');
  });

  describe('constructor', () => {
    it('creates a pool with lazy connection initialization', () => {
      const pool = new DatabasePool(dbPath, 3, 30000, 5000);
      expect(pool).toBeInstanceOf(DatabasePool);
      expect(pool.totalConnections).toBe(0);
      pool.close();
    });
  });

  describe('acquire read', () => {
    it('returns a read connection with long busy_timeout', () => {
      const pool = new DatabasePool(dbPath, 3, 30000, 5000);
      const conn = pool.acquire('read');
      expect(conn.open).toBe(true);
      const bt = conn.pragma('busy_timeout', { simple: true }) as number;
      expect(bt).toBe(30000);
      expect(pool.totalConnections).toBe(1);
      pool.release(conn);
      pool.close();
    });

    it('creates separate connection when read is busy and max allows', () => {
      const pool = new DatabasePool(dbPath, 3, 30000, 5000);
      const r1 = pool.acquire('read');
      const r2 = pool.acquire('read');
      expect(r1).not.toBe(r2);
      expect(r1.open).toBe(true);
      expect(r2.open).toBe(true);
      expect(pool.totalConnections).toBe(2);
      pool.release(r1);
      pool.release(r2);
      pool.close();
    });

    it('reuses released read connection', () => {
      const pool = new DatabasePool(dbPath, 1, 30000, 5000);
      const r1 = pool.acquire('read');
      pool.release(r1);
      const r2 = pool.acquire('read');
      expect(r1).toBe(r2);
      pool.release(r2);
      pool.close();
    });
  });

  describe('acquire write', () => {
    it('returns a write connection with short busy_timeout', () => {
      const pool = new DatabasePool(dbPath, 2, 30000, 5000);
      const conn = pool.acquire('write');
      expect(conn.open).toBe(true);
      const bt = conn.pragma('busy_timeout', { simple: true }) as number;
      expect(bt).toBe(5000);
      expect(pool.totalConnections).toBe(1);
      pool.release(conn);
      pool.close();
    });

    it('does not share connections between read and write', () => {
      const pool = new DatabasePool(dbPath, 3, 30000, 5000);
      const r = pool.acquire('read');
      const w = pool.acquire('write');
      expect(r).not.toBe(w);
      pool.release(r);
      pool.release(w);
      pool.close();
    });
  });

  describe('concurrency limits', () => {
    it('throws when all connections are busy', () => {
      const pool = new DatabasePool(dbPath, 1, 30000, 5000);
      pool.acquire('read');
      expect(() => pool.acquire('read')).toThrow('database pool exhausted');
      pool.close();
    });

    it('throws when write is busy and no more connections available', () => {
      const pool = new DatabasePool(dbPath, 2, 30000, 5000);
      pool.acquire('read');
      pool.acquire('write');
      expect(() => pool.acquire('read')).toThrow('database pool exhausted');
      pool.close();
    });
  });

  describe('WAL and FK pragmas', () => {
    it('enables WAL and foreign_keys on every connection', () => {
      const pool = new DatabasePool(dbPath, 3, 30000, 5000);
      const r = pool.acquire('read');
      const w = pool.acquire('write');
      for (const c of [r, w]) {
        const jm = c.pragma('journal_mode', { simple: true }) as string;
        const fk = c.pragma('foreign_keys', { simple: true }) as number;
        expect(jm).toBe('wal');
        expect(fk).toBe(1);
      }
      pool.release(r);
      pool.release(w);
      pool.close();
    });
  });

  describe('close', () => {
    it('closes all connections and prevents further acquire', () => {
      const pool = new DatabasePool(dbPath, 2, 30000, 5000);
      const r = pool.acquire('read');
      const w = pool.acquire('write');
      pool.release(r);
      pool.release(w);
      pool.close();
      expect(pool.totalConnections).toBe(0);
      expect(() => pool.acquire('read')).toThrow('DatabasePool is closed');
    });
  });
});

describe('PooledSqliteProvider', () => {
  let tmpDir: string;
  let dbPath: string;
  let pool: DatabasePool;
  let provider: DatabaseProvider;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'dominus-pooled-provider-'));
    dbPath = join(tmpDir, 'test.db');
    pool = new DatabasePool(dbPath, 3, 30000, 5000);
    provider = new PooledSqliteProvider(pool);
  });

  afterEach(async () => {
    await provider.close();
    pool.close();
  });

  describe('exec', () => {
    it('inserts and returns lastInsertRowid via write connection', async () => {
      await provider.exec('CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)');
      const result = await provider.exec('INSERT INTO test (name) VALUES (?)', ['hello']);
      expect(result.changes).toBe(1);
      expect(result.lastInsertRowid).toBeGreaterThan(0);
    });
  });

  describe('query', () => {
    it('reads data via read connection', async () => {
      await provider.exec('CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)');
      await provider.exec('INSERT INTO test (name) VALUES (?)', ['alpha']);
      await provider.exec('INSERT INTO test (name) VALUES (?)', ['beta']);
      const rows = await provider.query<{ name: string }>('SELECT * FROM test ORDER BY id');
      expect(rows).toHaveLength(2);
      expect(rows[0]!.name).toBe('alpha');
      expect(rows[1]!.name).toBe('beta');
    });
  });

  describe('queryOne', () => {
    it('returns a single row', async () => {
      await provider.exec('CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)');
      await provider.exec('INSERT INTO test (name) VALUES (?)', ['only']);
      const row = await provider.queryOne<{ name: string }>(
        'SELECT name FROM test WHERE name = ?',
        ['only'],
      );
      expect(row).not.toBeNull();
      expect(row!.name).toBe('only');
    });
  });

  describe('transaction', () => {
    it('commits atomically', async () => {
      await provider.exec('CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)');
      const result = await provider.transaction(async (trx) => {
        await trx.exec('INSERT INTO test (name) VALUES (?)', ['a']);
        await trx.exec('INSERT INTO test (name) VALUES (?)', ['b']);
        return 'done';
      });
      expect(result).toBe('done');
      const rows = await provider.query<{ name: string }>('SELECT * FROM test ORDER BY id');
      expect(rows).toHaveLength(2);
    });

    it('rolls back on error', async () => {
      await provider.exec('CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)');
      await expect(() =>
        provider.transaction(async (trx) => {
          await trx.exec('INSERT INTO test (name) VALUES (?)', ['x']);
          throw new Error('rollback test');
        }),
      ).rejects.toThrow('rollback test');
      const rows = await provider.query<{ name: string }>('SELECT * FROM test');
      expect(rows).toHaveLength(0);
    });
  });

  describe('isOpen', () => {
    it('tracks open state', async () => {
      expect(provider.isOpen()).toBe(true);
      await provider.close();
      expect(provider.isOpen()).toBe(false);
    });
  });
});
