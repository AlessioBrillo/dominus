// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteProvider } from '../../db/provider/sqlite-adapter.js';
import { UsageRepository } from '../../db/repositories/usage-repository.js';
import { SubscriptionRepository } from '../../db/repositories/subscription-repository.js';
import { UsageMeterService } from '../usage-meter-service.js';

describe('UsageMeterService', () => {
  let db: SqliteProvider;
  let usageRepo: UsageRepository;
  let subRepo: SubscriptionRepository;
  let service: UsageMeterService;

  beforeEach(async () => {
    db = SqliteProvider.openInMemory();
    await db.runMigrations();
    usageRepo = new UsageRepository(db);
    subRepo = new SubscriptionRepository(db);
    service = new UsageMeterService(usageRepo, subRepo);
  });

  afterEach(async () => {
    await db.close();
  });

  const PERIOD = '2026-07-01';
  const TENANT = 'tenant-1';

  describe('record', () => {
    it('records usage within limits', async () => {
      await subRepo.ensureDefault(TENANT);
      await expect(service.record(TENANT, 'candidates_scored', 1, PERIOD)).resolves.not.toThrow();
    });

    it('throws when usage exceeds plan limit', async () => {
      await subRepo.ensureDefault(TENANT);
      await service.record(TENANT, 'candidates_scored', 50, PERIOD);
      await expect(service.record(TENANT, 'candidates_scored', 1, PERIOD)).rejects.toThrow(
        /Usage limit exceeded/i,
      );
    });

    it('records usage incrementally', async () => {
      await subRepo.ensureDefault(TENANT);
      await service.record(TENANT, 'candidates_scored', 10, PERIOD);
      await service.record(TENANT, 'candidates_scored', 10, PERIOD);
      const usage = await service.getUsageForPeriod(TENANT, 'candidates_scored', PERIOD);
      expect(usage.currentUsage).toBe(20);
    });

    it('returns usage info after recording', async () => {
      await subRepo.ensureDefault(TENANT);
      const info = await service.record(TENANT, 'candidates_scored', 5, PERIOD);
      expect(info.feature).toBe('candidates_scored');
      expect(info.currentUsage).toBe(5);
      expect(info.limitValue).toBe(50);
      expect(info.remaining).toBe(45);
      expect(info.isOverLimit).toBe(false);
      expect(info.plan).toBe('free');
    });

    it('allows unlimited usage for enterprise', async () => {
      await subRepo.upsert({
        tenantId: TENANT,
        plan: 'enterprise',
        status: 'active',
      });
      for (let i = 0; i < 100; i++) {
        await service.record(TENANT, 'candidates_scored', 10, PERIOD);
      }
      const usage = await service.getUsageForPeriod(TENANT, 'candidates_scored', PERIOD);
      expect(usage.isOverLimit).toBe(false);
    });

    it('rejects recording for a tenant without a subscription', async () => {
      await expect(service.record(TENANT, 'candidates_scored', 5, PERIOD)).rejects.toThrow(
        /no active subscription/i,
      );
    });

    it('enforces free limits when the subscription is past_due', async () => {
      await subRepo.upsert({ tenantId: TENANT, plan: 'pro', status: 'past_due' });
      await service.record(TENANT, 'candidates_scored', 50, PERIOD);
      await expect(service.record(TENANT, 'candidates_scored', 1, PERIOD)).rejects.toThrow(
        /Usage limit exceeded/i,
      );
      const usage = await service.getUsageForPeriod(TENANT, 'candidates_scored', PERIOD);
      expect(usage.plan).toBe('free');
      expect(usage.limitValue).toBe(50);
    });

    it('enforces free limits when the subscription is canceled', async () => {
      await subRepo.upsert({ tenantId: TENANT, plan: 'team', status: 'canceled' });
      await service.record(TENANT, 'candidates_scored', 50, PERIOD);
      await expect(service.record(TENANT, 'candidates_scored', 1, PERIOD)).rejects.toThrow(
        /Usage limit exceeded/i,
      );
    });

    it('keeps paid limits while the subscription is trialing', async () => {
      await subRepo.upsert({ tenantId: TENANT, plan: 'team', status: 'trialing' });
      const info = await service.record(TENANT, 'candidates_scored', 100, PERIOD);
      expect(info.plan).toBe('team');
      expect(info.limitValue).toBe(2500);
    });

    describe('with auto-provisioning enabled', () => {
      let autoService: UsageMeterService;

      beforeEach(() => {
        autoService = new UsageMeterService(usageRepo, subRepo, {
          autoProvisionTenants: true,
        });
      });

      it('provisions a free subscription on first record', async () => {
        const info = await autoService.record(TENANT, 'api_calls', 1, PERIOD);
        expect(info.plan).toBe('free');
        expect(info.currentUsage).toBe(1);
        expect(info.remaining).toBe(999);
      });

      it('is idempotent across concurrent first calls', async () => {
        await Promise.all([
          autoService.record(TENANT, 'api_calls', 1, PERIOD),
          autoService.record(TENANT, 'api_calls', 1, PERIOD),
        ]);
        const usage = await autoService.getUsageForPeriod(TENANT, 'api_calls', PERIOD);
        expect(usage.currentUsage).toBe(2);
      });
    });

    it('records different features independently', async () => {
      await subRepo.ensureDefault(TENANT);
      await service.record(TENANT, 'candidates_scored', 50, PERIOD);
      await expect(service.record(TENANT, 'api_calls', 10, PERIOD)).resolves.not.toThrow();
    });
  });

  describe('check', () => {
    it('returns false when within limits', async () => {
      await subRepo.ensureDefault(TENANT);
      const result = await service.check(TENANT, 'candidates_scored', PERIOD);
      expect(result.isOverLimit).toBe(false);
    });

    it('returns true when over limit', async () => {
      await subRepo.ensureDefault(TENANT);
      await usageRepo.incrementUsage(TENANT, 'candidates_scored', 100, PERIOD);
      const result = await service.check(TENANT, 'candidates_scored', PERIOD);
      expect(result.isOverLimit).toBe(true);
    });
  });

  describe('getUsageForPeriod', () => {
    it('returns zero usage with limit for unused feature', async () => {
      await subRepo.ensureDefault(TENANT);
      const usage = await service.getUsageForPeriod(TENANT, 'candidates_scored', PERIOD);
      expect(usage.currentUsage).toBe(0);
      expect(usage.limitValue).toBe(50);
      expect(usage.remaining).toBe(50);
      expect(usage.isOverLimit).toBe(false);
    });

    it('reports correct remaining for pro plan', async () => {
      await subRepo.upsert({ tenantId: TENANT, plan: 'pro', status: 'active' });
      await usageRepo.incrementUsage(TENANT, 'candidates_scored', 100, PERIOD);
      const usage = await service.getUsageForPeriod(TENANT, 'candidates_scored', PERIOD);
      expect(usage.currentUsage).toBe(100);
      expect(usage.limitValue).toBe(500);
      expect(usage.remaining).toBe(400);
    });

    it('reports null remaining for unlimited plan', async () => {
      await subRepo.upsert({ tenantId: TENANT, plan: 'enterprise', status: 'active' });
      const usage = await service.getUsageForPeriod(TENANT, 'candidates_scored', PERIOD);
      expect(usage.limitValue).toBeNull();
      expect(usage.remaining).toBeNull();
      expect(usage.isOverLimit).toBe(false);
    });
  });

  describe('periodStart', () => {
    it('computes period start from date', () => {
      const start = UsageMeterService.periodStart('2026-07-15T10:30:00.000Z');
      expect(start).toBe('2026-07-01');
    });

    it('handles January correctly', () => {
      const start = UsageMeterService.periodStart('2026-01-05T00:00:00.000Z');
      expect(start).toBe('2026-01-01');
    });

    it('handles December correctly', () => {
      const start = UsageMeterService.periodStart('2026-12-31T23:59:59.000Z');
      expect(start).toBe('2026-12-01');
    });
  });

  describe('getUsageHistory', () => {
    it('returns zero-filled history for months without usage', async () => {
      await subRepo.ensureDefault(TENANT);
      const history = await service.getUsageHistory(TENANT, 3);

      expect(history).toHaveLength(3);
      const first = history[0]!;
      expect(first.plan).toBe('free');
      expect(first.periodStart).toMatch(/^\d{4}-\d{2}-01$/);
      expect(first.usage.candidates_scored.currentUsage).toBe(0);
      expect(first.usage.candidates_scored.limitValue).toBe(50);
      expect(first.usage.candidates_scored.isOverLimit).toBe(false);
      expect(first.usage.api_calls.limitValue).toBe(1000);
      expect(first.usage.domains_tracked.limitValue).toBe(25);
    });

    it('aggregates usage per feature per month, oldest first', async () => {
      await subRepo.ensureDefault(TENANT);
      const current = UsageMeterService.periodStart(new Date().toISOString());
      const prev = new Date();
      prev.setUTCMonth(prev.getUTCMonth() - 1);
      const prevPeriod = UsageMeterService.periodStart(prev.toISOString());

      await usageRepo.incrementUsage(TENANT, 'candidates_scored', 10, current);
      await usageRepo.incrementUsage(TENANT, 'candidates_scored', 5, current);
      await usageRepo.incrementUsage(TENANT, 'api_calls', 42, prevPeriod);

      const history = await service.getUsageHistory(TENANT, 2);
      expect(history[0]!.periodStart).toBe(prevPeriod);
      expect(history[0]!.usage.api_calls.currentUsage).toBe(42);
      expect(history[1]!.periodStart).toBe(current);
      expect(history[1]!.usage.candidates_scored.currentUsage).toBe(15);
    });

    it('resolves limits from the effective plan (past_due fails closed)', async () => {
      await subRepo.upsert({ tenantId: TENANT, plan: 'pro', status: 'past_due' });
      const history = await service.getUsageHistory(TENANT, 1);

      expect(history[0]!.plan).toBe('free');
      expect(history[0]!.usage.candidates_scored.limitValue).toBe(50);
    });
  });
});
