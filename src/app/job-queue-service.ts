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
import { getLogger } from '../logger.js';

const logger = getLogger();

export interface EnqueueResult {
  jobId: string;
  runId: string;
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

export function createJobQueueService(provider: DatabaseProvider): JobQueueService {
  const repo = new JobQueueRepository(provider);

  async function enqueue(
    jobType: JobType,
    payload: JobPayload,
    options: { priority?: number; maxAttempts?: number; scheduledAt?: string } = {},
  ): Promise<string> {
    const jobId = await repo.enqueue(jobType, payload, options);
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
      return enqueue('PORTFOLIO_RESCORE', { domain }, { priority: 5 });
    },

    async enqueueBacktestBuild(minSampleSize?: number): Promise<string> {
      return enqueue('BACKTEST_BUILD', { minSampleSize }, { priority: 0 });
    },

    async enqueueBackup(retentionDays?: number): Promise<string> {
      return enqueue('BACKUP', { retentionDays }, { priority: 0 });
    },

    async enqueuePrune(maxAgeDays?: number): Promise<string> {
      return enqueue('PRUNE', { maxAgeDays }, { priority: 0 });
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
