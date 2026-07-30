import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteProvider } from '../../provider/sqlite-adapter.js';
import { UsageRepository } from '../usage-repository.js';

describe('UsageRepository', () => {
  let db: SqliteProvider;
  let repo: UsageRepository;

  beforeEach(async () => {
    db = SqliteProvider.openInMemory();
    await db.runMigrations();
    repo = new UsageRepository(db);
  });

  afterEach(async () => {
    await db.close();
  });

  const PERIOD = '2026-07-01';

  describe('incrementUsage', () => {
    it('creates a new usage record and accumulates', async () => {
      await repo.incrementUsage('tenant-1', 'candidates_scored', 5, PERIOD);
      const total = await repo.getUsageForPeriod('tenant-1', 'candidates_scored', PERIOD);
      expect(total).toBe(5);
    });

    it('accumulates on repeated calls', async () => {
      await repo.incrementUsage('tenant-1', 'candidates_scored', 5, PERIOD);
      await repo.incrementUsage('tenant-1', 'candidates_scored', 3, PERIOD);
      const total = await repo.getUsageForPeriod('tenant-1', 'candidates_scored', PERIOD);
      expect(total).toBe(8);
    });

    it('separates usage by tenant', async () => {
      await repo.incrementUsage('tenant-a', 'candidates_scored', 10, PERIOD);
      await repo.incrementUsage('tenant-b', 'candidates_scored', 20, PERIOD);
      expect(await repo.getUsageForPeriod('tenant-a', 'candidates_scored', PERIOD)).toBe(10);
      expect(await repo.getUsageForPeriod('tenant-b', 'candidates_scored', PERIOD)).toBe(20);
    });

    it('separates usage by period', async () => {
      await repo.incrementUsage('tenant-1', 'candidates_scored', 10, '2026-07-01');
      await repo.incrementUsage('tenant-1', 'candidates_scored', 20, '2026-08-01');
      expect(await repo.getUsageForPeriod('tenant-1', 'candidates_scored', '2026-07-01')).toBe(10);
      expect(await repo.getUsageForPeriod('tenant-1', 'candidates_scored', '2026-08-01')).toBe(20);
    });

    it('separates usage by feature', async () => {
      await repo.incrementUsage('tenant-1', 'candidates_scored', 5, PERIOD);
      await repo.incrementUsage('tenant-1', 'api_calls', 100, PERIOD);
      expect(await repo.getUsageForPeriod('tenant-1', 'candidates_scored', PERIOD)).toBe(5);
      expect(await repo.getUsageForPeriod('tenant-1', 'api_calls', PERIOD)).toBe(100);
    });

    it('returns 0 for unused feature', async () => {
      const total = await repo.getUsageForPeriod('tenant-1', 'candidates_scored', PERIOD);
      expect(total).toBe(0);
    });
  });

  describe('getUsage', () => {
    it('returns full record when exists', async () => {
      await repo.incrementUsage('tenant-1', 'candidates_scored', 5, PERIOD);
      const record = await repo.getUsage('tenant-1', 'candidates_scored', PERIOD);
      expect(record).not.toBeUndefined();
      expect(record!.tenantId).toBe('tenant-1');
      expect(record!.feature).toBe('candidates_scored');
      expect(record!.amount).toBe(5);
      expect(record!.periodStart).toBe(PERIOD);
    });

    it('returns undefined when not found', async () => {
      const record = await repo.getUsage('tenant-1', 'candidates_scored', PERIOD);
      expect(record).toBeUndefined();
    });
  });

  describe('plan limits', () => {
    it('returns seeded plan limits from migration', async () => {
      const free = await repo.getPlanLimit('free', 'candidates_scored');
      expect(free).not.toBeUndefined();
      expect(free!.plan).toBe('free');
      expect(free!.limitValue).toBe(50);
    });

    it('returns undefined for unknown plan', async () => {
      const limit = await repo.getPlanLimit('free', 'domains_tracked');
      expect(limit).not.toBeUndefined();
    });

    it('returns all limits for a plan', async () => {
      const limits = await repo.getAllPlanLimits('free');
      expect(limits.length).toBeGreaterThanOrEqual(3);
      const scored = limits.find((l) => l.feature === 'candidates_scored');
      expect(scored?.limitValue).toBe(50);
    });

    it('sets a new plan limit', async () => {
      await repo.setPlanLimit('free', 'candidates_scored', 100);
      const limit = await repo.getPlanLimit('free', 'candidates_scored');
      expect(limit!.limitValue).toBe(100);
    });

    it('sets a null (unlimited) limit', async () => {
      await repo.setPlanLimit('free', 'candidates_scored', null);
      const limit = await repo.getPlanLimit('free', 'candidates_scored');
      expect(limit!.limitValue).toBeNull();
    });

    it('shows enterprise as unlimited', async () => {
      const limit = await repo.getPlanLimit('enterprise', 'candidates_scored');
      expect(limit!.limitValue).toBeNull();
    });
  });

  describe('deleteUsageOlderThan', () => {
    it('deletes records older than cutoff', async () => {
      await repo.incrementUsage('tenant-1', 'candidates_scored', 5, PERIOD);
      const deleted = await repo.deleteUsageOlderThan('2099-01-01');
      expect(deleted).toBe(1);
    });

    it('does not delete recent records', async () => {
      await repo.incrementUsage('tenant-1', 'candidates_scored', 5, PERIOD);
      const deleted = await repo.deleteUsageOlderThan('2020-01-01');
      expect(deleted).toBe(0);
    });
  });
});
