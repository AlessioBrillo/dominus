import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../migrator.js';
import { SqliteProvider } from '../../provider/sqlite-adapter.js';
import { WatchlistRepository } from '../watchlist-repository.js';
import { DomainStatus } from '../../../types/domain-status.js';

function openTestDb(): SqliteProvider {
  const provider = new SqliteProvider(new Database(':memory:'));
  provider.rawDb.pragma('journal_mode = WAL');
  provider.rawDb.pragma('foreign_keys = ON');
  runMigrations(provider.rawDb);
  return provider;
}

describe('WatchlistRepository', () => {
  let provider: SqliteProvider;
  let repo: WatchlistRepository;

  beforeEach(() => {
    provider = openTestDb();
    repo = new WatchlistRepository(provider);
  });

  describe('insert', () => {
    it('inserts a new entry and returns it with id', async () => {
      const entry = await repo.insert({ domain: 'example.com', tld: 'com' });
      expect(entry.id).toBeGreaterThan(0);
      expect(entry.domain).toBe('example.com');
      expect(entry.tld).toBe('com');
      expect(entry.notes).toBeNull();
      expect(entry.lastCheckedAt).toBeNull();
      expect(entry.notified).toBe(0);
    });

    it('accepts optional notes', async () => {
      const entry = await repo.insert({
        domain: 'test.io',
        tld: 'io',
        notes: 'interesting domain',
      });
      expect(entry.notes).toBe('interesting domain');
    });

    it('rejects duplicate domain', async () => {
      await repo.insert({ domain: 'example.com', tld: 'com' });
      await expect(repo.insert({ domain: 'example.com', tld: 'com' })).rejects.toThrow();
    });
  });

  describe('findByDomain', () => {
    it('returns entry for existing domain', async () => {
      await repo.insert({ domain: 'example.com', tld: 'com' });
      const entry = await repo.findByDomain('example.com');
      expect(entry).not.toBeNull();
      expect(entry!.domain).toBe('example.com');
    });

    it('returns null for non-existing domain', async () => {
      const entry = await repo.findByDomain('nonexistent.com');
      expect(entry).toBeNull();
    });
  });

  describe('list', () => {
    it('returns all entries ordered by created_at desc', async () => {
      await repo.insert({ domain: 'first.com', tld: 'com' });
      await repo.insert({ domain: 'second.io', tld: 'io' });
      const entries = await repo.list();
      expect(entries).toHaveLength(2);
      expect(entries[0]!.domain).toBe('second.io');
      expect(entries[1]!.domain).toBe('first.com');
    });

    it('returns empty array when no entries', async () => {
      expect(await repo.list()).toHaveLength(0);
    });
  });

  describe('listPendingPoll', () => {
    it('returns entries with notified=0', async () => {
      await repo.insert({ domain: 'pending.com', tld: 'com' });
      await repo.insert({ domain: 'notified.com', tld: 'com' });
      provider.rawDb
        .prepare(
          "UPDATE watchlist_entries SET notified = 1, last_checked_at = datetime('now') WHERE domain = 'notified.com'",
        )
        .run();

      const pending = await repo.listPendingPoll(24);
      expect(pending).toHaveLength(1);
      expect(pending[0]!.domain).toBe('pending.com');
    });

    it('returns entries with last_checked_at older than hours', async () => {
      await repo.insert({ domain: 'old.com', tld: 'com' });
      provider.rawDb
        .prepare(
          "UPDATE watchlist_entries SET notified = 1, last_checked_at = datetime('now', '-48 hours') WHERE domain = 'old.com'",
        )
        .run();

      const pending = await repo.listPendingPoll(24);
      expect(pending).toHaveLength(1);
      expect(pending[0]!.domain).toBe('old.com');
    });
  });

  describe('updateStatus', () => {
    it('updates status fields and returns updated entry', async () => {
      await repo.insert({ domain: 'example.com', tld: 'com' });
      const updated = await repo.updateStatus('example.com', {
        lastCheckedAt: '2026-01-01T00:00:00Z',
        lastStatus: DomainStatus.Available,
        lastStatusChange: '2026-01-01T00:00:00Z',
      });
      expect(updated.lastStatus).toBe(DomainStatus.Available);
      expect(updated.lastCheckedAt).toBe('2026-01-01T00:00:00Z');
    });

    it('can set notified flag', async () => {
      await repo.insert({ domain: 'example.com', tld: 'com' });
      await repo.updateStatus('example.com', {
        lastCheckedAt: '2026-01-01T00:00:00Z',
        lastStatus: DomainStatus.Available,
        lastStatusChange: null,
        notified: 1,
      });
      const entry = await repo.findByDomain('example.com');
      expect(entry!.notified).toBe(1);
    });
  });

  describe('markNotified', () => {
    it('sets notified to 1', async () => {
      await repo.insert({ domain: 'example.com', tld: 'com' });
      await repo.markNotified('example.com');
      const entry = await repo.findByDomain('example.com');
      expect(entry!.notified).toBe(1);
    });
  });

  describe('remove', () => {
    it('removes entry and returns true', async () => {
      await repo.insert({ domain: 'example.com', tld: 'com' });
      const removed = await repo.remove('example.com');
      expect(removed).toBe(true);
      expect(await repo.findByDomain('example.com')).toBeNull();
    });

    it('returns false for non-existing entry', async () => {
      expect(await repo.remove('nonexistent.com')).toBe(false);
    });
  });

  describe('count', () => {
    it('returns number of entries', async () => {
      expect(await repo.count()).toBe(0);
      await repo.insert({ domain: 'a.com', tld: 'com' });
      await repo.insert({ domain: 'b.io', tld: 'io' });
      expect(await repo.count()).toBe(2);
    });
  });
});
