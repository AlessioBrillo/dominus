// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteProvider } from '../../db/provider/sqlite-adapter.js';
import { AdminRepository } from '../../db/repositories/admin-repository.js';
import { UsageRepository } from '../../db/repositories/usage-repository.js';
import { CustomPriceRepository } from '../../db/repositories/custom-price-repository.js';
import { AdminService } from '../admin-service.js';

describe('AdminService', () => {
  let db: SqliteProvider;
  let service: AdminService;

  beforeEach(async () => {
    db = SqliteProvider.openInMemory();
    await db.runMigrations();
    service = new AdminService(
      new AdminRepository(db),
      new UsageRepository(db),
      new CustomPriceRepository(db),
    );
  });

  afterEach(async () => {
    await db.close();
  });

  const PERIOD = '2026-08-01';

  function seedSubscription(tenantId: string, plan: string, status: string): void {
    db.exec(
      `INSERT INTO tenant_subscriptions (tenant_id, plan, status, stripe_customer_id)
       VALUES (?, ?, ?, ?)`,
      [tenantId, plan, status, `cus_${tenantId}`],
    );
  }

  function seedApiKey(tenantId: string, name: string, lastUsedAt: string | null = null): void {
    db.exec(
      `INSERT INTO api_keys (tenant_id, name, key_hash, key_prefix, role, expires_at, last_used_at)
       VALUES (?, ?, ?, ?, 'admin', NULL, ?)`,
      [tenantId, name, `hash-${tenantId}-${name}`, `pre_${tenantId}_${name}`, lastUsedAt],
    );
  }

  function seedUsage(tenantId: string, feature: string, amount: number): void {
    db.exec(
      `INSERT INTO usage_records (tenant_id, feature, amount, period_start, recorded_at)
       VALUES (?, ?, ?, ?, datetime('now'))`,
      [tenantId, feature, amount, PERIOD],
    );
  }

  describe('overview', () => {
    it('reports totals across all tenants for the period', async () => {
      seedSubscription('tenant-a', 'pro', 'active');
      seedSubscription('tenant-b', 'enterprise', 'past_due');
      seedSubscription('tenant-c', 'free', 'active');
      seedUsage('tenant-a', 'candidates_scored', 10);
      seedUsage('tenant-b', 'candidates_scored', 25);
      seedUsage('tenant-a', 'api_calls', 300);
      seedUsage('tenant-c', 'api_calls', 50);

      const overview = await service.overview(PERIOD);
      expect(overview.tenantsCount).toBe(3);
      expect(overview.activeSubscriptions).toBe(2);
      // tenant-b is past_due, so only tenant-a counts as a paid active plan.
      expect(overview.paidPlans).toBe(1);
      expect(overview.candidatesScoredTotal).toBe(35);
      expect(overview.apiCallsTotal).toBe(350);
      expect(overview.periodStart).toBe(PERIOD);
    });

    it('reports zeros when no tenants exist', async () => {
      const overview = await service.overview(PERIOD);
      expect(overview.tenantsCount).toBe(0);
      expect(overview.activeSubscriptions).toBe(0);
      expect(overview.paidPlans).toBe(0);
      expect(overview.candidatesScoredTotal).toBe(0);
      expect(overview.apiCallsTotal).toBe(0);
    });
  });

  describe('listTenants', () => {
    it('summarises plan, status, key count and per-feature usage with limits', async () => {
      seedSubscription('tenant-a', 'pro', 'active');
      seedApiKey('tenant-a', 'ops-1');
      seedApiKey('tenant-a', 'ops-2');
      seedUsage('tenant-a', 'candidates_scored', 20);
      seedUsage('tenant-a', 'api_calls', 5);

      const tenants = await service.listTenants(PERIOD);
      expect(tenants).toHaveLength(1);

      const tenant = tenants[0]!;
      expect(tenant.tenantId).toBe('tenant-a');
      expect(tenant.plan).toBe('pro');
      expect(tenant.status).toBe('active');
      expect(tenant.apiKeyCount).toBe(2);

      const usageByFeature = Object.fromEntries(tenant.usage.map((u) => [u.feature, u]));
      expect(usageByFeature['candidates_scored']).toEqual({
        feature: 'candidates_scored',
        used: 20,
        limit: 500,
      });
      expect(usageByFeature['api_calls']).toEqual({
        feature: 'api_calls',
        used: 5,
        limit: 10000,
      });
      expect(usageByFeature['domains_tracked']).toEqual({
        feature: 'domains_tracked',
        used: 0,
        limit: 250,
      });
    });

    it('defaults a tenant without a subscription row to the free plan', async () => {
      seedApiKey('tenant-x', 'ci');
      seedUsage('tenant-x', 'candidates_scored', 3);

      const tenants = await service.listTenants(PERIOD);
      expect(tenants).toHaveLength(1);
      expect(tenants[0]!.plan).toBe('free');
      expect(tenants[0]!.status).toBe('active');
      expect(tenants[0]!.usage.find((u) => u.feature === 'candidates_scored')).toEqual({
        feature: 'candidates_scored',
        used: 3,
        limit: 50,
      });
    });

    it('applies unlimited limits for enterprise', async () => {
      seedSubscription('tenant-e', 'enterprise', 'active');
      seedUsage('tenant-e', 'api_calls', 999999);

      const tenants = await service.listTenants(PERIOD);
      expect(tenants[0]!.usage.find((u) => u.feature === 'api_calls')?.limit).toBeNull();
    });

    it('marks suspended tenants in the list', async () => {
      seedApiKey('tenant-x', 'ci');
      await db.exec(
        `INSERT INTO tenant_admin_flags (tenant_id, suspended_at, suspended_reason)
         VALUES ('tenant-x', '2026-08-13T10:00:00Z', 'abuse')`,
      );

      const tenants = await service.listTenants(PERIOD);
      expect(tenants[0]!.suspended).toBe(true);
    });

    it('leaves non-suspended tenants unflagged', async () => {
      seedApiKey('tenant-x', 'ci');
      const tenants = await service.listTenants(PERIOD);
      expect(tenants[0]!.suspended).toBe(false);
    });
  });

  describe('tenantDetail', () => {
    it('returns the summary plus operator flags', async () => {
      seedSubscription('tenant-a', 'pro', 'active');
      await db.exec(
        `INSERT INTO tenant_admin_flags (tenant_id, plan_override)
         VALUES ('tenant-a', 'enterprise')`,
      );

      const detail = await service.tenantDetail('tenant-a', PERIOD);
      expect(detail?.tenantId).toBe('tenant-a');
      expect(detail?.flags?.planOverride).toBe('enterprise');
      expect(detail?.flags?.suspendedAt).toBeNull();
    });

    it('returns null for an unknown tenant', async () => {
      expect(await service.tenantDetail('ghost', PERIOD)).toBeNull();
    });

    it('returns null flags when no flag row exists', async () => {
      seedSubscription('tenant-a', 'pro', 'active');
      const detail = await service.tenantDetail('tenant-a', PERIOD);
      expect(detail?.flags).toBeNull();
    });
  });

  describe('tenantUsageSeries', () => {
    it('returns the daily series from the repository', async () => {
      db.exec(
        `INSERT INTO usage_records (tenant_id, feature, amount, period_start, recorded_at)
         VALUES ('tenant-a', 'api_calls', 4, ?, '2026-08-05T10:00:00Z')`,
        [PERIOD],
      );

      const series = await service.tenantUsageSeries('tenant-a', '2026-08-01T00:00:00Z');
      expect(series).toHaveLength(1);
      expect(series[0]).toEqual({
        date: '2026-08-05',
        feature: 'api_calls',
        amount: 4,
      });
    });
  });

  describe('suspendTenant / unsuspendTenant', () => {
    it('suspends a tenant with the given reason', async () => {
      const flag = await service.suspendTenant('tenant-a', 'Payment overdue');
      expect(flag.suspendedAt).not.toBeNull();
      expect(flag.suspendedReason).toBe('Payment overdue');
    });

    it('suspending again updates the flag idempotently', async () => {
      await service.suspendTenant('tenant-a', 'first');
      const flag = await service.suspendTenant('tenant-a', 'second');
      expect(flag.suspendedReason).toBe('second');
    });

    it('unsuspends a tenant and clears the reason', async () => {
      await service.suspendTenant('tenant-a', 'abuse');
      const flag = await service.unsuspendTenant('tenant-a');
      expect(flag?.suspendedAt).toBeNull();
      expect(flag?.suspendedReason).toBeNull();
    });

    it('unsuspending a tenant without a flag returns a row with nulls', async () => {
      const flag = await service.unsuspendTenant('tenant-a');
      expect(flag?.suspendedAt).toBeNull();
    });
  });

  describe('setPlanOverride', () => {
    it('sets an enterprise override', async () => {
      const flag = await service.setPlanOverride('tenant-a', 'enterprise');
      expect(flag?.planOverride).toBe('enterprise');
    });

    it('clears the override when plan is null', async () => {
      await service.setPlanOverride('tenant-a', 'enterprise');
      const flag = await service.setPlanOverride('tenant-a', null);
      expect(flag?.planOverride).toBeNull();
    });
  });
});
