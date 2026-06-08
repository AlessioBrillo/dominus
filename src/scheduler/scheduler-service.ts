import cron from 'node-cron';
import type { RenewalAlertEngine } from '../portfolio/renewal-alert-engine.js';
import type { PortfolioManager } from '../portfolio/portfolio-manager.js';
import type { TrademarkRepository } from '../db/repositories/trademark-repository.js';
import type { PipelineRunsRepository } from '../db/repositories/pipeline-runs-repository.js';
import type { WatchlistService } from '../watchlist/watchlist-service.js';
import type { Config } from '../config.js';
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
  runsRepo?: PipelineRunsRepository;
  watchlistService?: WatchlistService;
}

export class SchedulerService {
  private readonly jobs: Map<string, cron.ScheduledTask> = new Map();
  private readonly status: Map<string, { lastRunAt: string | null; lastResult: string | null }> =
    new Map();
  private readonly config: Config;
  private readonly alertEngine: RenewalAlertEngine;
  private readonly portfolioManager: PortfolioManager | undefined;
  private readonly trademarkRepo: TrademarkRepository | undefined;
  private readonly runsRepo: PipelineRunsRepository | undefined;
  private readonly watchlistService: WatchlistService | undefined;
  private running = false;

  constructor(options: SchedulerOptions) {
    this.config = options.config;
    this.alertEngine = options.alertEngine;
    this.portfolioManager = options.portfolioManager;
    this.trademarkRepo = options.trademarkRepo;
    this.runsRepo = options.runsRepo;
    this.watchlistService = options.watchlistService;
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
      );
    } else {
      logger.warn('portfolio-rescore job disabled (PortfolioManager not provided)');
    }

    if (this.trademarkRepo && this.runsRepo) {
      this.#register(
        'data-prune',
        this.config.SCHEDULER_PRUNE_CRON,
        'Prune expired trademark cache and pipeline run history',
        async () => {
          const tmRemoved = this.trademarkRepo!.pruneExpired();
          const runsRemoved = this.runsRepo!.prune();
          const msg = `Pruned ${tmRemoved} trademark cache + ${runsRemoved} pipeline run(s)`;
          logger.info(msg);
          return msg;
        },
      );
    } else {
      logger.warn(
        'data-prune job disabled (TrademarkRepository or PipelineRunsRepository not provided)',
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
      );
    } else {
      logger.warn('watchlist-poll job disabled (WatchlistService not provided)');
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
    return this.#availableJobs().map((name) => {
      const s = this.status.get(name);
      return {
        name,
        cronExpression: this.#getCron(name),
        description: this.#getDescription(name),
        lastRunAt: s?.lastRunAt ?? null,
        lastResult: s?.lastResult ?? null,
      };
    });
  }

  #register(
    name: string,
    cronExpression: string,
    description: string,
    execute: () => Promise<string>,
  ): void {
    this.#setJobDefinition(name, cronExpression, description, execute);

    if (cron.validate(cronExpression)) {
      const task = cron.schedule(cronExpression, () => {
        execute()
          .then((result) => {
            this.status.set(name, { lastRunAt: new Date().toISOString(), lastResult: result });
          })
          .catch((err: unknown) => {
            const errorMsg = err instanceof Error ? err.message : String(err);
            logger.error(`Job ${name} failed: ${errorMsg}`);
            this.status.set(name, {
              lastRunAt: new Date().toISOString(),
              lastResult: `Error: ${errorMsg}`,
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
