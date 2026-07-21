import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../db/migrator.js';
import { PortfolioRepository } from '../../db/repositories/portfolio-repository.js';
import { SqliteProvider } from '../../db/provider/sqlite-adapter.js';
import { PortfolioManager } from '../portfolio-manager.js';
import { Verdict } from '../../types/portfolio.js';
import type { AddPortfolioEntryInput } from '../../types/portfolio.js';

function openTestDb(): SqliteProvider {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return new SqliteProvider(db);
}

function makeAddInput(
  domain: string,
  overrides: Partial<AddPortfolioEntryInput> = {},
): AddPortfolioEntryInput {
  return {
    domain,
    tld: '.com',
    acquiredAt: '2025-01-01T00:00:00.000Z',
    renewalDate: '2026-01-01T00:00:00.000Z',
    acquisitionCost: 10,
    renewalCost: 10,
    registrar: 'namecheap',
    ...overrides,
  };
}

describe('PortfolioManager (CRUD)', () => {
  let db: SqliteProvider;
  let repo: PortfolioRepository;
  let manager: PortfolioManager;

  beforeEach(() => {
    db = openTestDb();
    repo = new PortfolioRepository(db);
    manager = new PortfolioManager(repo, 25, 60);
  });

  describe('add', () => {
    it('adds a domain to the portfolio', async () => {
      const entry = await manager.add(makeAddInput('example.com'));
      expect(entry.domain).toBe('example.com');
      expect(entry.acquisitionCost).toBe(10);
    });

    it('throws on duplicate domain', async () => {
      await manager.add(makeAddInput('example.com'));
      await expect(manager.add(makeAddInput('example.com'))).rejects.toThrow();
    });

    it('preserves notes on add', async () => {
      const entry = await manager.add(makeAddInput('example.com', { notes: 'test note' }));
      expect(entry.notes).toBe('test note');
    });
  });

  describe('list', () => {
    it('returns empty array when portfolio is empty', async () => {
      const result = await manager.list();
      expect(result).toEqual([]);
    });

    it('returns all entries with renewal clock', async () => {
      await manager.add(makeAddInput('alpha.com'));
      await manager.add(makeAddInput('beta.com'));
      const result = await manager.list();
      expect(result).toHaveLength(2);
      for (const item of result) {
        expect(item.renewalClock).toBeDefined();
        expect(item.renewalClock.domain).toBe(item.entry.domain);
      }
    });
  });

  describe('updateCosts', () => {
    it('updates acquisition cost', async () => {
      await manager.add(makeAddInput('example.com'));
      await manager.updateCosts('example.com', 100);
      const list = await manager.list();
      expect(list[0]!.entry.acquisitionCost).toBe(100);
    });

    it('updates renewal cost', async () => {
      await manager.add(makeAddInput('example.com'));
      await manager.updateCosts('example.com', undefined, 25);
      const list = await manager.list();
      expect(list[0]!.entry.renewalCost).toBe(25);
    });

    it('updates both costs simultaneously', async () => {
      await manager.add(makeAddInput('example.com'));
      await manager.updateCosts('example.com', 200, 30);
      const list = await manager.list();
      expect(list[0]!.entry.acquisitionCost).toBe(200);
      expect(list[0]!.entry.renewalCost).toBe(30);
    });
  });

  describe('updateVerdict', () => {
    it('updates the verdict for a domain', async () => {
      await manager.add(makeAddInput('example.com'));
      await manager.updateVerdict('example.com', Verdict.Drop, 'low score');
      const list = await manager.list();
      expect(list[0]!.entry.verdict).toBe(Verdict.Drop);
      expect(list[0]!.entry.verdictReason).toBe('low score');
    });
  });

  describe('updateNotes', () => {
    it('updates notes on a domain', async () => {
      await manager.add(makeAddInput('example.com'));
      await manager.updateNotes('example.com', 'priority domain');
      const list = await manager.list();
      expect(list[0]!.entry.notes).toBe('priority domain');
    });
  });

  describe('updateScore', () => {
    it('updates score and list price', async () => {
      await manager.add(makeAddInput('example.com'));
      await manager.updateScore('example.com', 65, 1500);
      const list = await manager.list();
      expect(list[0]!.entry.currentScore).toBe(65);
      expect(list[0]!.entry.suggestedListPrice).toBe(1500);
    });
  });

  describe('remove', () => {
    it('removes a domain from the portfolio', async () => {
      await manager.add(makeAddInput('example.com'));
      await manager.remove('example.com');
      const list = await manager.list();
      expect(list).toHaveLength(0);
    });
  });

  describe('refreshVerdicts', () => {
    it('updates verdict for a low-score domain approaching renewal', async () => {
      const renewal = new Date(Date.now() + 30 * 86_400_000).toISOString();
      await manager.add(
        makeAddInput('low.com', { renewalDate: renewal, acquisitionCost: 12, renewalCost: 12 }),
      );
      await manager.updateScore('low.com', 10, 50);

      await manager.refreshVerdicts();
      const entry = await repo.findByDomain('low.com');
      expect(entry?.verdict).toBe(Verdict.Drop);
    });

    it('does not change verdict when Keep conditions are satisfied', async () => {
      const renewal = new Date(Date.now() + 200 * 86_400_000).toISOString();
      await manager.add(makeAddInput('good.com', { renewalDate: renewal }));
      await manager.updateScore('good.com', 60, 1000);

      await manager.refreshVerdicts();
      const entry = await repo.findByDomain('good.com');
      expect(entry?.verdict).toBe(Verdict.Keep);
    });

    it('returns Reprice for unscored domain', async () => {
      await manager.add(makeAddInput('unscored.com'));
      await manager.refreshVerdicts();
      const entry = await repo.findByDomain('unscored.com');
      expect(entry?.verdict).toBe(Verdict.Reprice);
    });
  });
});
