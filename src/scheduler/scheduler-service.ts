import cron from 'node-cron';
import type { RenewalAlertEngine } from '../portfolio/renewal-alert-engine.js';
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

export class SchedulerService {
  private readonly jobs: Map<string, cron.ScheduledTask> = new Map();
  private readonly status: Map<string, { lastRunAt: string | null; lastResult: string | null }> = new Map();
  private running = false;

  constructor(
    private readonly config: Config,
    private readonly alertEngine: RenewalAlertEngine,
  ) {}

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

    logger.info(
      `Scheduler started with ${this.jobs.size} job(s)`,
    );
  }

  stop(): void {
    for (const [name, task] of this.jobs) {
      task.stop();
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
      const task = cron.schedule(cronExpression, async () => {
        try {
          const result = await execute();
          this.status.set(name, { lastRunAt: new Date().toISOString(), lastResult: result });
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          logger.error(`Job ${name} failed: ${errorMsg}`);
          this.status.set(name, { lastRunAt: new Date().toISOString(), lastResult: `Error: ${errorMsg}` });
        }
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
