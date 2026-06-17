import type Database from 'better-sqlite3';
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
  getJobStatus(jobId: number): Promise<{ job: JobQueueRow; result?: JobResult } | null>;
  getQueueStats(): JobQueueStats;
  listJobs(options?: {
    status?: string;
    jobType?: string;
    limit?: number;
    offset?: number;
  }): JobQueueRow[];
  getDeadLetter(options?: { limit?: number; offset?: number }): DeadLetterJobRow[];
  retryDeadLetter(deadLetterId: number): number | null;
  deleteCompletedJobs(olderThanDays?: number): number;
  deleteDeadLetterJobs(olderThanDays?: number): number;
}

export function createJobQueueService(db: Database.Database): JobQueueService {
  const repo = new JobQueueRepository(db);

  function enqueue(
    jobType: JobType,
    payload: JobPayload,
    options: { priority?: number; maxAttempts?: number; scheduledAt?: string } = {},
  ): string {
    const jobId = repo.enqueue(jobType, payload, options);
    logger.info({ jobId, jobType }, 'Job enqueued');
    return String(jobId);
  }

  return {
    enqueuePipelineRun(input: CandidateGenerationInput, runId?: string): Promise<EnqueueResult> {
      const id = runId ?? generateRunId();
      const payload: PipelineRunPayload = {
        candidateGenerationInput: input,
        runId: id,
      };
      const jobId = enqueue('PIPELINE_RUN', payload, { priority: 10 });
      return Promise.resolve({ jobId, runId: id });
    },

    enqueuePortfolioRescore(domain?: string): Promise<string> {
      return Promise.resolve(enqueue('PORTFOLIO_RESCORE', { domain }, { priority: 5 }));
    },

    enqueueBacktestBuild(minSampleSize?: number): Promise<string> {
      return Promise.resolve(enqueue('BACKTEST_BUILD', { minSampleSize }, { priority: 0 }));
    },

    enqueueBackup(retentionDays?: number): Promise<string> {
      return Promise.resolve(enqueue('BACKUP', { retentionDays }, { priority: 0 }));
    },

    enqueuePrune(maxAgeDays?: number): Promise<string> {
      return Promise.resolve(enqueue('PRUNE', { maxAgeDays }, { priority: 0 }));
    },

    enqueueWatchlistPoll(): Promise<string> {
      return Promise.resolve(enqueue('WATCHLIST_POLL', {}, { priority: 0 }));
    },

    enqueueRenewalCheck(): Promise<string> {
      return Promise.resolve(enqueue('RENEWAL_CHECK', {}, { priority: 0 }));
    },

    getJobStatus(jobId: number): Promise<{ job: JobQueueRow; result?: JobResult } | null> {
      const job = repo.getById(jobId);
      if (!job) return Promise.resolve(null);

      let parsed: JobResult | undefined;
      if (job.resultJson) {
        try {
          parsed = JSON.parse(job.resultJson) as JobResult;
        } catch {
          // ignore parse errors
        }
      }
      const status: { job: JobQueueRow; result?: JobResult } =
        parsed === undefined ? { job } : { job, result: parsed };
      return Promise.resolve(status);
    },

    getQueueStats(): JobQueueStats {
      return repo.getStats();
    },

    listJobs(options?: {
      status?: string;
      jobType?: string;
      limit?: number;
      offset?: number;
    }): JobQueueRow[] {
      return repo.list(options);
    },

    getDeadLetter(options?: { limit?: number; offset?: number }): DeadLetterJobRow[] {
      return repo.getDeadLetter(options);
    },

    retryDeadLetter(deadLetterId: number): number | null {
      return repo.retryDeadLetter(deadLetterId);
    },

    deleteCompletedJobs(olderThanDays?: number): number {
      return repo.deleteCompleted(olderThanDays);
    },

    deleteDeadLetterJobs(olderThanDays?: number): number {
      return repo.deleteDeadLetter(olderThanDays);
    },
  };
}

function generateRunId(): string {
  return `run_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}
