import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MockDatabaseProvider } from '../mock-adapter.js';

describe('MockDatabaseProvider', () => {
  let mock: MockDatabaseProvider;

  beforeEach(() => {
    mock = new MockDatabaseProvider();
  });

  afterEach(() => {
    mock.close();
  });

  describe('exec', () => {
    it('records exec calls', () => {
      mock.exec('INSERT INTO test (name) VALUES (?)', ['hello']);
      expect(mock.calls).toHaveLength(1);
      expect(mock.calls[0]!.method).toBe('exec');
      expect(mock.calls[0]!.sql).toContain('INSERT');
      expect(mock.calls[0]!.params).toEqual(['hello']);
    });

    it('returns lastInsertRowid', () => {
      const r1 = mock.exec('INSERT INTO test VALUES (?)', ['a']);
      const r2 = mock.exec('INSERT INTO test VALUES (?)', ['b']);
      expect(r1.lastInsertRowid).toBe(1);
      expect(r2.lastInsertRowid).toBe(2);
    });
  });

  describe('query / queryOne', () => {
    it('records query calls', () => {
      mock.query('SELECT * FROM test');
      expect(mock.calls).toHaveLength(1);
      expect(mock.calls[0]!.method).toBe('query');
    });

    it('records queryOne calls', () => {
      mock.queryOne('SELECT * FROM test WHERE id = ?', [1]);
      expect(mock.calls).toHaveLength(1);
      expect(mock.calls[0]!.method).toBe('queryOne');
      expect(mock.calls[0]!.params).toEqual([1]);
    });

    it('returns empty results by default', () => {
      expect(mock.query('SELECT * FROM test')).toEqual([]);
      expect(mock.queryOne('SELECT * FROM test')).toBeNull();
    });
  });

  describe('transaction', () => {
    it('executes fn within transaction scope', () => {
      let called = false;
      mock.transaction((trx) => {
        called = true;
        trx.exec('INSERT INTO test VALUES (?)', ['inside']);
      });
      expect(called).toBe(true);
    });

    it('propagates errors', () => {
      expect(() =>
        mock.transaction((_trx) => {
          throw new Error('txn fail');
        }),
      ).toThrow('txn fail');
    });
  });

  describe('isOpen / close / reset', () => {
    it('manages lifecycle', () => {
      expect(mock.isOpen()).toBe(true);
      mock.close();
      expect(mock.isOpen()).toBe(false);
    });

    it('reset clears calls and tables', () => {
      mock.exec('INSERT INTO x VALUES (1)', []);
      expect(mock.calls).toHaveLength(1);
      mock.reset();
      expect(mock.calls).toHaveLength(0);
      expect(mock.isOpen()).toBe(true);
    });
  });

  describe('addTable and hasTable', () => {
    it('manages mock table registry', () => {
      mock.addTable('users');
      expect(mock.hasTable('users')).toBe(true);
    });

    it('returns false for unknown table', () => {
      expect(mock.hasTable('unknown')).toBe(false);
    });
  });
});
