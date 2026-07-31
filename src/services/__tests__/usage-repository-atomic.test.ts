import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteProvider } from '../../db/provider/sqlite-adapter.js';
import { UsageRepository } from '../../db/repositories/usage-repository.js';
import { WebhookEventsRepository } from '../../db/repositories/webhook-events-repository.js';

describe('UsageRepository.incrementUsageIfWithinLimit', () => {
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
  const TENANT = 'tenant-1';

  it('inserts the first record when within the limit', async () => {
    const applied = await repo.incrementUsageIfWithinLimit(TENANT, 'api_calls', 10, PERIOD, 50);
    expect(applied).toBe(true);
    expect(await repo.getUsageForPeriod(TENANT, 'api_calls', PERIOD)).toBe(10);
  });

  it('allows increments that land exactly on the limit', async () => {
    await repo.incrementUsageIfWithinLimit(TENANT, 'api_calls', 50, PERIOD, 50);
    const applied = await repo.incrementUsageIfWithinLimit(TENANT, 'api_calls', 0, PERIOD, 50);
    expect(applied).toBe(true);
    expect(await repo.getUsageForPeriod(TENANT, 'api_calls', PERIOD)).toBe(50);
  });

  it('rejects an increment that exceeds the limit', async () => {
    await repo.incrementUsageIfWithinLimit(TENANT, 'api_calls', 50, PERIOD, 50);
    const applied = await repo.incrementUsageIfWithinLimit(TENANT, 'api_calls', 1, PERIOD, 50);
    expect(applied).toBe(false);
    expect(await repo.getUsageForPeriod(TENANT, 'api_calls', PERIOD)).toBe(50);
  });

  it('rejects a first insert whose amount already exceeds the limit', async () => {
    const applied = await repo.incrementUsageIfWithinLimit(TENANT, 'api_calls', 51, PERIOD, 50);
    expect(applied).toBe(false);
    expect(await repo.getUsageForPeriod(TENANT, 'api_calls', PERIOD)).toBe(0);
  });

  it('never overshoots the limit under concurrency', async () => {
    const LIMIT = 50;
    const CONCURRENT = 25;
    await Promise.all(
      Array.from({ length: CONCURRENT }, () =>
        repo.incrementUsageIfWithinLimit(TENANT, 'api_calls', 5, PERIOD, LIMIT),
      ),
    );
    const total = await repo.getUsageForPeriod(TENANT, 'api_calls', PERIOD);
    expect(total).toBeLessThanOrEqual(LIMIT);
  });

  it('applies only the increments that fit when racing at the boundary', async () => {
    const LIMIT = 50;
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        repo.incrementUsageIfWithinLimit(TENANT, 'api_calls', 10, PERIOD, LIMIT),
      ),
    );
    const applied = results.filter(Boolean).length;
    expect(applied).toBe(5);
    expect(await repo.getUsageForPeriod(TENANT, 'api_calls', PERIOD)).toBe(50);
  });

  it('treats a null limit as unlimited', async () => {
    for (let i = 0; i < 10; i++) {
      await expect(
        repo.incrementUsageIfWithinLimit(TENANT, 'api_calls', 100, PERIOD, null),
      ).resolves.toBe(true);
    }
    expect(await repo.getUsageForPeriod(TENANT, 'api_calls', PERIOD)).toBe(1000);
  });
});

describe('WebhookEventsRepository', () => {
  let db: SqliteProvider;
  let repo: WebhookEventsRepository;

  beforeEach(async () => {
    db = SqliteProvider.openInMemory();
    await db.runMigrations();
    repo = new WebhookEventsRepository(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it('records a new event as processed', async () => {
    const newly = await repo.markProcessed('stripe', 'evt_1', 'checkout.session.completed');
    expect(newly).toBe(true);
    expect(await repo.isProcessed('stripe', 'evt_1')).toBe(true);
  });

  it('returns false for a duplicate event', async () => {
    await repo.markProcessed('stripe', 'evt_1', 'checkout.session.completed');
    const again = await repo.markProcessed('stripe', 'evt_1', 'checkout.session.completed');
    expect(again).toBe(false);
  });

  it('scopes dedup by provider', async () => {
    await repo.markProcessed('stripe', 'evt_1', 'checkout.session.completed');
    const otherProvider = await repo.markProcessed('github', 'evt_1', 'push');
    expect(otherProvider).toBe(true);
  });

  it('prunes old events', async () => {
    await repo.markProcessed('stripe', 'evt_1', 'checkout.session.completed');
    const removed = await repo.pruneOlderThan('2099-01-01 00:00:00');
    expect(removed).toBe(1);
    expect(await repo.isProcessed('stripe', 'evt_1')).toBe(false);
  });
});
