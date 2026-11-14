// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, afterEach } from 'vitest';
import { SchedulerService } from '../scheduler-service.js';
import type { Config } from '../../config.js';
import type { RenewalAlertEngine } from '../../portfolio/renewal-alert-engine.js';

/**
 * The cron timers of the scheduler.
 *
 * Two ways to get the job catalogue:
 *
 * - `start()` — the long-running process: the catalogue is defined AND the
 *   cron timers are armed.
 * - `registerJobs()` — the one-shot CLI: the catalogue is defined and NO
 *   timer is armed, because a manual run must not leave a schedule behind
 *   (and a CLI that armed the timers would never exit).
 *
 * The condition that separates the two was inverted at some point: the
 * timers were armed by the CLI (which then hung until it was killed) and
 * NOT armed by the scheduler process (which then ran no job at all, for
 * any tenant). The whole platform automation was dead in the Cloud.
 */
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

function armedTimers(scheduler: SchedulerService): number {
  return (scheduler as unknown as { jobs: Map<string, unknown> }).jobs.size;
}

describe('the cron timers of the scheduler', () => {
  const schedulers: SchedulerService[] = [];

  afterEach(() => {
    for (const scheduler of schedulers) scheduler.stop();
    schedulers.length = 0;
    vi.useRealTimers();
  });

  function makeScheduler(): SchedulerService {
    const scheduler = new SchedulerService({
      config,
      alertEngine: { checkAll: vi.fn() } as unknown as RenewalAlertEngine,
    });
    schedulers.push(scheduler);
    return scheduler;
  }

  it('arms no timer when the CLI only registers the catalogue', () => {
    const scheduler = makeScheduler();
    scheduler.registerJobs();

    expect(armedTimers(scheduler)).toBe(0);
    // The catalogue itself exists: `dominus scheduler status` must show it.
    expect(scheduler.getStatus()).toBeDefined();
  });

  it('arms the timers when the long-running process starts', () => {
    const scheduler = makeScheduler();
    scheduler.start();

    // At least one timer: the catalogue is defined and armed.
    expect(armedTimers(scheduler)).toBeGreaterThan(0);
  });

  it('stops the timers when the process stops', () => {
    const scheduler = makeScheduler();
    scheduler.start();
    const armed = armedTimers(scheduler);
    expect(armed).toBeGreaterThan(0);

    scheduler.stop();
    expect(armedTimers(scheduler)).toBe(0);
  });
});
