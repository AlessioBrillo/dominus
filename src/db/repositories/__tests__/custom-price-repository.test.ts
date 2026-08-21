// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../../db/migrator.js';
import { SqliteProvider } from '../../../db/provider/sqlite-adapter.js';
import { CustomPriceRepository } from '../custom-price-repository.js';

function openTestDb(): SqliteProvider {
  const provider = new SqliteProvider(new Database(':memory:'));
  provider.rawDb.pragma('journal_mode = WAL');
  provider.rawDb.pragma('foreign_keys = ON');
  runMigrations(provider.rawDb);
  return provider;
}

describe('CustomPriceRepository', () => {
  let provider: SqliteProvider;
  let repo: CustomPriceRepository;

  beforeEach(() => {
    provider = openTestDb();
    repo = new CustomPriceRepository(provider);
  });

  describe('upsert + findByPriceId', () => {
    it('inserts and retrieves a custom price by price_id', async () => {
      await repo.upsert({
        tenantId: 'tenant-1',
        priceId: 'price_custom_123',
        plan: 'enterprise',
        expectedAmountEur: 50000,
        seats: 10,
      });

      const found = await repo.findByPriceId('price_custom_123');
      expect(found).toBeDefined();
      expect(found?.tenantId).toBe('tenant-1');
      expect(found?.priceId).toBe('price_custom_123');
      expect(found?.plan).toBe('enterprise');
      expect(found?.expectedAmountEur).toBe(50000);
      expect(found?.seats).toBe(10);
    });

    it('upserts on duplicate price_id (updates tenant/plan/amount/seats)', async () => {
      await repo.upsert({
        tenantId: 'tenant-1',
        priceId: 'price_custom_123',
        plan: 'pro',
        expectedAmountEur: 2900,
        seats: 1,
      });

      await repo.upsert({
        tenantId: 'tenant-2',
        priceId: 'price_custom_123',
        plan: 'enterprise',
        expectedAmountEur: 50000,
        seats: 10,
      });

      const found = await repo.findByPriceId('price_custom_123');
      expect(found?.tenantId).toBe('tenant-2');
      expect(found?.plan).toBe('enterprise');
      expect(found?.expectedAmountEur).toBe(50000);
      expect(found?.seats).toBe(10);
    });
  });

  describe('findByTenantId', () => {
    it('returns all custom prices for a tenant', async () => {
      await repo.upsert({
        tenantId: 'tenant-1',
        priceId: 'price_1',
        plan: 'pro',
        expectedAmountEur: 2900,
        seats: 1,
      });
      await repo.upsert({
        tenantId: 'tenant-1',
        priceId: 'price_2',
        plan: 'enterprise',
        expectedAmountEur: 50000,
        seats: 10,
      });

      const prices = await repo.findByTenantId('tenant-1');
      expect(prices).toHaveLength(2);
      // Order by created_at DESC — price_2 was inserted last so it should come first
      // (if same timestamp, order is not guaranteed, so we just check both are present)
      const priceIds = prices.map((p) => p.priceId).sort();
      expect(priceIds).toEqual(['price_1', 'price_2']);
    });

    it('returns empty array for unknown tenant', async () => {
      const prices = await repo.findByTenantId('unknown');
      expect(prices).toHaveLength(0);
    });
  });

  describe('delete', () => {
    it('deletes a custom price by price_id', async () => {
      await repo.upsert({
        tenantId: 'tenant-1',
        priceId: 'price_custom_123',
        plan: 'enterprise',
        expectedAmountEur: 50000,
        seats: 10,
      });

      const deleted = await repo.delete('price_custom_123');
      expect(deleted).toBe(true);

      const found = await repo.findByPriceId('price_custom_123');
      expect(found).toBeUndefined();
    });

    it('returns false for non-existent price_id', async () => {
      const deleted = await repo.delete('nonexistent');
      expect(deleted).toBe(false);
    });
  });

  describe('deleteByTenant', () => {
    it('deletes all custom prices for a tenant', async () => {
      await repo.upsert({
        tenantId: 'tenant-1',
        priceId: 'price_1',
        plan: 'pro',
        expectedAmountEur: 2900,
        seats: 1,
      });
      await repo.upsert({
        tenantId: 'tenant-1',
        priceId: 'price_2',
        plan: 'enterprise',
        expectedAmountEur: 50000,
        seats: 10,
      });

      const count = await repo.deleteByTenant('tenant-1');
      expect(count).toBe(2);

      const prices = await repo.findByTenantId('tenant-1');
      expect(prices).toHaveLength(0);
    });

    it('returns 0 for unknown tenant', async () => {
      const count = await repo.deleteByTenant('unknown');
      expect(count).toBe(0);
    });
  });
});
