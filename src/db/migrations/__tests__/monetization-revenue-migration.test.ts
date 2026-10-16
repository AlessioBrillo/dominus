// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { SqliteProvider } from '../../provider/sqlite-adapter.js';
import { MonetizationRevenueRepository } from '../../repositories/monetization-revenue-repository.js';
import { getMigrations } from '../registry.js';

/**
 * Runs migration 0064 against a real in-memory SQLite database and
 * exercises the repository on the resulting schema. Guards the migration
 * SQL itself and the idempotency the ingestion relies on.
 */
describe('Monetization revenue migration (0064)', () => {
  it('creates the table and supports the repository contract', async () => {
    const db = new Database(':memory:');
    const migrations = getMigrations().filter((m) => m.name === '0064_create_monetization_revenue');
    expect(migrations).toHaveLength(1);
    for (const migration of migrations) {
      migration.up(db);
    }

    const provider = new SqliteProvider(db);
    const repo = new MonetizationRevenueRepository(provider);

    const day1 = {
      domain: 'vintagecoffee.com',
      date: '2026-10-01',
      amountEur: 1.25,
      source: 'csv',
      fetchedAt: '2026-10-02T00:00:00Z',
    };

    await repo.record(day1);
    // Same (domain, date, source): updates instead of duplicating.
    await repo.record({ ...day1, amountEur: 2.5 });
    const rows = await repo.findByDomain('vintagecoffee.com');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.amount_eur).toBe(2.5);

    await repo.record({
      domain: 'vintagecoffee.com',
      date: '2026-10-05',
      amountEur: 0.75,
      source: 'csv',
      fetchedAt: '2026-10-06T00:00:00Z',
    });
    // A different source for the same day is a separate row.
    await repo.record({
      domain: 'vintagecoffee.com',
      date: '2026-10-01',
      amountEur: 0.5,
      source: 'other',
      fetchedAt: '2026-10-06T00:00:00Z',
    });

    expect(await repo.totalSince('vintagecoffee.com')).toBeCloseTo(3.75, 5);
    expect(await repo.totalSince('vintagecoffee.com', '2026-10-04')).toBeCloseTo(0.75, 5);
    expect(await repo.lastRecordDate('vintagecoffee.com')).toBe('2026-10-05');

    const summary = await repo.summarize('vintagecoffee.com', new Date('2026-10-06T00:00:00Z'));
    expect(summary.totalEur).toBeCloseTo(3.75, 5);
    expect(summary.last30DaysEur).toBeCloseTo(3.75, 5);
    expect(summary.lastRecordDate).toBe('2026-10-05');
    expect(summary.records).toBe(3);

    // Unknown domain: zero, not null.
    expect(await repo.totalSince('unknown.com')).toBe(0);
    expect((await repo.summarize('unknown.com')).lastRecordDate).toBeNull();
  });
});
