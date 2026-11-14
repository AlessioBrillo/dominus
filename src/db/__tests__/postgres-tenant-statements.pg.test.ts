// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgresAdapter } from '../provider/postgres-adapter.js';
import { JobQueueRepository } from '../repositories/job-queue-repository.js';
import { TeamSeatsRepository } from '../repositories/team-seats-repository.js';
import { runWithTenant } from '../../utils/tenant-context.js';

/**
 * The statements that SQLite and PostgreSQL do not agree on.
 *
 * SQLite is dynamically typed and it infers the type of a bound parameter
 * from the context; PostgreSQL does not, and it refuses a statement whose
 * parameter type it cannot determine ("could not determine data type of
 * parameter $9"). The same is true of a COALESCE that mixes a text column
 * with a timestamp.
 *
 * These two statements are the ones that broke on PostgreSQL while the
 * SQLite suite was green, so they are asserted here, on the real engine.
 *
 * Runs only when DATABASE_URL is set (the postgres step of the gate).
 */
const PG_URL = process.env.DATABASE_URL ?? '';

describe.runIf(PG_URL)('the tenant statements on PostgreSQL', () => {
  let adapter: PostgresAdapter;

  beforeAll(async () => {
    adapter = await PostgresAdapter.create(PG_URL);
    await adapter.runMigrations();
  });

  afterAll(async () => {
    if (adapter?.isOpen()) await adapter.close();
  });

  it('enqueues a job with the per-tenant depth check', async () => {
    const repo = new JobQueueRepository(adapter);
    const jobId = await repo.enqueueWithDepthCheck(
      'WATCHLIST_POLL',
      { tenantId: 'tenant-pg' },
      100,
      { tenantId: 'tenant-pg', maxDepthPerTenant: 5 },
    );
    expect(jobId).toBeGreaterThan(0);

    const row = await adapter.queryOne<{ tenant_id: string | null }>(
      'SELECT tenant_id FROM job_queue WHERE id = ?',
      [jobId],
    );
    expect(row?.tenant_id).toBe('tenant-pg');

    await adapter.exec('DELETE FROM job_queue WHERE id = ?', [jobId]);
  });

  it('refuses the enqueue of a tenant that reached its share of the queue', async () => {
    const repo = new JobQueueRepository(adapter);
    await repo.enqueueWithDepthCheck('WATCHLIST_POLL', {}, 100, {
      tenantId: 'tenant-full',
      maxDepthPerTenant: 1,
    });
    await expect(
      repo.enqueueWithDepthCheck('WATCHLIST_POLL', {}, 100, {
        tenantId: 'tenant-full',
        maxDepthPerTenant: 1,
      }),
    ).rejects.toThrow(/depth limit reached for this tenant/);

    // Another tenant is not affected.
    const other = await repo.enqueueWithDepthCheck('WATCHLIST_POLL', {}, 100, {
      tenantId: 'tenant-other',
      maxDepthPerTenant: 1,
    });
    expect(other).toBeGreaterThan(0);

    await adapter.exec('DELETE FROM job_queue WHERE tenant_id IN (?, ?)', [
      'tenant-full',
      'tenant-other',
    ]);
  });

  it('records the verification of a seat (text column, timestamp default)', async () => {
    const seats = new TeamSeatsRepository(adapter);
    await seats.invite('tenant-verify', 'owner@example.com', 'admin', 'owner@example.com');

    await seats.markEmailVerified('tenant-verify', 'owner@example.com');

    const row = await adapter.queryOne<{ email_verified_at: string | null }>(
      'SELECT email_verified_at FROM team_seats WHERE tenant_id = ? AND user_id = ?',
      ['tenant-verify', 'owner@example.com'],
    );
    expect(row?.email_verified_at).toBeTruthy();

    // The verification is recorded once: a second call keeps the first.
    await seats.markEmailVerified('tenant-verify', 'owner@example.com');
    const again = await adapter.queryOne<{ email_verified_at: string | null }>(
      'SELECT email_verified_at FROM team_seats WHERE tenant_id = ? AND user_id = ?',
      ['tenant-verify', 'owner@example.com'],
    );
    expect(again?.email_verified_at).toBe(row?.email_verified_at);

    await adapter.exec('DELETE FROM team_seats WHERE tenant_id = ?', ['tenant-verify']);
  });

  it('claims the jobs of a tenant without letting it take every worker', async () => {
    const repo = new JobQueueRepository(adapter);
    await repo.enqueue('WATCHLIST_POLL', {}, { tenantId: 'tenant-cap' });
    await repo.enqueue('WATCHLIST_POLL', {}, { tenantId: 'tenant-cap' });
    await repo.enqueue('WATCHLIST_POLL', {}, { tenantId: 'tenant-free' });

    const first = await repo.dequeue('pg-worker-1', 1);
    expect(first?.tenantId).toBe('tenant-cap');

    // The cap of the first tenant does not block the other one.
    const second = await repo.dequeue('pg-worker-2', 1);
    expect(second?.tenantId).toBe('tenant-free');

    await adapter.exec('DELETE FROM job_queue WHERE tenant_id IN (?, ?)', [
      'tenant-cap',
      'tenant-free',
    ]);
  });

  it('sees the rows of the tenant of the context and only those', async () => {
    const seats = new TeamSeatsRepository(adapter);
    await runWithTenant('tenant-read-a', () =>
      seats.invite('tenant-read-a', 'a@example.com', 'admin', 'a@example.com'),
    );
    await runWithTenant('tenant-read-b', () =>
      seats.invite('tenant-read-b', 'b@example.com', 'admin', 'b@example.com'),
    );

    const found = await runWithTenant('tenant-read-a', () => seats.findByUserId('a@example.com'));
    expect(found).toHaveLength(1);
    expect(found[0]?.tenantId).toBe('tenant-read-a');

    await adapter.exec('DELETE FROM team_seats WHERE tenant_id IN (?, ?)', [
      'tenant-read-a',
      'tenant-read-b',
    ]);
  });
});
