import type Database from 'better-sqlite3';
import { JobQueueRepository } from '../db/repositories/job-queue-repository.js';
import type { JobType, JobHandler, JobQueueRow, JobPayload } from '../types/job-queue.js';
import { getLogger } from '../logger.js';

const logger = getLogger();

export interface WorkerConfig {
  concurrency: number;
  pollIntervalMs: number;
  maxRunningAgeMs: number;
  gracefulShutdownTimeoutMs: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyHandler = JobHandler<any, any>;

export class JobWorker {
  readonly #repo: JobQueueRepository;
  readonly #handlers: Map<JobType, AnyHandler>;
  readonly #config: WorkerConfig;
  #running: boolean = false;
  #activeJobs: Map<number, AbortController> = new Map();
  #pollTimer: ReturnType<typeof setTimeout> | null = null;
  #shutdownPromise: Promise<void> | null = null;
  #shutdownResolve: (() => void) | null = null;

  constructor(
    db: Database.Database,
    handlers: Map<JobType, AnyHandler>,
    config: Partial<WorkerConfig> = {},
  ) {
    this.#repo = new JobQueueRepository(db);
    this.#handlers = handlers;
    this.#config = {
      concurrency: config.concurrency ?? 2,
      pollIntervalMs: config.pollIntervalMs ?? 1000,
      maxRunningAgeMs: config.maxRunningAgeMs ?? 300000,
      gracefulShutdownTimeoutMs: config.gracefulShutdownTimeoutMs ?? 30000,
    };
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    logger.info({ concurrency: this.#config.concurrency }, 'JobWorker starting');
    this.#schedulePoll();
  }

  async stop(): Promise<void> {
    if (!this.#running) return;
    this.#running = false;

    if (this.#pollTimer) {
      clearTimeout(this.#pollTimer);
      this.#pollTimer = null;
    }

    logger.info(
      { activeJobs: this.#activeJobs.size },
      'JobWorker stopping, waiting for active jobs',
    );

    if (this.#activeJobs.size === 0) {
      logger.info('JobWorker stopped (no active jobs)');
      return;
    }

    this.#shutdownPromise = new Promise((resolve) => {
      this.#shutdownResolve = resolve;
    });

    const timeout = setTimeout(() => {
      logger.warn('Graceful shutdown timeout, forcing active jobs to abort');
      for (const [, controller] of this.#activeJobs) {
        controller.abort();
      }
      this.#shutdownResolve?.();
    }, this.#config.gracefulShutdownTimeoutMs);

    await this.#shutdownPromise;
    clearTimeout(timeout);
    logger.info('JobWorker stopped');
  }

  #schedulePoll(): void {
    if (!this.#running) return;
    this.#pollTimer = setTimeout(() => this.#poll(), this.#config.pollIntervalMs).unref();
  }

  async #poll(): Promise<void> {
    if (!this.#running) return;

    const runningCount = this.#activeJobs.size;
    if (runningCount >= this.#config.concurrency) {
      this.#schedulePoll();
      return;
    }

    const availableSlots = this.#config.concurrency - runningCount;
    for (let i = 0; i < availableSlots; i++) {
      const job = this.#repo.dequeue();
      if (!job) break;
      void this.#processJob(job);
    }

    const requeued = this.#repo.requeueStuck(this.#config.maxRunningAgeMs);
    if (requeued > 0) {
      logger.warn({ requeued }, 'Requeued stuck jobs');
    }

    this.#schedulePoll();
  }

  async #processJob(job: JobQueueRow): Promise<void> {
    const controller = new AbortController();
    this.#activeJobs.set(job.id, controller);

    const handler = this.#handlers.get(job.jobType);
    if (!handler) {
      const error = `No handler registered for job type: ${job.jobType}`;
      logger.error({ jobId: job.id, jobType: job.jobType }, error);
      this.#repo.fail(job.id, error);
      this.#activeJobs.delete(job.id);
      this.#checkShutdown();
      return;
    }

    logger.info({ jobId: job.id, jobType: job.jobType, attempt: job.attempts }, 'Processing job');

    try {
      const payload = JSON.parse(job.payloadJson) as JobPayload;
      const result = await handler.handle(payload, controller.signal);

      this.#repo.complete(job.id, result);
      logger.info({ jobId: job.id, jobType: job.jobType }, 'Job completed');
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      if (err instanceof DOMException && err.name === 'AbortError') {
        logger.warn({ jobId: job.id }, 'Job aborted during shutdown');
      } else {
        logger.error({ jobId: job.id, jobType: job.jobType, error }, 'Job failed');
        this.#repo.fail(job.id, error);
      }
    } finally {
      this.#activeJobs.delete(job.id);
      this.#checkShutdown();
    }
  }

  #checkShutdown(): void {
    if (!this.#running && this.#activeJobs.size === 0 && this.#shutdownResolve) {
      this.#shutdownResolve();
    }
  }

  getStatus(): { running: boolean; activeJobs: number; concurrency: number } {
    return {
      running: this.#running,
      activeJobs: this.#activeJobs.size,
      concurrency: this.#config.concurrency,
    };
  }
}
