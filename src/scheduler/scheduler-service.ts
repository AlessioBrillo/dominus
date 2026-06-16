import cron from 'node-cron';
import type { RenewalAlertEngine } from '../portfolio/renewal-alert-engine.js';
import type { PortfolioManager } from '../portfolio/portfolio-manager.js';
import type { TrademarkRepository } from '../db/repositories/trademark-repository.js';
import type { PipelineRunsRepository } from '../db/repositories/pipeline-runs-repository.js';
import type { ProviderCacheRepository } from '../db/repositories/provider-cache-repository.js';
import type { WatchlistService } from '../watchlist/watchlist-service.js';
import type { AutoWeightTuner } from '../scoring/auto-tuner.js';
import type { BackupService } from './backup-service.js';
import type { Config } from '../config.js';
import { type SchedulerJobRepository } from '../db/repositories/scheduler-job-repository.js';
import type { JobQueueService } from '../app/job-queue-service.js';
import { getLogger } from '../logger.js';

const logger = getLogger();

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
}

export class SchedulerService {
  private readonly jobs: Map<string, cron.ScheduledTask> = new Map();
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
  private running = false;

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
  }

  start(): void {
    if (this.running) return;
    this.running = true;

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

    if (this.trademarkRepo && this.runsRepo) {
      this.#register(
        'data-prune',
        this.config.SCHEDULER_PRUNE_CRON,
        'Prune expired trademark cache, provider cache, and pipeline run history',
        async () => {
          const tmRemoved = this.trademarkRepo!.pruneExpired();
          const pcRemoved = this.providerCacheRepo?.pruneExpired() ?? 0;
          const runsRemoved = this.runsRepo!.prune();
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
          const outcome = this.autoTuner!.tune();
          const msg = `Weight tune: sample=${outcome.sampleSize}, safety=${outcome.safety.passed ? 'passed' : 'failed'}, applied=${outcome.applied}`;
          logger.info(msg);
          return msg;
        },
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
          const pruned = this.backupService!.prune();
          const sizeKb = (result.sizeBytes / 1024).toFixed(1);
          const msg = `Backup created: ${result.path} (${sizeKb}KB, ${result.durationMs}ms), pruned ${pruned} old backup(s)`;
          return msg;
        },
        'BACKUP',
      );
    } else {
      logger.warn('backup job disabled (BackupService not provided)');
    }

    logger.info(`Scheduler started with ${this.jobs.size} job(s)`);
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

  getStatus(): ScheduledJob[] {
    const dbJobs = this.jobRepo?.findAll() ?? [];
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
              default:
                return await execute();
            }
            return `Job enqueued: ${jobId}`;
          }
        : execute;
    this.#setJobDefinition(name, cronExpression, description, wrappedExec);

    // Persist job definition to DB
    try {
      this.jobRepo?.upsert({ jobName: name, cronExpression, description });
    } catch {
      // DB persistence is best-effort
    }

    if (cron.validate(cronExpression)) {
      const task = cron.schedule(cronExpression, () => {
        const started = Date.now();
        execute()
          .then((result) => {
            const durationMs = Date.now() - started;
            this.jobRepo?.updateResult(name, {
              lastRunAt: new Date().toISOString(),
              lastResult: result,
              durationMs,
              isError: false,
            });
          })
          .catch((err: unknown) => {
            const durationMs = Date.now() - started;
            const errorMsg = err instanceof Error ? err.message : String(err);
            logger.error(`Job ${name} failed: ${errorMsg}`);
            this.jobRepo?.updateResult(name, {
              lastRunAt: new Date().toISOString(),
              lastResult: `Error: ${errorMsg}`,
              durationMs,
              isError: true,
            });
          });
      });
      this.jobs.set(name, task);
    } else {
      logger.warn(`Invalid cron expression for job "${name}": ${cronExpression}. Job disabled.`);
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
