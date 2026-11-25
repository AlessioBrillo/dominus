// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteProvider } from '../../provider/sqlite-adapter.js';
import { SubscriptionRepository } from '../subscription-repository.js';

describe('SubscriptionRepository dunning grace', () => {
  let db: SqliteProvider;
  let repo: SubscriptionRepository;

  beforeEach(async () => {
    db = SqliteProvider.openInMemory();
    await db.runMigrations();
    repo = new SubscriptionRepository(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it('starts the grace only on the active -> past_due transition', async () => {
    await repo.upsert({ tenantId: 't1', plan: 'pro', status: 'active' });
    await repo.updateStatus('t1', 'past_due');
    const first = await repo.findByTenantId('t1');
    expect(first?.pastDueSince).not.toBeNull();

    await repo.updateStatus('t1', 'past_due'); // Stripe retry
    const second = await repo.findByTenantId('t1');
    expect(second?.pastDueSince).toBe(first?.pastDueSince);
  });

  it('clears the grace when the subscription recovers', async () => {
    await repo.upsert({ tenantId: 't1', plan: 'pro', status: 'past_due' });
    expect((await repo.findByTenantId('t1'))?.pastDueSince).not.toBeNull();
    await repo.updateStatus('t1', 'active');
    expect((await repo.findByTenantId('t1'))?.pastDueSince).toBeNull();
  });
});
