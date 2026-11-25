// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PostgresAdapter } from '../../provider/postgres-adapter.js';
import { EventRepository } from '../event-repository.js';

const PG_URL = process.env.DATABASE_URL ?? '';

// RLS on `events` denies a read without a tenant context. The operator
// aggregate and the signup writes must share the `public` context or the
// funnel is silently all zeros in PostgreSQL (P1 review, PR #564).
describe.runIf(PG_URL)('EventRepository funnel under RLS', () => {
  let adapter: PostgresAdapter;
  let repo: EventRepository;

  beforeEach(async () => {
    adapter = await PostgresAdapter.create(PG_URL);
    repo = new EventRepository(adapter);
    await adapter.exec('DELETE FROM events');
  });

  afterEach(async () => {
    if (adapter?.isOpen()) await adapter.close();
  });

  it('counts events written under the public tenant without a caller context', async () => {
    await repo.record({ tenantId: 'public', anonId: 'tenant-a', type: 'signup' });
    await repo.record({ tenantId: 'public', anonId: 'tenant-a', type: 'verified' });

    // No runWithTenant here: funnelCounts must establish the context itself.
    const counts = await repo.funnelCounts();
    expect(counts.signup).toBe(1);
    expect(counts.verified).toBe(1);
  });
});
