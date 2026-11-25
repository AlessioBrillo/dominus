// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteProvider } from '../../provider/sqlite-adapter.js';
import { EventRepository } from '../event-repository.js';

describe('EventRepository', () => {
  let db: SqliteProvider;
  let repo: EventRepository;

  beforeEach(async () => {
    db = SqliteProvider.openInMemory();
    await db.runMigrations();
    repo = new EventRepository(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it('records product events with their anonymous identity', async () => {
    await repo.record({ tenantId: 'public', anonId: 'anon-1', type: 'signup' });
    const rows = await db.query<{ type: string; anon_id: string | null }>(
      'SELECT type, anon_id FROM events',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: 'signup', anon_id: 'anon-1' });
  });

  it('counts the funnel without counting unrelated events', async () => {
    await repo.record({ tenantId: 't1', type: 'signup' });
    await repo.record({ tenantId: 't1', type: 'verified' });
    await repo.record({ tenantId: 't1', type: 'first_score' });
    await repo.record({ tenantId: 't1', type: 'portfolio_import' });
    await repo.record({ tenantId: 't1', type: 'checkout_completed' });
    await repo.record({ tenantId: 't1', type: 'domain_scored' });

    expect(await repo.funnelCounts()).toEqual({
      signup: 1,
      verified: 1,
      firstScore: 1,
      portfolioImport: 1,
      checkoutCompleted: 1,
    });
  });
});
