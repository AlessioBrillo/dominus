import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { SqliteProvider } from '../sqlite-adapter.js';
import { DatabaseError } from '../interface.js';
import { runMigrations } from '../../migrator.js';

describe('SqliteProvider', () => {
  let sqlite: Database.Database;
  let provider: SqliteProvider;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('foreign_keys = ON');
    runMigrations(sqlite);
    provider = new SqliteProvider(sqlite);
  });

  afterEach(async () => {
    await provider.close();
  });

  describe('exec', () => {
    it('inserts a row and returns lastInsertRowid', async () => {
      const result = await provider.exec(
        `INSERT INTO candidates (domain, tld, source, status, is_premium, pipeline_run_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ['example.com', '.com', 'closeout_csv', 'pending', 0, 'run-001'],
      );
      expect(result.changes).toBe(1);
      expect(result.lastInsertRowid).toBeGreaterThan(0);
    });

    it('updates a row and returns changes count', async () => {
      await provider.exec(
        `INSERT INTO candidates (domain, tld, source, status, is_premium, pipeline_run_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ['example.com', '.com', 'closeout_csv', 'pending', 0, 'run-001'],
      );
      const result = await provider.exec(`UPDATE candidates SET status = ? WHERE domain = ?`, [
        'scored',
        'example.com',
      ]);
      expect(result.changes).toBe(1);
    });

    it('deletes a row and returns changes count', async () => {
      await provider.exec(
        `INSERT INTO candidates (domain, tld, source, status, is_premium, pipeline_run_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ['example.com', '.com', 'closeout_csv', 'pending', 0, 'run-001'],
      );
      const result = await provider.exec('DELETE FROM candidates WHERE domain = ?', [
        'example.com',
      ]);
      expect(result.changes).toBe(1);
    });

    it('returns changes=0 for no-op update', async () => {
      const result = await provider.exec('UPDATE candidates SET status = ? WHERE domain = ?', [
        'scored',
        'nonexistent.com',
      ]);
      expect(result.changes).toBe(0);
    });
  });

  describe('query', () => {
    it('returns all rows for SELECT', async () => {
      await provider.exec(
        `INSERT INTO candidates (domain, tld, source, status, is_premium, pipeline_run_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ['example.com', '.com', 'closeout_csv', 'pending', 0, 'run-001'],
      );
      await provider.exec(
        `INSERT INTO candidates (domain, tld, source, status, is_premium, pipeline_run_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ['test.com', '.com', 'closeout_csv', 'pending', 0, 'run-001'],
      );
      const rows = await provider.query<{ domain: string }>(
        'SELECT domain FROM candidates ORDER BY domain',
      );
      expect(rows).toHaveLength(2);
      expect(rows[0]!.domain).toBe('example.com');
      expect(rows[1]!.domain).toBe('test.com');
    });

    it('returns empty array for no results', async () => {
      const rows = await provider.query<{ domain: string }>(
        'SELECT * FROM candidates WHERE domain = ?',
        ['nonexistent.com'],
      );
      expect(rows).toEqual([]);
    });
  });

  describe('queryOne', () => {
    it('returns a single row', async () => {
      await provider.exec(
        `INSERT INTO candidates (domain, tld, source, status, is_premium, pipeline_run_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ['example.com', '.com', 'closeout_csv', 'pending', 0, 'run-001'],
      );
      const row = await provider.queryOne<{ domain: string }>(
        'SELECT domain FROM candidates WHERE domain = ?',
        ['example.com'],
      );
      expect(row).not.toBeNull();
      expect(row!.domain).toBe('example.com');
    });

    it('returns null for no match', async () => {
      const row = await provider.queryOne<{ domain: string }>(
        'SELECT domain FROM candidates WHERE domain = ?',
        ['nonexistent.com'],
      );
      expect(row).toBeNull();
    });

    it('returns row with RETURNING clause', async () => {
      const row = await provider.queryOne<{ id: number }>(
        `INSERT INTO candidates (domain, tld, source, status, is_premium, pipeline_run_id)
         VALUES (?, ?, ?, ?, ?, ?)
         RETURNING id`,
        ['example.com', '.com', 'closeout_csv', 'pending', 0, 'run-001'],
      );
      expect(row).not.toBeNull();
      expect(row!.id).toBeGreaterThan(0);
    });
  });

  describe('transaction', () => {
    it('commits all operations atomically', async () => {
      const result = await provider.transaction(async (trx) => {
        await trx.exec(
          `INSERT INTO candidates (domain, tld, source, status, is_premium, pipeline_run_id)
           VALUES (?, ?, ?, ?, ?, ?)`,
          ['a.com', '.com', 'closeout_csv', 'pending', 0, 'run-001'],
        );
        await trx.exec(
          `INSERT INTO candidates (domain, tld, source, status, is_premium, pipeline_run_id)
           VALUES (?, ?, ?, ?, ?, ?)`,
          ['b.com', '.com', 'closeout_csv', 'pending', 0, 'run-001'],
        );
        return 'done';
      });
      expect(result).toBe('done');
      const rows = await provider.query<{ domain: string }>(
        'SELECT domain FROM candidates ORDER BY domain',
      );
      expect(rows).toHaveLength(2);
    });

    it('rolls back on error', async () => {
      await expect(
        provider.transaction(async (trx) => {
          await trx.exec(
            `INSERT INTO candidates (domain, tld, source, status, is_premium, pipeline_run_id)
             VALUES (?, ?, ?, ?, ?, ?)`,
            ['a.com', '.com', 'closeout_csv', 'pending', 0, 'run-001'],
          );
          throw new Error('rollback test');
        }),
      ).rejects.toThrow('rollback test');
      const rows = await provider.query<{ domain: string }>('SELECT domain FROM candidates');
      expect(rows).toHaveLength(0);
    });

    it('nests savepoints correctly', async () => {
      const result = await provider.transaction(async (outer) => {
        await outer.exec(
          `INSERT INTO candidates (domain, tld, source, status, is_premium, pipeline_run_id)
           VALUES (?, ?, ?, ?, ?, ?)`,
          ['outer.com', '.com', 'closeout_csv', 'pending', 0, 'run-001'],
        );
        await outer.transaction(async (inner) => {
          await inner.exec(
            `INSERT INTO candidates (domain, tld, source, status, is_premium, pipeline_run_id)
             VALUES (?, ?, ?, ?, ?, ?)`,
            ['inner.com', '.com', 'closeout_csv', 'pending', 0, 'run-001'],
          );
        });
        return 'ok';
      });
      expect(result).toBe('ok');
      const rows = await provider.query<{ domain: string }>(
        'SELECT domain FROM candidates ORDER BY domain',
      );
      expect(rows).toHaveLength(2);
    });
  });

  describe('isOpen and close', () => {
    it('returns true when open', () => {
      expect(provider.isOpen()).toBe(true);
    });

    it('returns false after close', async () => {
      await provider.close();
      expect(provider.isOpen()).toBe(false);
    });

    it('is idempotent on close', async () => {
      await provider.close();
      await provider.close();
      expect(provider.isOpen()).toBe(false);
    });
  });

  describe('DatabaseError wrapping', () => {
    it('wraps errors on closed database', async () => {
      const closed = new SqliteProvider(sqlite);
      await closed.close();
      try {
        await closed.exec('SELECT 1');
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(DatabaseError);
      }
    });
  });
});
