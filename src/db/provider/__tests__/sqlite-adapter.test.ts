import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { SqliteProvider } from '../sqlite-adapter.js';
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

  afterEach(() => {
    provider.close();
  });

  describe('exec', () => {
    it('inserts a row and returns lastInsertRowid', () => {
      const result = provider.exec(
        `INSERT INTO candidates (domain, tld, source, status, is_premium, pipeline_run_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ['example.com', '.com', 'closeout_csv', 'pending', 0, 'run-001'],
      );
      expect(result.changes).toBe(1);
      expect(result.lastInsertRowid).toBeGreaterThan(0);
    });

    it('updates a row and returns changes count', () => {
      provider.exec(
        `INSERT INTO candidates (domain, tld, source, status, is_premium, pipeline_run_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ['example.com', '.com', 'closeout_csv', 'pending', 0, 'run-001'],
      );
      const result = provider.exec('UPDATE candidates SET status = ? WHERE domain = ?', [
        'scored',
        'example.com',
      ]);
      expect(result.changes).toBe(1);
    });

    it('deletes a row and returns changes count', () => {
      provider.exec(
        `INSERT INTO candidates (domain, tld, source, status, is_premium, pipeline_run_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ['example.com', '.com', 'closeout_csv', 'pending', 0, 'run-001'],
      );
      const result = provider.exec('DELETE FROM candidates WHERE domain = ?', ['example.com']);
      expect(result.changes).toBe(1);
    });
  });

  describe('query', () => {
    it('returns all rows for SELECT', () => {
      provider.exec(
        `INSERT INTO candidates (domain, tld, source, status, is_premium, pipeline_run_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ['example.com', '.com', 'closeout_csv', 'pending', 0, 'run-001'],
      );
      provider.exec(
        `INSERT INTO candidates (domain, tld, source, status, is_premium, pipeline_run_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ['test.com', '.com', 'closeout_csv', 'pending', 0, 'run-001'],
      );
      const rows = provider.query<{ domain: string }>(
        'SELECT domain FROM candidates ORDER BY domain',
      );
      expect(rows).toHaveLength(2);
      expect(rows[0]!.domain).toBe('example.com');
      expect(rows[1]!.domain).toBe('test.com');
    });

    it('returns empty array for no results', () => {
      const rows = provider.query<{ domain: string }>('SELECT * FROM candidates WHERE domain = ?', [
        'nonexistent.com',
      ]);
      expect(rows).toEqual([]);
    });
  });

  describe('queryOne', () => {
    it('returns a single row', () => {
      provider.exec(
        `INSERT INTO candidates (domain, tld, source, status, is_premium, pipeline_run_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ['example.com', '.com', 'closeout_csv', 'pending', 0, 'run-001'],
      );
      const row = provider.queryOne<{ domain: string }>(
        'SELECT domain FROM candidates WHERE domain = ?',
        ['example.com'],
      );
      expect(row).not.toBeNull();
      expect(row!.domain).toBe('example.com');
    });

    it('returns null for no match', () => {
      const row = provider.queryOne<{ domain: string }>(
        'SELECT domain FROM candidates WHERE domain = ?',
        ['nonexistent.com'],
      );
      expect(row).toBeNull();
    });

    it('returns row with RETURNING clause', () => {
      const row = provider.queryOne<{ id: number }>(
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
    it('commits all operations atomically', () => {
      const result = provider.transaction((trx) => {
        trx.exec(
          `INSERT INTO candidates (domain, tld, source, status, is_premium, pipeline_run_id)
           VALUES (?, ?, ?, ?, ?, ?)`,
          ['a.com', '.com', 'closeout_csv', 'pending', 0, 'run-001'],
        );
        trx.exec(
          `INSERT INTO candidates (domain, tld, source, status, is_premium, pipeline_run_id)
           VALUES (?, ?, ?, ?, ?, ?)`,
          ['b.com', '.com', 'closeout_csv', 'pending', 0, 'run-001'],
        );
        return 'done';
      });
      expect(result).toBe('done');
      const rows = provider.query<{ domain: string }>(
        'SELECT domain FROM candidates ORDER BY domain',
      );
      expect(rows).toHaveLength(2);
    });

    it('rolls back on error', () => {
      expect(() =>
        provider.transaction((trx) => {
          trx.exec(
            `INSERT INTO candidates (domain, tld, source, status, is_premium, pipeline_run_id)
             VALUES (?, ?, ?, ?, ?, ?)`,
            ['a.com', '.com', 'closeout_csv', 'pending', 0, 'run-001'],
          );
          throw new Error('rollback test');
        }),
      ).toThrow('rollback test');
      const rows = provider.query<{ domain: string }>('SELECT domain FROM candidates');
      expect(rows).toHaveLength(0);
    });

    it('nests savepoints correctly', () => {
      provider.transaction((outer) => {
        outer.exec(
          `INSERT INTO candidates (domain, tld, source, status, is_premium, pipeline_run_id)
           VALUES (?, ?, ?, ?, ?, ?)`,
          ['outer.com', '.com', 'closeout_csv', 'pending', 0, 'run-001'],
        );
        outer.transaction((inner) => {
          inner.exec(
            `INSERT INTO candidates (domain, tld, source, status, is_premium, pipeline_run_id)
             VALUES (?, ?, ?, ?, ?, ?)`,
            ['inner.com', '.com', 'closeout_csv', 'pending', 0, 'run-001'],
          );
        });
      });
      const rows = provider.query<{ domain: string }>(
        'SELECT domain FROM candidates ORDER BY domain',
      );
      expect(rows).toHaveLength(2);
    });
  });

  describe('isOpen and close', () => {
    it('tracks open state', () => {
      expect(provider.isOpen()).toBe(true);
      provider.close();
      expect(provider.isOpen()).toBe(false);
    });

    it('is idempotent on close', () => {
      provider.close();
      provider.close();
      expect(provider.isOpen()).toBe(false);
    });
  });
});
