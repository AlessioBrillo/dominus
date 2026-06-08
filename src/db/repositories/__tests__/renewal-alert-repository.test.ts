import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../migrator.js';
import { RenewalAlertRepository } from '../renewal-alert-repository.js';
import { AlertType, AlertSeverity } from '../../../types/alert.js';
import type { InsertRenewalAlertInput } from '../../../types/alert.js';

function openTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function makePortfolioEntry(db: Database.Database, domain: string, renewalDate: string): number {
  const result = db
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

function insertSampleAlert(repo: RenewalAlertRepository, overrides: Partial<InsertRenewalAlertInput> & { portfolioEntryId: number } = { portfolioEntryId: testInput.portfolioEntryId }): ReturnType<typeof repo.upsert> {
  return repo.upsert({ ...testInput, ...overrides }, ['console']);
}

describe('RenewalAlertRepository', () => {
  let db: Database.Database;
  let repo: RenewalAlertRepository;

  beforeEach(() => {
    db = openTestDb();
    repo = new RenewalAlertRepository(db);
    testInput.portfolioEntryId = makePortfolioEntry(db, 'example.com', '2026-07-01');
  });

  describe('upsert', () => {
    it('inserts a new alert and returns it with id', () => {
      const alert = repo.upsert(testInput, ['console']);
      expect(alert.id).toBeGreaterThan(0);
      expect(alert.domain).toBe('example.com');
      expect(alert.alertType).toBe(AlertType.RenewalImminent);
      expect(alert.severity).toBe(AlertSeverity.Warning);
      expect(alert.notifiedChannels).toEqual(['console']);
      expect(alert.acknowledgedAt).toBeUndefined();
    });

    it('updates an existing alert on conflict (domain + alert_type)', () => {
      repo.upsert(testInput, ['console']);
      const updated = repo.upsert(
        { ...testInput, severity: AlertSeverity.Critical },
        ['console', 'desktop'],
      );
      expect(updated.severity).toBe(AlertSeverity.Critical);
      expect(updated.notifiedChannels).toEqual(['console', 'desktop']);
    });

    it('resets acknowledged_at on re-upsert', () => {
      const alert = repo.upsert(testInput, ['console']);
      repo.acknowledge(alert.id!);

      const updated = repo.upsert({ ...testInput, severity: AlertSeverity.Critical }, ['console']);
      expect(updated.acknowledgedAt).toBeUndefined();
    });
  });

  describe('findAll', () => {
    it('returns all alerts when no filters are applied', () => {
      insertSampleAlert(repo);
      insertSampleAlert(repo, {
        domain: 'other.com',
        portfolioEntryId: makePortfolioEntry(db, 'other.com', '2026-08-01'),
        alertType: AlertType.RenewalCritical,
      });

      const all = repo.findAll();
      expect(all).toHaveLength(2);
    });

    it('filters by domain when specified', () => {
      insertSampleAlert(repo);
      const otherId = makePortfolioEntry(db, 'other.com', '2026-08-01');
      insertSampleAlert(repo, { domain: 'other.com', portfolioEntryId: otherId });

      const filtered = repo.findAll('example.com');
      expect(filtered).toHaveLength(1);
      expect(filtered[0]?.domain).toBe('example.com');
    });

    it('filters to unacknowledged only', () => {
      const alert = insertSampleAlert(repo);
      repo.acknowledge(alert.id!);
      insertSampleAlert(repo, {
        domain: 'other.com',
        portfolioEntryId: makePortfolioEntry(db, 'other.com', '2026-08-01'),
        alertType: AlertType.RenewalCritical,
      });

      const unack = repo.findAll(undefined, true);
      expect(unack).toHaveLength(1);
      expect(unack[0]?.domain).toBe('other.com');
    });

    it('returns empty array when table is empty', () => {
      expect(repo.findAll()).toEqual([]);
    });
  });

  describe('findById', () => {
    it('returns the alert by id', () => {
      const alert = insertSampleAlert(repo);
      const found = repo.findById(alert.id!);
      expect(found).not.toBeNull();
      expect(found?.domain).toBe('example.com');
    });

    it('returns null for unknown id', () => {
      expect(repo.findById(999)).toBeNull();
    });
  });

  describe('acknowledge', () => {
    it('sets acknowledged_at on the alert', () => {
      const alert = insertSampleAlert(repo);
      repo.acknowledge(alert.id!);

      const found = repo.findById(alert.id!);
      expect(found?.acknowledgedAt).toBeDefined();
      const ackDate = new Date(found!.acknowledgedAt!);
      expect(ackDate.getTime()).not.toBeNaN();
    });
  });

  describe('acknowledgeAll', () => {
    it('acknowledges all unacknowledged alerts', () => {
      insertSampleAlert(repo);
      const otherId = makePortfolioEntry(db, 'other.com', '2026-08-01');
      insertSampleAlert(repo, { domain: 'other.com', portfolioEntryId: otherId });

      const n = repo.acknowledgeAll();
      expect(n).toBe(2);
      expect(repo.findAll(undefined, true)).toEqual([]);
    });

    it('acknowledges only for a specific domain', () => {
      insertSampleAlert(repo);
      const otherId = makePortfolioEntry(db, 'other.com', '2026-08-01');
      insertSampleAlert(repo, { domain: 'other.com', portfolioEntryId: otherId });

      const n = repo.acknowledgeAll('example.com');
      expect(n).toBe(1);
      expect(repo.findAll('example.com', true)).toEqual([]);
      expect(repo.findAll('other.com', true)).toHaveLength(1);
    });
  });

  describe('deleteBefore', () => {
    it('deletes acknowledged alerts older than the cutoff', () => {
      const alert = insertSampleAlert(repo);
      repo.acknowledge(alert.id!);

      const n = repo.deleteBefore('2030-01-01');
      expect(n).toBe(1);
      expect(repo.count()).toBe(0);
    });

    it('does not delete unacknowledged alerts regardless of age', () => {
      insertSampleAlert(repo);
      const n = repo.deleteBefore('2030-01-01');
      expect(n).toBe(0);
      expect(repo.count()).toBe(1);
    });
  });

  describe('count', () => {
    it('returns the total number of alerts', () => {
      insertSampleAlert(repo);
      expect(repo.count()).toBe(1);
    });

    it('returns count filtered by domain', () => {
      insertSampleAlert(repo);
      expect(repo.count('example.com')).toBe(1);
      expect(repo.count('nonexistent.com')).toBe(0);
    });
  });

  describe('latestPerDomain', () => {
    it('returns the most recent unacknowledged alert per domain', () => {
      insertSampleAlert(repo, { alertType: AlertType.RenewalImminent, portfolioEntryId: testInput.portfolioEntryId });
      insertSampleAlert(repo, { alertType: AlertType.RenewalCritical, portfolioEntryId: testInput.portfolioEntryId });
      const otherId = makePortfolioEntry(db, 'other.com', '2026-08-01');
      insertSampleAlert(repo, { domain: 'other.com', portfolioEntryId: otherId });

      const latest = repo.latestPerDomain();
      expect(latest).toHaveLength(2);
      const example = latest.find((a) => a.domain === 'example.com');
      expect(example?.alertType).toBe(AlertType.RenewalCritical);
    });

    it('excludes domains where all alerts are acknowledged', () => {
      const alert = insertSampleAlert(repo);
      repo.acknowledge(alert.id!);

      expect(repo.latestPerDomain()).toEqual([]);
    });
  });
});
