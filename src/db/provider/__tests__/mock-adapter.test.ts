import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MockDatabaseProvider } from '../mock-adapter.js';

describe('MockDatabaseProvider', () => {
  let mock: MockDatabaseProvider;

  beforeEach(() => {
    mock = new MockDatabaseProvider();
  });

  afterEach(async () => {
    await mock.close();
  });

  describe('exec', () => {
    it('records exec calls', async () => {
      await mock.exec('INSERT INTO test (name) VALUES (?)', ['hello']);
      expect(mock.calls).toHaveLength(1);
      expect(mock.calls[0]!.method).toBe('exec');
      expect(mock.calls[0]!.sql).toContain('INSERT');
      expect(mock.calls[0]!.params).toEqual(['hello']);
    });

    it('returns lastInsertRowid', async () => {
      const r1 = await mock.exec('INSERT INTO test VALUES (?)', ['a']);
      const r2 = await mock.exec('INSERT INTO test VALUES (?)', ['b']);
      expect(r1.lastInsertRowid).toBe(1);
      expect(r2.lastInsertRowid).toBe(2);
    });
  });

  describe('query / queryOne', () => {
    it('records query calls', async () => {
      await mock.query('SELECT * FROM test');
      expect(mock.calls).toHaveLength(1);
      expect(mock.calls[0]!.method).toBe('query');
    });

    it('records queryOne calls', async () => {
      await mock.queryOne('SELECT * FROM test WHERE id = ?', [1]);
      expect(mock.calls).toHaveLength(1);
      expect(mock.calls[0]!.method).toBe('queryOne');
      expect(mock.calls[0]!.params).toEqual([1]);
    });

    it('returns empty results by default', async () => {
      expect(await mock.query('SELECT * FROM test')).toEqual([]);
      expect(await mock.queryOne('SELECT * FROM test')).toBeNull();
    });
  });

  describe('transaction', () => {
    it('executes fn within transaction scope', async () => {
      let inTrx = false;
      await mock.transaction(async (trx) => {
        inTrx = true;
        await trx.exec('INSERT INTO test VALUES (?)', ['inside']);
      });
      expect(inTrx).toBe(true);
    });

    it('rolls back on error', async () => {
      await expect(
        mock.transaction(async (_trx) => {
          throw new Error('txn fail');
        }),
      ).rejects.toThrow('txn fail');
    });
  });

  describe('isOpen / close / reset', () => {
    it('manages lifecycle', async () => {
      expect(mock.isOpen()).toBe(true);
      await mock.close();
      expect(mock.isOpen()).toBe(false);
    });

    it('reset clears calls and tables', async () => {
      await mock.exec('INSERT INTO x VALUES (1)');
      expect(mock.calls).toHaveLength(1);
      mock.reset();
      expect(mock.calls).toHaveLength(0);
      expect(mock.isOpen()).toBe(true);
    });
  });

  describe('addTable and getAllRows', () => {
    it('manages mock table data', () => {
      mock.addTable('users', ['id', 'name'], [{ id: 1, name: 'Alice' }]);
      const rows = mock.getAllRows<{ id: number; name: string }>('users');
      expect(rows).toHaveLength(1);
      expect(rows[0]!.name).toBe('Alice');
    });

    it('returns empty for unknown table', () => {
      expect(mock.getAllRows('unknown')).toEqual([]);
    });
  });
});
