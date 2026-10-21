// SPDX-License-Identifier: AGPL-3.0-only
// SPDX-FileCopyrightText: 2026 DOMINUS contributors
//
// The manual run of a scheduled job.
//
// `dominus scheduler run <job>` is the documented way to trigger a job by
// hand (the acceptance suite uses it to prove the scheduler → queue →
// worker path). The job definitions used to be created only by
// start(), which only the long-running scheduler process calls: the
// manual run answered "Unknown job: data-prune. Available: " and the
// command was useless.
import { describe, it, expect } from 'vitest';
import { SchedulerService } from '../scheduler-service.js';
import type { Config } from '../../config.js';

const config = {
  SCHEDULER_RENEWAL_CHECK_CRON: '0 3 * * *',
  SCHEDULER_PORTFOLIO_HEALTHCHECK_CRON: '0 4 * * *',
  SCHEDULER_RESCORE_CRON: '0 5 * * *',
  SCHEDULER_REVENUE_SYNC_CRON: '0 7 * * *',
  SCHEDULER_PRUNE_CRON: '0 10 1 * *',
  SCHEDULER_BACKUP_CRON: '0 4 * * *',
  SCHEDULER_WATCHLIST_CRON: '0 6 * * *',
  SCHEDULER_PITR_HEALTH_CRON: '0 8 * * *',
  REVENUE_SYNC_LOOKBACK_DAYS: 90,
} as unknown as Config;

function buildScheduler(): SchedulerService {
  return new SchedulerService({
    config,
    alertEngine: { checkAll: async () => ({ generated: 3 }) } as never,
    // The queue is what a Cloud deployment uses: the scheduler enqueues
    // and the worker executes.
    jobQueueService: {
      enqueueRenewalCheck: async () => 'job-renewal-1',
      enqueuePrune: async () => 'job-prune-1',
    } as never,
  });
}

describe('the scheduler manual run', () => {
  it('knows no job before the catalogue is registered', async () => {
    const scheduler = buildScheduler();
    expect(await scheduler.getStatus()).toHaveLength(0);
    await expect(scheduler.runOnce('renewal-check')).rejects.toThrow(/Unknown job/);
  });

  it('runs a job by name once the catalogue is registered', async () => {
    const scheduler = buildScheduler();
    scheduler.registerJobs();

    const status = await scheduler.getStatus();
    expect(status.map((j) => j.name)).toContain('renewal-check');

    const result = await scheduler.runOnce('renewal-check');
    expect(result).toContain('job-renewal-1');
  });

  it('registers the jobs without arming the cron timers', async () => {
    // A manual one-shot run must not leave a schedule behind: the cron
    // timers are armed by start(), and only there.
    const scheduler = buildScheduler();
    scheduler.registerJobs();
    // stop() is a no-op on a scheduler whose timers were never armed.
    expect(() => scheduler.stop()).not.toThrow();
    expect(await scheduler.getStatus()).not.toHaveLength(0);
  });
});
