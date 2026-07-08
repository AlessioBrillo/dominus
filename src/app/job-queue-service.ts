import type { DatabaseProvider } from '../db/provider/interface.js';
import { JobQueueRepository } from '../db/repositories/job-queue-repository.js';
import type {
  JobType,
  JobPayload,
  JobResult,
  PipelineRunPayload,
  JobQueueRow,
  JobQueueStats,
  DeadLetterJobRow,
} from '../types/job-queue.js';
import type { CandidateGenerationInput } from '../pipeline/stages/candidate-generation-stage.js';
import { getTenantId } from '../utils/tenant-context.js';
import { getLogger } from '../logger.js';

const logger = getLogger();

export interface EnqueueResult {
  jobId: string;
  runId: string;
}

export interface JobQueueServiceOptions {
  /**
   * Maximum number of queued jobs allowed. When exceeded, enqueue()
   * throws a DominusError. Set to 0 to disable (unbounded).
   * Default: 1000
   */
  maxQueueDepth?: number;
}

export interface JobQueueService {
  enqueuePipelineRun(input: CandidateGenerationInput, runId?: string): Promise<EnqueueResult>;
  enqueuePortfolioRescore(domain?: string): Promise<string>;
  enqueueBacktestBuild(minSampleSize?: number): Promise<string>;
  enqueueBackup(retentionDays?: number): Promise<string>;
  enqueuePrune(maxAgeDays?: number): Promise<string>;
  enqueueWatchlistPoll(): Promise<string>;
  enqueueRenewalCheck(): Promise<string>;
  enqueueWeightTune(): Promise<string>;
  getJobStatus(jobId: number): Promise<{ job: JobQueueRow; result?: JobResult } | null>;
  getQueueStats(): Promise<JobQueueStats>;
  listJobs(options?: {
    status?: string;
    jobType?: string;
    limit?: number;
    offset?: number;
  }): Promise<JobQueueRow[]>;
  getDeadLetter(options?: { limit?: number; offset?: number }): Promise<DeadLetterJobRow[]>;
  retryDeadLetter(deadLetterId: number): Promise<number | null>;
  deleteCompletedJobs(olderThanDays?: number): Promise<number>;
  deleteDeadLetterJobs(olderThanDays?: number): Promise<number>;
}

export function createJobQueueService(
  provider: DatabaseProvider,
  options: JobQueueServiceOptions = {},
): JobQueueService {
  const repo = new JobQueueRepository(provider);
  const maxDepth = options.maxQueueDepth ?? 1000;

  async function enqueue(
    jobType: JobType,
    payload: JobPayload,
    options: { priority?: number; maxAttempts?: number; scheduledAt?: string } = {},
  ): Promise<string> {
    // Reject when the queue has grown beyond the configured limit to prevent
    // unbounded growth when the worker cannot keep up (ADR-0023 §4.7).
    if (maxDepth > 0) {
      const stats = await repo.getStats();
      if (stats.queued + stats.running >= maxDepth) {
        throw new Error(
          `Job queue depth limit reached (${maxDepth}) — rejecting enqueue of ${jobType}. ` +
            'Increase JOB_QUEUE_MAX_DEPTH or wait for the worker to drain pending jobs.',
        );
      }
    }

    // Inject the current tenant context into the job payload so the worker
    // can re-establish it when processing. The worker reads .tenantId and
    // wraps handler execution in runWithTenant(), which the PostgreSQL
    // adapter's #withTenant uses to set app.tenant_id for RLS policies.
    const tenantId = getTenantId();
    const augmentedPayload: JobPayload = tenantId
      ? ({ ...payload, tenantId } as JobPayload)
      : payload;
    const jobId = await repo.enqueue(jobType, augmentedPayload, options);
    logger.info({ jobId, jobType }, 'Job enqueued');
    return String(jobId);
  }

  return {
    async enqueuePipelineRun(
      input: CandidateGenerationInput,
      runId?: string,
    ): Promise<EnqueueResult> {
      const id = runId ?? generateRunId();
      const payload: PipelineRunPayload = {
        candidateGenerationInput: input,
        runId: id,
      };
      const jobId = await enqueue('PIPELINE_RUN', payload, { priority: 10 });
      return { jobId, runId: id };
    },

    async enqueuePortfolioRescore(domain?: string): Promise<string> {
      return enqueue(
        'PORTFOLIO_RESCORE',
        { ...(domain !== undefined && { domain }) },
        { priority: 5 },
      );
    },

    async enqueueBacktestBuild(minSampleSize?: number): Promise<string> {
      return enqueue(
        'BACKTEST_BUILD',
        { ...(minSampleSize !== undefined && { minSampleSize }) },
        { priority: 0 },
      );
    },

    async enqueueBackup(retentionDays?: number): Promise<string> {
      return enqueue(
        'BACKUP',
        { ...(retentionDays !== undefined && { retentionDays }) },
        { priority: 0 },
      );
    },

    async enqueuePrune(maxAgeDays?: number): Promise<string> {
      return enqueue('PRUNE', { ...(maxAgeDays !== undefined && { maxAgeDays }) }, { priority: 0 });
    },

    async enqueueWatchlistPoll(): Promise<string> {
      return enqueue('WATCHLIST_POLL', {}, { priority: 0 });
    },

    async enqueueRenewalCheck(): Promise<string> {
      return enqueue('RENEWAL_CHECK', {}, { priority: 0 });
    },

    async enqueueWeightTune(): Promise<string> {
      return enqueue('WEIGHT_TUNE', {}, { priority: 0 });
    },

    async getJobStatus(jobId: number): Promise<{ job: JobQueueRow; result?: JobResult } | null> {
      const job = await repo.getById(jobId);
      if (!job) return null;

      let parsed: JobResult | undefined;
      if (job.resultJson) {
        try {
          parsed = JSON.parse(job.resultJson) as JobResult;
        } catch {
          // ignore parse errors
        }
      }
      return parsed === undefined ? { job } : { job, result: parsed };
    },

    async getQueueStats(): Promise<JobQueueStats> {
      return repo.getStats();
    },

    async listJobs(options?: {
      status?: string;
      jobType?: string;
      limit?: number;
      offset?: number;
    }): Promise<JobQueueRow[]> {
      return repo.list(options);
    },

    async getDeadLetter(options?: {
      limit?: number;
      offset?: number;
    }): Promise<DeadLetterJobRow[]> {
      return repo.getDeadLetter(options);
    },

    async retryDeadLetter(deadLetterId: number): Promise<number | null> {
      return repo.retryDeadLetter(deadLetterId);
    },

    async deleteCompletedJobs(olderThanDays?: number): Promise<number> {
      return repo.deleteCompleted(olderThanDays);
    },

    async deleteDeadLetterJobs(olderThanDays?: number): Promise<number> {
      return repo.deleteDeadLetter(olderThanDays);
    },
  };
}

function generateRunId(): string {
  return `run_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}
