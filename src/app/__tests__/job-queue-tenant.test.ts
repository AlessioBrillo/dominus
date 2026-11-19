// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../db/migrator.js';
import { SqliteProvider } from '../../db/provider/sqlite-adapter.js';
import { createJobQueueService } from '../job-queue-service.js';
import { JobQueueRepository } from '../../db/repositories/job-queue-repository.js';
import { runWithTenant } from '../../utils/tenant-context.js';

function openTestDb(): SqliteProvider {
  const provider = new SqliteProvider(new Database(':memory:'));
  provider.rawDb.pragma('journal_mode = WAL');
  provider.rawDb.pragma('foreign_keys = ON');
  runMigrations(provider.rawDb);
  return provider;
}

describe('the tenant of a queued job', () => {
  let provider: SqliteProvider;

  beforeEach(() => {
    provider = openTestDb();
  });

  afterEach(() => {
    provider.close();
  });

  it('records the tenant of the context in the column', async () => {
    const service = createJobQueueService(provider);
    const jobId = await runWithTenant('tenant-a', () => service.enqueueWatchlistPoll());

    const row = await provider.queryOne<{ tenant_id: string | null }>(
      'SELECT tenant_id FROM job_queue WHERE id = ?',
      [Number(jobId)],
    );
    expect(row?.tenant_id).toBe('tenant-a');
  });

  it('leaves a platform job without a tenant', async () => {
    const service = createJobQueueService(provider);
    const jobId = await service.enqueueBackup();

    const row = await provider.queryOne<{ tenant_id: string | null }>(
      'SELECT tenant_id FROM job_queue WHERE id = ?',
      [Number(jobId)],
    );
    expect(row?.tenant_id).toBeNull();
  });

  it('refuses the enqueue of a tenant that filled its share of the queue', async () => {
    const service = createJobQueueService(provider, {
      maxQueueDepth: 100,
      maxQueueDepthPerTenant: 2,
    });

    await runWithTenant('tenant-a', () => service.enqueueWatchlistPoll());
    await runWithTenant('tenant-a', () => service.enqueueWatchlistPoll());

    await expect(runWithTenant('tenant-a', () => service.enqueueWatchlistPoll())).rejects.toThrow(
      /depth limit reached for this tenant/,
    );

    // Another tenant is not affected: the queue is shared, the depth is not.
    const other = await runWithTenant('tenant-b', () => service.enqueueWatchlistPoll());
    expect(Number(other)).toBeGreaterThan(0);
  });

  it('removes the queued work of a tenant when the account is erased', async () => {
    const service = createJobQueueService(provider);
    await runWithTenant('tenant-a', () => service.enqueueWatchlistPoll());
    await runWithTenant('tenant-b', () => service.enqueueWatchlistPoll());

    const repo = new JobQueueRepository(provider);
    expect(await repo.deleteByTenant('tenant-a')).toBe(1);

    const remaining = await provider.query<{ tenant_id: string }>(
      'SELECT tenant_id FROM job_queue',
    );
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.tenant_id).toBe('tenant-b');
  });

  it('does not let one tenant occupy every worker', async () => {
    const repo = new JobQueueRepository(provider);
    await repo.enqueue('WATCHLIST_POLL', { tenantId: 'tenant-a' }, { tenantId: 'tenant-a' });
    await repo.enqueue('WATCHLIST_POLL', { tenantId: 'tenant-a' }, { tenantId: 'tenant-a' });

    // One job of tenant-a may run at a time.
    const first = await repo.dequeue('worker-1', 1);
    expect(first?.tenantId).toBe('tenant-a');
    const second = await repo.dequeue('worker-2', 1);
    expect(second).toBeNull();

    // A job of another tenant is not blocked by the cap of the first one.
    await repo.enqueue('WATCHLIST_POLL', { tenantId: 'tenant-b' }, { tenantId: 'tenant-b' });
    const third = await repo.dequeue('worker-3', 1);
    expect(third?.tenantId).toBe('tenant-b');
  });
});
