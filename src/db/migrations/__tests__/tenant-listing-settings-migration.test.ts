// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { SqliteProvider } from '../../provider/sqlite-adapter.js';
import { TenantListingSettingsRepository } from '../../repositories/tenant-listing-settings-repository.js';
import { getMigrations } from '../registry.js';

/**
 * Runs migration 0065 against a real in-memory SQLite database and
 * exercises the repository on the resulting schema. Guards the migration
 * SQL itself and the conservative defaults: scoring price, offers never
 * answered automatically.
 */
describe('Tenant listing settings migration (0065)', () => {
  it('creates the table with conservative defaults and supports the repository contract', async () => {
    const db = new Database(':memory:');
    const migrations = getMigrations().filter(
      (m) => m.name === '0065_create_tenant_listing_settings',
    );
    expect(migrations).toHaveLength(1);
    for (const migration of migrations) {
      migration.up(db);
    }

    const provider = new SqliteProvider(db);
    const repo = new TenantListingSettingsRepository(provider);

    // Absent row -> conservative defaults.
    expect(await repo.get()).toEqual({
      pricePolicy: 'scoring',
      basePriceEur: null,
      offerAutoDeclineBelowEur: null,
      offerCounterEur: null,
    });

    const afterPolicy = await repo.set({ pricePolicy: 'fixed', basePriceEur: 2500 });
    expect(afterPolicy).toEqual({
      pricePolicy: 'fixed',
      basePriceEur: 2500,
      offerAutoDeclineBelowEur: null,
      offerCounterEur: null,
    });

    // Partial update merges and keeps the rest.
    const afterRules = await repo.set({ offerAutoDeclineBelowEur: 100, offerCounterEur: 800 });
    expect(afterRules).toEqual({
      pricePolicy: 'fixed',
      basePriceEur: 2500,
      offerAutoDeclineBelowEur: 100,
      offerCounterEur: 800,
    });

    // Null clears a field (explicit null, not "leave unchanged").
    const afterClear = await repo.set({ basePriceEur: null });
    expect(afterClear.basePriceEur).toBeNull();
    expect(afterClear.pricePolicy).toBe('fixed');

    // Repeated writes upsert the same row.
    const count = db.prepare('SELECT COUNT(*) AS n FROM tenant_listing_settings').get() as {
      n: number;
    };
    expect(count.n).toBe(1);
  });
});
