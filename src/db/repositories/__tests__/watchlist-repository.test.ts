import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../migrator.js';
import { WatchlistRepository } from '../watchlist-repository.js';
import { DomainStatus } from '../../../types/domain-status.js';

function openTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

describe('WatchlistRepository', () => {
  let db: Database.Database;
  let repo: WatchlistRepository;

  beforeEach(() => {
    db = openTestDb();
    repo = new WatchlistRepository(db);
  });

  describe('insert', () => {
    it('inserts a new entry and returns it with id', () => {
      const entry = repo.insert({ domain: 'example.com', tld: 'com' });
      expect(entry.id).toBeGreaterThan(0);
      expect(entry.domain).toBe('example.com');
      expect(entry.tld).toBe('com');
      expect(entry.notes).toBeNull();
      expect(entry.lastCheckedAt).toBeNull();
      expect(entry.notified).toBe(0);
    });

    it('accepts optional notes', () => {
      const entry = repo.insert({ domain: 'test.io', tld: 'io', notes: 'interesting domain' });
      expect(entry.notes).toBe('interesting domain');
    });

    it('rejects duplicate domain', () => {
      repo.insert({ domain: 'example.com', tld: 'com' });
      expect(() => repo.insert({ domain: 'example.com', tld: 'com' })).toThrow();
    });
  });

  describe('findByDomain', () => {
    it('returns entry for existing domain', () => {
      repo.insert({ domain: 'example.com', tld: 'com' });
      const entry = repo.findByDomain('example.com');
      expect(entry).not.toBeNull();
      expect(entry!.domain).toBe('example.com');
    });

    it('returns null for non-existing domain', () => {
      const entry = repo.findByDomain('nonexistent.com');
      expect(entry).toBeNull();
    });
  });

  describe('list', () => {
    it('returns all entries ordered by created_at desc', () => {
      repo.insert({ domain: 'first.com', tld: 'com' });
      repo.insert({ domain: 'second.io', tld: 'io' });
      const entries = repo.list();
      expect(entries).toHaveLength(2);
      expect(entries[0]!.domain).toBe('second.io');
      expect(entries[1]!.domain).toBe('first.com');
    });

    it('returns empty array when no entries', () => {
      expect(repo.list()).toHaveLength(0);
    });
  });

  describe('listPendingPoll', () => {
    it('returns entries with notified=0', () => {
      repo.insert({ domain: 'pending.com', tld: 'com' });
      repo.insert({ domain: 'notified.com', tld: 'com' });
      db.prepare(
        "UPDATE watchlist_entries SET notified = 1, last_checked_at = datetime('now') WHERE domain = 'notified.com'",
      ).run();

      const pending = repo.listPendingPoll(24);
      expect(pending).toHaveLength(1);
      expect(pending[0]!.domain).toBe('pending.com');
    });

    it('returns entries with last_checked_at older than hours', () => {
      repo.insert({ domain: 'old.com', tld: 'com' });
      db.prepare(
        "UPDATE watchlist_entries SET notified = 1, last_checked_at = datetime('now', '-48 hours') WHERE domain = 'old.com'",
      ).run();

      const pending = repo.listPendingPoll(24);
      expect(pending).toHaveLength(1);
      expect(pending[0]!.domain).toBe('old.com');
    });
  });

  describe('updateStatus', () => {
    it('updates status fields and returns updated entry', () => {
      repo.insert({ domain: 'example.com', tld: 'com' });
      const updated = repo.updateStatus('example.com', {
        lastCheckedAt: '2026-01-01T00:00:00Z',
        lastStatus: DomainStatus.Available,
        lastStatusChange: '2026-01-01T00:00:00Z',
      });
      expect(updated.lastStatus).toBe(DomainStatus.Available);
      expect(updated.lastCheckedAt).toBe('2026-01-01T00:00:00Z');
    });

    it('can set notified flag', () => {
      repo.insert({ domain: 'example.com', tld: 'com' });
      repo.updateStatus('example.com', {
        lastCheckedAt: '2026-01-01T00:00:00Z',
        lastStatus: DomainStatus.Available,
        lastStatusChange: null,
        notified: 1,
      });
      const entry = repo.findByDomain('example.com');
      expect(entry!.notified).toBe(1);
    });
  });

  describe('markNotified', () => {
    it('sets notified to 1', () => {
      repo.insert({ domain: 'example.com', tld: 'com' });
      repo.markNotified('example.com');
      const entry = repo.findByDomain('example.com');
      expect(entry!.notified).toBe(1);
    });
  });

  describe('remove', () => {
    it('removes entry and returns true', () => {
      repo.insert({ domain: 'example.com', tld: 'com' });
      const removed = repo.remove('example.com');
      expect(removed).toBe(true);
      expect(repo.findByDomain('example.com')).toBeNull();
    });

    it('returns false for non-existing entry', () => {
      expect(repo.remove('nonexistent.com')).toBe(false);
    });
  });

  describe('count', () => {
    it('returns number of entries', () => {
      expect(repo.count()).toBe(0);
      repo.insert({ domain: 'a.com', tld: 'com' });
      repo.insert({ domain: 'b.io', tld: 'io' });
      expect(repo.count()).toBe(2);
    });
  });
});
