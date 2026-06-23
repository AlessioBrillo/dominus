import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../migrator.js';
import { SqliteProvider } from '../../provider/sqlite-adapter.js';
import { OutcomeRepository } from '../outcome-repository.js';
import { PortfolioRepository } from '../portfolio-repository.js';
import { DomainNotFoundError } from '../../../types/errors.js';
import type { RecordOutcomeInput } from '../../../types/outcome.js';

function openTestDb(): SqliteProvider {
  const provider = new SqliteProvider(new Database(':memory:'));
  provider.rawDb.pragma('journal_mode = WAL');
  provider.rawDb.pragma('foreign_keys = ON');
  runMigrations(provider.rawDb);
  return provider;
}

async function seedPortfolio(provider: SqliteProvider, domain: string): Promise<void> {
  const repo = new PortfolioRepository(provider);
  await repo.insert({
    domain,
    tld: '.com',
    acquiredAt: '2025-01-01T00:00:00.000Z',
    renewalDate: '2026-01-01T00:00:00.000Z',
    acquisitionCost: 12,
    renewalCost: 12,
    registrar: 'namecheap',
  });
}

function makeInput(overrides: Partial<RecordOutcomeInput> = {}): RecordOutcomeInput {
  return {
    domain: 'example.com',
    type: 'renewed',
    occurredAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('OutcomeRepository', () => {
  let provider: SqliteProvider;
  let repo: OutcomeRepository;

  beforeEach(async () => {
    provider = openTestDb();
    repo = new OutcomeRepository(provider);
    await seedPortfolio(provider, 'example.com');
  });

  describe('insert', () => {
    it('inserts a new outcome and returns it with an id', async () => {
      // Act
      const out = await repo.insert(makeInput({ type: 'renewed' }));

      // Assert
      expect(out.id).toBeTypeOf('number');
      expect(out.id).toBeGreaterThan(0);
      expect(out.domain).toBe('example.com');
      expect(out.type).toBe('renewed');
      expect(out.occurredAt).toBe('2026-01-01T00:00:00.000Z');
    });

    it('persists all optional fields when provided', async () => {
      // Act
      const out = await repo.insert(
        makeInput({
          type: 'sold',
          salePriceEur: 1500,
          listingPriceEur: 1800,
          daysListed: 240,
          venue: 'sedo',
          commissionPct: 15,
          notes: 'Inbound offer accepted',
        }),
      );

      // Assert
      expect(out.salePriceEur).toBe(1500);
      expect(out.listingPriceEur).toBe(1800);
      expect(out.daysListed).toBe(240);
      expect(out.venue).toBe('sedo');
      expect(out.commissionPct).toBe(15);
      expect(out.notes).toBe('Inbound offer accepted');
    });

    it('throws DomainNotFoundError when the domain is not in the portfolio', async () => {
      // Act + Assert
      await expect(repo.insert(makeInput({ domain: 'missing.com' }))).rejects.toThrow(
        DomainNotFoundError,
      );
    });
  });

  describe('findByDomain', () => {
    it('returns outcomes most recent first', async () => {
      // Arrange
      await seedPortfolio(provider, 'second.com');
      await repo.insert(makeInput({ occurredAt: '2025-06-01T00:00:00.000Z' }));
      await repo.insert(makeInput({ occurredAt: '2026-03-01T00:00:00.000Z' }));
      await repo.insert(
        makeInput({ occurredAt: '2025-12-01T00:00:00.000Z', type: 'sold', domain: 'second.com' }),
      );

      // Act
      const a = await repo.findByDomain('example.com');
      const b = await repo.findByDomain('second.com');

      // Assert
      expect(a.map((o) => o.occurredAt)).toEqual([
        '2026-03-01T00:00:00.000Z',
        '2025-06-01T00:00:00.000Z',
      ]);
      expect(b.map((o) => o.occurredAt)).toEqual(['2025-12-01T00:00:00.000Z']);
    });

    it('returns an empty array when the domain has no outcomes', async () => {
      // Act + Assert
      expect(await repo.findByDomain('example.com')).toEqual([]);
    });
  });

  describe('findByType', () => {
    it('filters by outcome type', async () => {
      // Arrange
      await repo.insert(makeInput({ type: 'renewed' }));
      await repo.insert(
        makeInput({ type: 'sold', salePriceEur: 1000, occurredAt: '2026-02-01T00:00:00.000Z' }),
      );
      await repo.insert(makeInput({ type: 'dropped', occurredAt: '2026-02-15T00:00:00.000Z' }));

      // Act
      const sold = await repo.findByType('sold');
      const dropped = await repo.findByType('dropped');

      // Assert
      expect(sold).toHaveLength(1);
      expect(sold[0]?.salePriceEur).toBe(1000);
      expect(dropped).toHaveLength(1);
    });
  });

  describe('statsByDomain', () => {
    it('counts and sums outcomes per type', async () => {
      // Arrange
      await repo.insert(makeInput({ type: 'renewed', occurredAt: '2025-12-01T00:00:00.000Z' }));
      await repo.insert(
        makeInput({ type: 'sold', salePriceEur: 800, occurredAt: '2026-04-01T00:00:00.000Z' }),
      );
      await repo.insert(
        makeInput({ type: 'sold', salePriceEur: 1200, occurredAt: '2026-05-01T00:00:00.000Z' }),
      );
      await repo.insert(makeInput({ type: 'dropped', occurredAt: '2026-06-01T00:00:00.000Z' }));

      // Act
      const stats = await repo.statsByDomain('example.com');

      // Assert
      expect(stats).toEqual({
        sold: 2,
        dropped: 1,
        expired: 0,
        renewed: 1,
        totalRealisedEur: 2000,
      });
    });

    it('returns zeros for a domain with no outcomes', async () => {
      // Act
      await seedPortfolio(provider, 'empty.com');
      const stats = await repo.statsByDomain('empty.com');

      // Assert
      expect(stats).toEqual({
        sold: 0,
        dropped: 0,
        expired: 0,
        renewed: 0,
        totalRealisedEur: 0,
      });
    });
  });

  describe('cascading delete', () => {
    it('removes outcomes when the parent portfolio entry is deleted', async () => {
      // Arrange
      const portfolio = new PortfolioRepository(provider);
      await repo.insert(makeInput({ type: 'renewed' }));
      expect(await repo.findByDomain('example.com')).toHaveLength(1);

      // Act
      await portfolio.delete('example.com');

      // Assert
      expect(await repo.findByDomain('example.com')).toEqual([]);
    });
  });
});
