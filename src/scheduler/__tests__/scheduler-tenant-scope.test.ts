// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi } from 'vitest';
import { SchedulerService } from '../scheduler-service.js';
import { getTenantId } from '../../utils/tenant-context.js';
import type { Config } from '../../config.js';
import type { RenewalAlertEngine } from '../../portfolio/renewal-alert-engine.js';

const config = {
  SCHEDULER_RENEWAL_CHECK_CRON: '0 8 * * *',
  SCHEDULER_PORTFOLIO_HEALTHCHECK_CRON: '0 9 * * *',
  SCHEDULER_RESCORE_CRON: '0 9 * * 1',
  SCHEDULER_REVENUE_SYNC_CRON: '0 7 * * *',
  SCHEDULER_PRUNE_CRON: '0 10 1 * *',
  SCHEDULER_WATCHLIST_CRON: '0 */6 * * *',
  SCHEDULER_BACKUP_CRON: '0 2 * * *',
  SCHEDULER_PITR_HEALTH_CRON: '0 3 * * *',
  AUTO_TUNE_CRON: '0 4 * * *',
  REVENUE_SYNC_LOOKBACK_DAYS: 90,
} as unknown as Config;

function makeScheduler(options: {
  tenants?: string[];
  checkAll?: () => Promise<{ generated: number }>;
  backupService?: unknown;
}): SchedulerService {
  const alertEngine = {
    checkAll:
      options.checkAll ??
      vi.fn(async () => {
        // The tenant the job runs for: the repositories resolve it from the
        // ambient context.
        return { generated: getTenantId() ? 1 : 0 };
      }),
  } as unknown as RenewalAlertEngine;

  const scheduler = new SchedulerService({
    config,
    alertEngine,
    ...(options.tenants
      ? { tenantEnumerator: async (): Promise<string[]> => options.tenants as string[] }
      : {}),
    ...(options.backupService ? { backupService: options.backupService as never } : {}),
  });
  // The job catalogue is defined without arming the cron timers.
  scheduler.registerJobs();
  return scheduler;
}

describe('the tenant scope of the scheduled jobs', () => {
  it('runs a tenant-scoped job once per tenant, inside the tenant context', async () => {
    const seen: Array<string | undefined> = [];
    const scheduler = makeScheduler({
      tenants: ['tenant-a', 'tenant-b'],
      checkAll: async () => {
        seen.push(getTenantId());
        return { generated: 1 };
      },
    });

    await scheduler.runOnce('renewal-check');

    // Without the tenant scope the job would run once, outside any tenant
    // context, and the repositories would read (and write) the tenant
    // 'default' — a tenant that belongs to nobody.
    expect(seen).toEqual(['tenant-a', 'tenant-b']);
  });

  it('runs the job once when the installation is single-tenant', async () => {
    const seen: Array<string | undefined> = [];
    const scheduler = makeScheduler({
      checkAll: async () => {
        seen.push(getTenantId());
        return { generated: 1 };
      },
    });

    await scheduler.runOnce('renewal-check');

    expect(seen).toEqual([undefined]);
  });

  it('keeps the other tenants running when one fails', async () => {
    const seen: Array<string | undefined> = [];
    const scheduler = makeScheduler({
      tenants: ['tenant-a', 'tenant-b', 'tenant-c'],
      checkAll: async () => {
        const tenantId = getTenantId();
        seen.push(tenantId);
        if (tenantId === 'tenant-b') throw new Error('boom');
        return { generated: 1 };
      },
    });

    const result = await scheduler.runOnce('renewal-check');

    expect(seen).toEqual(['tenant-a', 'tenant-b', 'tenant-c']);
    expect(result).toContain('2/3 tenant(s)');
    expect(result).toContain('tenant-b');
  });

  it('runs a platform job once, whatever the tenants are', async () => {
    const backupService = {
      create: vi.fn(async () => ({ path: '/tmp/backup.db', sizeBytes: 1024, durationMs: 5 })),
      prune: vi.fn(async () => 0),
    };
    const scheduler = makeScheduler({
      tenants: ['tenant-a', 'tenant-b'],
      backupService,
    });

    const result = await scheduler.runOnce('backup');

    // The backup belongs to the platform: it runs once, not once per tenant.
    expect(backupService.create).toHaveBeenCalledTimes(1);
    expect(result).toContain('Backup created');
  });
});
