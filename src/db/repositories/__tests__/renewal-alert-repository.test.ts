import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../migrator.js';
import { SqliteProvider } from '../../provider/sqlite-adapter.js';
import { RenewalAlertRepository } from '../renewal-alert-repository.js';
import { AlertType, AlertSeverity } from '../../../types/alert.js';
import type { InsertRenewalAlertInput, RenewalAlert } from '../../../types/alert.js';

function openTestDb(): SqliteProvider {
  const provider = new SqliteProvider(new Database(':memory:'));
  provider.rawDb.pragma('journal_mode = WAL');
  provider.rawDb.pragma('foreign_keys = ON');
  runMigrations(provider.rawDb);
  return provider;
}

function makePortfolioEntry(provider: SqliteProvider, domain: string, renewalDate: string): number {
  const result = provider.rawDb
    .prepare(
      `INSERT INTO portfolio_entries (domain, tld, acquired_at, renewal_date, acquisition_cost, renewal_cost, registrar)
       VALUES (?, 'com', '2025-01-01', ?, 10, 15, 'test')`,
    )
    .run(domain, renewalDate);
  return Number(result.lastInsertRowid);
}

const testInput: InsertRenewalAlertInput = {
  domain: 'example.com',
  portfolioEntryId: 0,
  alertType: AlertType.RenewalImminent,
  severity: AlertSeverity.Warning,
  message: 'Domain example.com renews in 25 days',
};

async function insertSampleAlert(
  repo: RenewalAlertRepository,
  overrides: Partial<InsertRenewalAlertInput> & { portfolioEntryId: number } = {
    portfolioEntryId: testInput.portfolioEntryId,
  },
): Promise<RenewalAlert> {
  return await repo.upsert({ ...testInput, ...overrides }, ['console']);
}

describe('RenewalAlertRepository', () => {
  let provider: SqliteProvider;
  let repo: RenewalAlertRepository;

  beforeEach(async () => {
    provider = openTestDb();
    repo = new RenewalAlertRepository(provider);
    testInput.portfolioEntryId = makePortfolioEntry(provider, 'example.com', '2026-07-01');
  });

  describe('upsert', () => {
    it('inserts a new alert and returns it with id', async () => {
      const alert = await repo.upsert(testInput, ['console']);
      expect(alert.id).toBeGreaterThan(0);
      expect(alert.domain).toBe('example.com');
      expect(alert.alertType).toBe(AlertType.RenewalImminent);
      expect(alert.severity).toBe(AlertSeverity.Warning);
      expect(alert.notifiedChannels).toEqual(['console']);
      expect(alert.acknowledgedAt).toBeUndefined();
    });

    it('updates an existing alert on conflict (domain + alert_type)', async () => {
      await repo.upsert(testInput, ['console']);
      const updated = await repo.upsert({ ...testInput, severity: AlertSeverity.Critical }, [
        'console',
        'desktop',
      ]);
      expect(updated.severity).toBe(AlertSeverity.Critical);
      expect(updated.notifiedChannels).toEqual(['console', 'desktop']);
    });

    it('resets acknowledged_at on re-upsert', async () => {
      const alert = await repo.upsert(testInput, ['console']);
      await repo.acknowledge(alert.id!);

      const updated = await repo.upsert({ ...testInput, severity: AlertSeverity.Critical }, [
        'console',
      ]);
      expect(updated.acknowledgedAt).toBeUndefined();
    });
  });

  describe('findAll', () => {
    it('returns all alerts when no filters are applied', async () => {
      await insertSampleAlert(repo);
      await insertSampleAlert(repo, {
        domain: 'other.com',
        portfolioEntryId: makePortfolioEntry(provider, 'other.com', '2026-08-01'),
        alertType: AlertType.RenewalCritical,
      });

      const all = await repo.findAll();
      expect(all).toHaveLength(2);
    });

    it('filters by domain when specified', async () => {
      await insertSampleAlert(repo);
      const otherId = makePortfolioEntry(provider, 'other.com', '2026-08-01');
      await insertSampleAlert(repo, { domain: 'other.com', portfolioEntryId: otherId });

      const filtered = await repo.findAll('example.com');
      expect(filtered).toHaveLength(1);
      expect(filtered[0]?.domain).toBe('example.com');
    });

    it('filters to unacknowledged only', async () => {
      const alert = await insertSampleAlert(repo);
      await repo.acknowledge(alert.id!);
      await insertSampleAlert(repo, {
        domain: 'other.com',
        portfolioEntryId: makePortfolioEntry(provider, 'other.com', '2026-08-01'),
        alertType: AlertType.RenewalCritical,
      });

      const unack = await repo.findAll(undefined, true);
      expect(unack).toHaveLength(1);
      expect(unack[0]?.domain).toBe('other.com');
    });

    it('returns empty array when table is empty', async () => {
      expect(await repo.findAll()).toEqual([]);
    });
  });

  describe('findById', () => {
    it('returns the alert by id', async () => {
      const alert = await insertSampleAlert(repo);
      const found = await repo.findById(alert.id!);
      expect(found).not.toBeNull();
      expect(found?.domain).toBe('example.com');
    });

    it('returns null for unknown id', async () => {
      expect(await repo.findById(999)).toBeNull();
    });
  });

  describe('acknowledge', () => {
    it('sets acknowledged_at on the alert', async () => {
      const alert = await insertSampleAlert(repo);
      await repo.acknowledge(alert.id!);

      const found = await repo.findById(alert.id!);
      expect(found?.acknowledgedAt).toBeDefined();
      const ackDate = new Date(found!.acknowledgedAt!);
      expect(ackDate.getTime()).not.toBeNaN();
    });
  });

  describe('acknowledgeAll', () => {
    it('acknowledges all unacknowledged alerts', async () => {
      await insertSampleAlert(repo);
      const otherId = makePortfolioEntry(provider, 'other.com', '2026-08-01');
      await insertSampleAlert(repo, { domain: 'other.com', portfolioEntryId: otherId });

      const n = await repo.acknowledgeAll();
      expect(n).toBe(2);
      expect(await repo.findAll(undefined, true)).toEqual([]);
    });

    it('acknowledges only for a specific domain', async () => {
      await insertSampleAlert(repo);
      const otherId = makePortfolioEntry(provider, 'other.com', '2026-08-01');
      await insertSampleAlert(repo, { domain: 'other.com', portfolioEntryId: otherId });

      const n = await repo.acknowledgeAll('example.com');
      expect(n).toBe(1);
      expect(await repo.findAll('example.com', true)).toEqual([]);
      expect(await repo.findAll('other.com', true)).toHaveLength(1);
    });
  });

  describe('deleteBefore', () => {
    it('deletes acknowledged alerts older than the cutoff', async () => {
      const alert = await insertSampleAlert(repo);
      await repo.acknowledge(alert.id!);

      const n = await repo.deleteBefore('2030-01-01');
      expect(n).toBe(1);
      expect(await repo.count()).toBe(0);
    });

    it('does not delete unacknowledged alerts regardless of age', async () => {
      await insertSampleAlert(repo);
      const n = await repo.deleteBefore('2030-01-01');
      expect(n).toBe(0);
      expect(await repo.count()).toBe(1);
    });
  });

  describe('count', () => {
    it('returns the total number of alerts', async () => {
      await insertSampleAlert(repo);
      expect(await repo.count()).toBe(1);
    });

    it('returns count filtered by domain', async () => {
      await insertSampleAlert(repo);
      expect(await repo.count('example.com')).toBe(1);
      expect(await repo.count('nonexistent.com')).toBe(0);
    });
  });

  describe('latestPerDomain', () => {
    it('returns the most recent unacknowledged alert per domain', async () => {
      await insertSampleAlert(repo, {
        alertType: AlertType.RenewalImminent,
        portfolioEntryId: testInput.portfolioEntryId,
      });
      await insertSampleAlert(repo, {
        alertType: AlertType.RenewalCritical,
        portfolioEntryId: testInput.portfolioEntryId,
      });
      const otherId = makePortfolioEntry(provider, 'other.com', '2026-08-01');
      await insertSampleAlert(repo, { domain: 'other.com', portfolioEntryId: otherId });

      const latest = await repo.latestPerDomain();
      expect(latest).toHaveLength(2);
      const example = latest.find((a) => a.domain === 'example.com');
      expect(example?.alertType).toBe(AlertType.RenewalCritical);
    });

    it('excludes domains where all alerts are acknowledged', async () => {
      const alert = await insertSampleAlert(repo);
      await repo.acknowledge(alert.id!);

      expect(await repo.latestPerDomain()).toEqual([]);
    });
  });
});
