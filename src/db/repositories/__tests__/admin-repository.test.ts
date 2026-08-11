// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteProvider } from '../../provider/sqlite-adapter.js';
import { AdminRepository } from '../admin-repository.js';

describe('AdminRepository', () => {
  let db: SqliteProvider;
  let repo: AdminRepository;

  beforeEach(async () => {
    db = SqliteProvider.openInMemory();
    await db.runMigrations();
    repo = new AdminRepository(db);
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

  function seedUsage(tenantId: string, feature: string, amount: number, periodStart: string): void {
    db.exec(
      `INSERT INTO usage_records (tenant_id, feature, amount, period_start, recorded_at)
       VALUES (?, ?, ?, ?, datetime('now'))`,
      [tenantId, feature, amount, periodStart],
    );
  }

  describe('listTenantIds', () => {
    it('unions tenants from subscriptions, api keys and usage records', async () => {
      seedSubscription('tenant-a', 'pro', 'active');
      seedApiKey('tenant-b', 'ops');
      seedUsage('tenant-c', 'candidates_scored', 3, PERIOD);

      const ids = await repo.listTenantIds();
      expect(ids.sort()).toEqual(['tenant-a', 'tenant-b', 'tenant-c']);
    });

    it('deduplicates tenants appearing in multiple sources', async () => {
      seedSubscription('tenant-a', 'pro', 'active');
      seedApiKey('tenant-a', 'ops');
      seedUsage('tenant-a', 'api_calls', 10, PERIOD);

      const ids = await repo.listTenantIds();
      expect(ids).toHaveLength(1);
      expect(ids).toEqual(['tenant-a']);
    });

    it('returns an empty list when no tenants exist', async () => {
      const ids = await repo.listTenantIds();
      expect(ids).toEqual([]);
    });
  });

  describe('listSubscriptions', () => {
    it('returns subscriptions for all tenants', async () => {
      seedSubscription('tenant-a', 'pro', 'active');
      seedSubscription('tenant-b', 'enterprise', 'past_due');

      const subs = await repo.listSubscriptions();
      expect(subs).toHaveLength(2);
      expect(subs.map((s) => s.tenantId).sort()).toEqual(['tenant-a', 'tenant-b']);
    });

    it('returns an empty list when no subscriptions exist', async () => {
      expect(await repo.listSubscriptions()).toEqual([]);
    });
  });

  describe('countApiKeysPerTenant', () => {
    it('counts keys per tenant and excludes tenants without keys', async () => {
      seedApiKey('tenant-a', 'ops-1');
      seedApiKey('tenant-a', 'ops-2');
      seedApiKey('tenant-b', 'ci');

      const counts = await repo.countApiKeysPerTenant();
      const byTenant = Object.fromEntries(counts.map((c) => [c.tenantId, c.count]));
      expect(byTenant).toEqual({ 'tenant-a': 2, 'tenant-b': 1 });
    });

    it('returns an empty list when no keys exist', async () => {
      expect(await repo.countApiKeysPerTenant()).toEqual([]);
    });
  });

  describe('getUsageForPeriod', () => {
    it('returns usage rows only for the requested period', async () => {
      seedUsage('tenant-a', 'candidates_scored', 5, PERIOD);
      seedUsage('tenant-a', 'api_calls', 42, PERIOD);
      seedUsage('tenant-b', 'candidates_scored', 7, '2026-07-01');

      const rows = await repo.getUsageForPeriod(PERIOD);
      expect(rows).toHaveLength(2);
      const byFeature = Object.fromEntries(rows.map((r) => [r.feature, r.amount]));
      expect(byFeature).toEqual({ candidates_scored: 5, api_calls: 42 });
      expect(rows.every((r) => r.tenantId === 'tenant-a')).toBe(true);
    });

    it('returns an empty list for a period with no usage', async () => {
      expect(await repo.getUsageForPeriod(PERIOD)).toEqual([]);
    });
  });

  describe('getLastActivity', () => {
    it('returns the latest recorded activity per tenant', async () => {
      db.exec(
        `INSERT INTO usage_records (tenant_id, feature, amount, period_start, recorded_at)
         VALUES ('tenant-a', 'api_calls', 1, ?, '2026-08-05T10:00:00Z')`,
        [PERIOD],
      );
      db.exec(
        `INSERT INTO usage_records (tenant_id, feature, amount, period_start, recorded_at)
         VALUES ('tenant-a', 'domains_tracked', 1, ?, '2026-08-06T10:00:00Z')`,
        [PERIOD],
      );
      seedApiKey('tenant-b', 'ops', '2026-08-04T09:00:00Z');

      const activity = await repo.getLastActivity();
      const byTenant = Object.fromEntries(activity.map((a) => [a.tenantId, a.lastActiveAt]));
      expect(byTenant['tenant-a']).toBe('2026-08-06T10:00:00Z');
      expect(byTenant['tenant-b']).toBe('2026-08-04T09:00:00Z');
    });

    it('returns an empty list when nothing is active', async () => {
      expect(await repo.getLastActivity()).toEqual([]);
    });
  });
});
