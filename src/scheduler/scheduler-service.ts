// SPDX-License-Identifier: AGPL-3.0-only
import cron, { type ScheduledTask } from 'node-cron';
import type { RenewalAlertEngine } from '../portfolio/renewal-alert-engine.js';
import type { PortfolioManager } from '../portfolio/portfolio-manager.js';
import type { TrademarkRepository } from '../db/repositories/trademark-repository.js';
import type { PipelineRunsRepository } from '../db/repositories/pipeline-runs-repository.js';
import type { ProviderCacheRepository } from '../db/repositories/provider-cache-repository.js';
import type { WatchlistService } from '../watchlist/watchlist-service.js';
import type { AutoWeightTuner } from '../scoring/auto-tuner.js';
import type { PortfolioRdapService } from '../portfolio/portfolio-rdap-service.js';
import type { RevenueIngestionService } from '../services/revenue-ingestion-service.js';
import type { BackupService } from './backup-service.js';
import type { PitrHealthService } from './pitr-health-service.js';
import type { Config } from '../config.js';
import { type SchedulerJobRepository } from '../db/repositories/scheduler-job-repository.js';
import type { JobQueueService } from '../app/job-queue-service.js';
import type { LockProvider } from '../types/lock.js';
import { getLogger } from '../logger.js';

const logger = getLogger();

// Per-cron-fire dedupe lock name. The lock is scoped to the job name and the
// minute slot in which the fire happened, so two scheduler replicas firing the
// same cron tick can never enqueue the job twice, while the very next fire
// (a different slot) is never blocked by a stale lock.
export function cronFireSlotLockName(jobName: string, when: Date): string {
  return `scheduler:fire:${jobName}:${when.toISOString().slice(0, 16)}`;
}

const CRON_FIRE_LOCK_TTL_MS = 10 * 60_000;

/**
 * Earliest revenue date a sync should (re-)fetch: the configured lookback
 * window. Re-fetching an already-ingested day is safe — writes are
 * idempotent at (domain, date, source) granularity, so a repeated sync
 * corrects figures instead of duplicating them.
 */
function revenueSinceIso(lookbackDays: number): string {
  const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
  return since.toISOString().slice(0, 10);
}

export interface ScheduledJob {
  name: string;
  cronExpression: string;
  description: string;
  lastRunAt: string | null;
  lastResult: string | null;
}

export interface SchedulerOptions {
  config: Config;
  alertEngine: RenewalAlertEngine;
  portfolioManager?: PortfolioManager;
  trademarkRepo?: TrademarkRepository;
  providerCacheRepo?: ProviderCacheRepository;
  runsRepo?: PipelineRunsRepository;
  watchlistService?: WatchlistService;
  autoTuner?: AutoWeightTuner;
  jobRepo?: SchedulerJobRepository;
  backupService?: BackupService;
  jobQueueService?: JobQueueService;
  portfolioHealthcheckService?: PortfolioRdapService;
  /**
   * Revenue ingestion service (ADR-0083, M5). When provided, a
   * `revenue-sync` job enqueues REVENUE_SYNC on the worker (or runs it
   * inline) every SCHEDULER_REVENUE_SYNC_CRON. The job itself is a read:
   * it records reported ad revenue and never mutates external state.
   */
  revenueIngestionService?: RevenueIngestionService;
  /**
   * Distributed lock (Redis composite or DB pipeline_locks). When present,
   * concurrent cron fires from multiple scheduler replicas are deduplicated:
   * only the first replica to acquire the per-minute-slot lock enqueues/runs
   * the job. Manual `runOnce` invocations bypass the lock.
   */
  lock?: LockProvider;
  /**
   * Point-in-time recovery health checker (PostgreSQL only, ADR-0054).
   * When provided, a `pitr-health` job runs inline in the scheduler
   * (lightweight SQL + fs stat — no worker roundtrip) every
   * SCHEDULER_PITR_HEALTH_CRON and records the dominus_pitr_* gauges.
   */
  pitrHealthService?: PitrHealthService;
}

export class SchedulerService {
  private readonly jobs: Map<string, ScheduledTask> = new Map();
  private readonly config: Config;
  private readonly alertEngine: RenewalAlertEngine;
  private readonly portfolioManager: PortfolioManager | undefined;
  private readonly trademarkRepo: TrademarkRepository | undefined;
  private readonly providerCacheRepo: ProviderCacheRepository | undefined;
  private readonly runsRepo: PipelineRunsRepository | undefined;
  private readonly watchlistService: WatchlistService | undefined;
  private readonly autoTuner: AutoWeightTuner | undefined;
  private readonly backupService: BackupService | undefined;
  private readonly jobRepo: SchedulerJobRepository | undefined;
  private readonly jobQueueService: JobQueueService | undefined;
  private readonly portfolioHealthcheckService: PortfolioRdapService | undefined;
  private readonly revenueIngestionService: RevenueIngestionService | undefined;
  private readonly lock: LockProvider | undefined;
  private readonly pitrHealthService: PitrHealthService | undefined;
  private running = false;
  /**
   * Whether the cron timers are armed while the jobs are registered.
   * start() arms them; registerJobs() only defines the jobs, so a manual
   * one-shot run does not leave a schedule behind.
   */
  #scheduleEnabled = false;

  constructor(options: SchedulerOptions) {
    this.config = options.config;
    this.alertEngine = options.alertEngine;
    this.portfolioManager = options.portfolioManager;
    this.trademarkRepo = options.trademarkRepo;
    this.providerCacheRepo = options.providerCacheRepo;
    this.runsRepo = options.runsRepo;
    this.watchlistService = options.watchlistService;
    this.autoTuner = options.autoTuner;
    this.backupService = options.backupService;
    this.jobRepo = options.jobRepo;
    this.jobQueueService = options.jobQueueService;
    this.portfolioHealthcheckService = options.portfolioHealthcheckService;
    this.revenueIngestionService = options.revenueIngestionService;
    this.lock = options.lock;
    this.pitrHealthService = options.pitrHealthService;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.#defineJobs(true);
    logger.info(`Scheduler started with ${this.jobs.size} job(s)`);
  }

  /**
   * Register the job definitions WITHOUT arming their cron timers.
   *
   * `dominus scheduler run <job>` needs the definitions to exist, and it must
   * not arm the schedule: a manual one-shot run that also started the cron
   * timers would fire the job again on the next tick. The definitions used
   * to be created only by start(), so the manual run answered "Unknown job:
   * data-prune. Available: " — the documented way to trigger a job by hand
   * never worked.
   */
  registerJobs(): void {
    this.#defineJobs(false);
  }

  /**
   * The job catalogue. `schedule` decides whether the cron timers are armed
   * as well: start() arms them, registerJobs() only defines them.
   */
  #defineJobs(schedule: boolean): void {
    this.#scheduleEnabled = schedule;
    this.#register(
      'renewal-check',
      this.config.SCHEDULER_RENEWAL_CHECK_CRON,
      'Check portfolio renewal dates and generate alerts',
      async () => {
        const result = await this.alertEngine.checkAll();
        const msg = `Generated ${result.generated} renewal alerts`;
        logger.info(msg);
        return msg;
      },
      'RENEWAL_CHECK',
    );

    if (this.portfolioHealthcheckService) {
      this.#register(
        'portfolio-healthcheck',
        this.config.SCHEDULER_PORTFOLIO_HEALTHCHECK_CRON,
        'Verify portfolio domains against live RDAP/WHOIS for renewal date accuracy',
        async () => {
          const result = await this.portfolioHealthcheckService!.checkExpiring(90, 100);
          const msg = `Healthchecked ${result.checked} domain(s), updated ${result.updated}, errors ${result.errors}`;
          logger.info(msg);
          return msg;
        },
        'PORTFOLIO_HEALTHCHECK',
      );
    } else {
      logger.warn('portfolio-healthcheck job disabled (PortfolioRdapService not provided)');
    }

    if (this.portfolioManager) {
      this.#register(
        'portfolio-rescore',
        this.config.SCHEDULER_RESCORE_CRON,
        'Re-score all portfolio entries against current engine and trademark gate',
        async () => {
          const summary = await this.portfolioManager!.rescoreAll();
          const msg = `Rescored ${summary.results.length} domain(s) in ${summary.totalDurationMs}ms`;
          logger.info(msg);
          return msg;
        },
        'PORTFOLIO_RESCORE',
      );
    } else {
      logger.warn('portfolio-rescore job disabled (PortfolioManager not provided)');
    }

    if (this.revenueIngestionService) {
      this.#register(
        'revenue-sync',
        this.config.SCHEDULER_REVENUE_SYNC_CRON,
        'Ingest ad revenue from the configured monetization provider (read-only, ADR-0083 M5)',
        async () => {
          if (!this.revenueIngestionService!.isConfigured) {
            const msg = 'Revenue sync skipped: no monetization provider configured';
            logger.info(msg);
            return msg;
          }
          const result = await this.revenueIngestionService!.ingestAll(
            revenueSinceIso(this.config.REVENUE_SYNC_LOOKBACK_DAYS),
          );
          const msg = `Revenue sync: recorded ${result.recorded} row(s) for ${result.domains.length} domain(s)`;
          logger.info(msg);
          return msg;
        },
        'REVENUE_SYNC',
      );
    } else {
      logger.warn('revenue-sync job disabled (RevenueIngestionService not provided)');
    }

    if (this.trademarkRepo && this.runsRepo) {
      this.#register(
        'data-prune',
        this.config.SCHEDULER_PRUNE_CRON,
        'Prune expired trademark cache, provider cache, and pipeline run history',
        async () => {
          const tmRemoved = await this.trademarkRepo!.pruneExpired();
          const pcRemoved = (await this.providerCacheRepo?.pruneExpired()) ?? 0;
          const runsRemoved = await this.runsRepo!.prune();
          const msg = `Pruned ${tmRemoved} trademark cache + ${pcRemoved} provider cache + ${runsRemoved} pipeline run(s)`;
          logger.info(msg);
          return msg;
        },
        'PRUNE',
      );
    } else {
      logger.warn(
        'data-prune job disabled (TrademarkRepository or PipelineRunsRepository not provided)',
      );
    }

    if (this.autoTuner) {
      this.#register(
        'weight-tune',
        this.config.AUTO_TUNE_CRON,
        'Run auto-weight-tuning cycle (backtest + suggest + safety + apply)',
        async () => {
          const outcome = await this.autoTuner!.tune();
          const msg = `Weight tune: sample=${outcome.sampleSize}, safety=${outcome.safety.passed ? 'passed' : 'failed'}, applied=${outcome.applied}`;
          logger.info(msg);
          return msg;
        },
        'WEIGHT_TUNE',
      );
    }

    if (this.watchlistService) {
      this.#register(
        'watchlist-poll',
        this.config.SCHEDULER_WATCHLIST_CRON,
        'Poll watchlist entries for domain availability via RDAP',
        async () => {
          const result = await this.watchlistService!.poll();
          const msg = `Watchlist poll: checked ${result.checked}, available ${result.available}, notified ${result.notified}, errors ${result.errors}`;
          logger.info(msg);
          return msg;
        },
        'WATCHLIST_POLL',
      );
    } else {
      logger.warn('watchlist-poll job disabled (WatchlistService not provided)');
    }

    if (this.backupService) {
      this.#register(
        'backup',
        this.config.SCHEDULER_BACKUP_CRON,
        'Create a consistent database backup via VACUUM INTO and prune expired backups',
        async () => {
          const result = await this.backupService!.create();
          const pruned = await this.backupService!.prune();
          const sizeKb = (result.sizeBytes / 1024).toFixed(1);
          const msg = `Backup created: ${result.path} (${sizeKb}KB, ${result.durationMs}ms), pruned ${pruned} old backup(s)`;
          return msg;
        },
        'BACKUP',
      );
    } else {
      logger.warn('backup job disabled (BackupService not provided)');
    }

    if (this.pitrHealthService) {
      // No jobType: runs inline in the scheduler process (single cheap SQL
      // + fs stat), so the gauges stay fresh without a worker roundtrip.
      this.#register(
        'pitr-health',
        this.config.SCHEDULER_PITR_HEALTH_CRON,
        'Verify PostgreSQL WAL archiving and base-backup freshness (ADR-0054)',
        async () => {
          const result = await this.pitrHealthService!.check();
          const msg = result.ok
            ? `PITR OK: walLag=${result.walLagBytes ?? 'n/a'}, baseAge=${result.baseBackupAgeHours?.toFixed(1) ?? 'n/a'}h`
            : `PITR DEGRADED: ${result.problems.join('; ')}`;
          logger.info(msg);
          return msg;
        },
      );
    } else {
      logger.debug('pitr-health job disabled (PitrHealthService not provided)');
    }

    this.#scheduleEnabled = false;
  }

  stop(): void {
    for (const [name, task] of this.jobs) {
      void task.stop();
      logger.info(`Stopped job: ${name}`);
    }
    this.jobs.clear();
    this.running = false;
  }

  async runOnce(jobName: string): Promise<string> {
    const job = this.#getJobDefinition(jobName);
    if (!job) {
      throw new Error(`Unknown job: ${jobName}. Available: ${this.#availableJobs().join(', ')}`);
    }
    return await job.execute();
  }

  async getStatus(): Promise<ScheduledJob[]> {
    const dbJobs = (await this.jobRepo?.findAll()) ?? [];
    const dbMap = new Map(dbJobs.map((j) => [j.jobName, j]));
    return this.#availableJobs().map((name) => {
      const db = dbMap.get(name);
      return {
        name,
        cronExpression: this.#getCron(name),
        description: this.#getDescription(name),
        lastRunAt: db?.lastRunAt ?? null,
        lastResult: db?.lastResult ?? null,
      };
    });
  }

  #register(
    name: string,
    cronExpression: string,
    description: string,
    execute: () => Promise<string>,
    jobType?: string,
  ): void {
    const wrappedExec =
      this.jobQueueService && jobType
        ? async (): Promise<string> => {
            let jobId: string;
            switch (jobType) {
              case 'RENEWAL_CHECK':
                jobId = await this.jobQueueService!.enqueueRenewalCheck();
                break;
              case 'PORTFOLIO_RESCORE':
                jobId = await this.jobQueueService!.enqueuePortfolioRescore();
                break;
              case 'BACKUP':
                jobId = await this.jobQueueService!.enqueueBackup();
                break;
              case 'WATCHLIST_POLL':
                jobId = await this.jobQueueService!.enqueueWatchlistPoll();
                break;
              case 'PRUNE':
                jobId = await this.jobQueueService!.enqueuePrune();
                break;
              case 'WEIGHT_TUNE':
                jobId = await this.jobQueueService!.enqueueWeightTune();
                break;
              case 'PORTFOLIO_HEALTHCHECK':
                jobId = await this.jobQueueService!.enqueuePortfolioHealthcheck();
                break;
              case 'REVENUE_SYNC':
                jobId = await this.jobQueueService!.enqueueRevenueSync(
                  revenueSinceIso(this.config.REVENUE_SYNC_LOOKBACK_DAYS),
                );
                break;
              default:
                return await execute();
            }
            return `Job enqueued: ${jobId}`;
          }
        : execute;
    this.#setJobDefinition(name, cronExpression, description, wrappedExec);

    // Persist job definition to DB
    this.jobRepo?.upsert({ jobName: name, cronExpression, description }).catch(() => {
      // DB persistence is best-effort
    });

    // Definitions only (registerJobs): the job exists, but no cron timer
    // is armed for it. A manual one-shot run must not leave a schedule
    // behind.
    if (!this.#scheduleEnabled) return;

    if (cron.validate(cronExpression)) {
      const task = cron.schedule(cronExpression, () => {
        void this.#runScheduled(name, wrappedExec);
      });
      this.jobs.set(name, task);
    } else {
      logger.warn(`Invalid cron expression for job "${name}": ${cronExpression}. Job disabled.`);
    }
  }

  async #runScheduled(name: string, execute: () => Promise<string>): Promise<void> {
    const started = Date.now();
    if (this.lock) {
      const acquired = await this.lock.tryLock(
        cronFireSlotLockName(name, new Date()),
        CRON_FIRE_LOCK_TTL_MS,
      );
      if (!acquired) {
        logger.info(
          `Scheduled job ${name} skipped — another scheduler instance already fired in this window`,
        );
        return;
      }
    }
    try {
      const result = await execute();
      const durationMs = Date.now() - started;
      await this.jobRepo?.updateResult(name, {
        lastRunAt: new Date().toISOString(),
        lastResult: result,
        durationMs,
        isError: false,
      });
    } catch (err: unknown) {
      const durationMs = Date.now() - started;
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error(`Job ${name} failed: ${errorMsg}`);
      await this.jobRepo?.updateResult(name, {
        lastRunAt: new Date().toISOString(),
        lastResult: `Error: ${errorMsg}`,
        durationMs,
        isError: true,
      });
    }
  }

  #jobDefinitions: Map<
    string,
    { cronExpression: string; description: string; execute: () => Promise<string> }
  > = new Map();

  #setJobDefinition(
    name: string,
    cronExpression: string,
    description: string,
    execute: () => Promise<string>,
  ): void {
    this.#jobDefinitions.set(name, { cronExpression, description, execute });
  }

  #getJobDefinition(
    name: string,
  ): { cronExpression: string; description: string; execute: () => Promise<string> } | undefined {
    return this.#jobDefinitions.get(name);
  }

  #getCron(name: string): string {
    return this.#jobDefinitions.get(name)?.cronExpression ?? '';
  }

  #getDescription(name: string): string {
    return this.#jobDefinitions.get(name)?.description ?? '';
  }

  #availableJobs(): string[] {
    return Array.from(this.#jobDefinitions.keys());
  }
}
