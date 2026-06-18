import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../db/migrator.js';
import { SqliteProvider } from '../../../db/provider/sqlite-adapter.js';
import { TrademarkRepository } from '../trademark-repository.js';

function openTestDb(): SqliteProvider {
  const provider = new SqliteProvider(new Database(':memory:'));
  provider.rawDb.pragma('journal_mode = WAL');
  provider.rawDb.pragma('foreign_keys = ON');
  runMigrations(provider.rawDb);
  return provider;
}

describe('TrademarkRepository', () => {
  let provider: SqliteProvider;
  let repo: TrademarkRepository;

  beforeEach(() => {
    provider = openTestDb();
    repo = new TrademarkRepository(provider);
  });

  describe('pruneExpired', () => {
    it('deletes only rows whose expires_at is in the past', () => {
      // Arrange
      repo.insertByTerm('fresh', 'USPTO', false, [], { hits: [] }, 7);
      repo.insertByTerm('expired-1', 'USPTO', false, [], { hits: [] }, -1);
      repo.insertByTerm('expired-2', 'EUIPO', false, [], { hits: [] }, -2);

      // Act
      const removed = repo.pruneExpired();

      // Assert
      expect(removed).toBe(2);
      expect(repo.count()).toBe(1);
    });

    it('is idempotent — a second call is a no-op', () => {
      // Arrange
      repo.insertByTerm('expired', 'USPTO', false, [], { hits: [] }, -1);

      // Act
      const first = repo.pruneExpired();
      const second = repo.pruneExpired();

      // Assert
      expect(first).toBe(1);
      expect(second).toBe(0);
    });

    it('respects the optional "now" cutoff for deterministic tests', () => {
      // Arrange
      repo.insertByTerm('old', 'USPTO', false, [], { hits: [] }, -1);

      // Act — pretend "now" is before the row's expires_at, so the row is kept
      const removed = repo.pruneExpired('2020-01-01T00:00:00.000Z');

      // Assert
      expect(removed).toBe(0);
      expect(repo.count()).toBe(1);
    });
  });

  describe('count', () => {
    it('returns 0 on a fresh database', () => {
      expect(repo.count()).toBe(0);
    });
  });
});
