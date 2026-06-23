import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../db/migrator.js';
import { SqliteProvider } from '../../db/provider/sqlite-adapter.js';
import { createJobQueueService } from '../job-queue-service.js';
import type { JobQueueService } from '../job-queue-service.js';

function openTestDb(): SqliteProvider {
  const provider = new SqliteProvider(new Database(':memory:'));
  provider.rawDb.pragma('journal_mode = WAL');
  provider.rawDb.pragma('foreign_keys = ON');
  runMigrations(provider.rawDb);
  return provider;
}

describe('JobQueueService', () => {
  let provider: SqliteProvider;
  let service: JobQueueService;

  beforeEach(() => {
    provider = openTestDb();
    service = createJobQueueService(provider.rawDb);
  });

  afterEach(() => {
    provider.close();
  });

  describe('enqueuePipelineRun', () => {
    it('enqueues a pipeline run job with priority 10', async () => {
      const { jobId, runId } = await service.enqueuePipelineRun({
        keywords: ['test'],
        brandableNames: [],
      });

      const parsedJobId = Number(jobId);
      expect(parsedJobId).toBeGreaterThan(0);
      expect(runId).toMatch(/^run_/);

      const status = await service.getJobStatus(parsedJobId);
      expect(status).not.toBeNull();
      expect(status!.job.jobType).toBe('PIPELINE_RUN');
      expect(status!.job.priority).toBe(10);
    });
  });

  describe('enqueuePortfolioRescore', () => {
    it('enqueues a rescore for all domains', async () => {
      const jobIdStr = await service.enqueuePortfolioRescore();
      const status = await service.getJobStatus(Number(jobIdStr));
      expect(status!.job.jobType).toBe('PORTFOLIO_RESCORE');
    });

    it('enqueues a rescore for a specific domain', async () => {
      const jobIdStr = await service.enqueuePortfolioRescore('example.com');
      const status = await service.getJobStatus(Number(jobIdStr));
      const payload = JSON.parse(status!.job.payloadJson);
      expect(payload.domain).toBe('example.com');
    });
  });

  describe('enqueueBacktestBuild', () => {
    it('enqueues a backtest build job', async () => {
      const jobIdStr = await service.enqueueBacktestBuild(10);
      const status = await service.getJobStatus(Number(jobIdStr));
      expect(status!.job.jobType).toBe('BACKTEST_BUILD');
      const payload = JSON.parse(status!.job.payloadJson);
      expect(payload.minSampleSize).toBe(10);
    });
  });

  describe('enqueueBackup', () => {
    it('enqueues a backup job with retention', async () => {
      const jobIdStr = await service.enqueueBackup(14);
      const status = await service.getJobStatus(Number(jobIdStr));
      expect(status!.job.jobType).toBe('BACKUP');
    });
  });

  describe('enqueuePrune', () => {
    it('enqueues a prune job', async () => {
      const jobIdStr = await service.enqueuePrune(60);
      const status = await service.getJobStatus(Number(jobIdStr));
      expect(status!.job.jobType).toBe('PRUNE');
    });
  });

  describe('enqueueWatchlistPoll', () => {
    it('enqueues a watchlist poll job', async () => {
      const jobIdStr = await service.enqueueWatchlistPoll();
      const status = await service.getJobStatus(Number(jobIdStr));
      expect(status!.job.jobType).toBe('WATCHLIST_POLL');
    });
  });

  describe('enqueueRenewalCheck', () => {
    it('enqueues a renewal check job', async () => {
      const jobIdStr = await service.enqueueRenewalCheck();
      const status = await service.getJobStatus(Number(jobIdStr));
      expect(status!.job.jobType).toBe('RENEWAL_CHECK');
    });
  });

  describe('getJobStatus', () => {
    it('returns null for a non-existent job id', async () => {
      const status = await service.getJobStatus(99999);
      expect(status).toBeNull();
    });

    it('includes parsed result when job has resultJson', async () => {
      // Manually enqueue and complete a job via the repo to set up resultJson
      const jobIdStr = await service.enqueuePrune();
      const jobId = Number(jobIdStr);
      const repo = new (
        await import('../../db/repositories/job-queue-repository.js')
      ).JobQueueRepository(provider);
      await repo.dequeue();
      await repo.complete(jobId, { deleted: 5 });

      const status = await service.getJobStatus(jobId);
      expect(status!.result).toEqual({ deleted: 5 });
    });
  });

  describe('getQueueStats', () => {
    it('returns stats from the repository', async () => {
      await service.enqueuePipelineRun({ keywords: ['a', 'b'] });
      const stats = await service.getQueueStats();
      expect(stats.queued).toBe(1);
      expect(stats.total).toBe(1);
    });
  });

  describe('listJobs', () => {
    it('lists enqueued jobs', async () => {
      await service.enqueuePrune();
      await service.enqueueBackup();
      const jobs = await service.listJobs();
      expect(jobs).toHaveLength(2);
    });

    it('filters by job type', async () => {
      await service.enqueuePrune();
      await service.enqueueBackup();
      const jobs = await service.listJobs({ jobType: 'PRUNE' });
      expect(jobs).toHaveLength(1);
    });
  });

  describe('dead letter operations', () => {
    it('getDeadLetter and retryDeadLetter work end-to-end', async () => {
      const { jobId: jobIdStr } = await service.enqueuePipelineRun({ keywords: [] });
      const jobId = Number(jobIdStr);

      const repo = new (
        await import('../../db/repositories/job-queue-repository.js')
      ).JobQueueRepository(provider);
      await repo.dequeue();
      await repo.fail(jobId, 'permanent error');
      await repo.dequeue();
      await repo.fail(jobId, 'permanent error 2');
      await repo.dequeue();
      await repo.fail(jobId, 'permanent error 3');

      const deadLetters = await service.getDeadLetter();
      expect(deadLetters).toHaveLength(1);

      const newJobId = await service.retryDeadLetter(deadLetters[0]!.id);
      expect(newJobId).toBeGreaterThan(0);
      expect(await service.getDeadLetter()).toHaveLength(0);
    });
  });

  describe('deleteCompletedJobs / deleteDeadLetterJobs', () => {
    it('deletes old completed jobs', async () => {
      const jobIdStr = await service.enqueuePrune();
      const jobId = Number(jobIdStr);
      const repo = new (
        await import('../../db/repositories/job-queue-repository.js')
      ).JobQueueRepository(provider);
      await repo.dequeue();
      await repo.complete(jobId, {});
      provider.rawDb
        .prepare("UPDATE job_queue SET finished_at = datetime('now', '-10 days') WHERE id = ?")
        .run(jobId);

      const deleted = await service.deleteCompletedJobs(7);
      expect(deleted).toBe(1);
    });

    it('deletes old dead letter entries', async () => {
      const jobIdStr = await service.enqueuePrune();
      const jobId = Number(jobIdStr);

      const repo = new (
        await import('../../db/repositories/job-queue-repository.js')
      ).JobQueueRepository(provider);
      await repo.dequeue();
      await repo.fail(jobId, 'boom');
      await repo.dequeue();
      await repo.fail(jobId, 'boom 2');
      await repo.dequeue();
      await repo.fail(jobId, 'boom 3');

      provider.rawDb
        .prepare("UPDATE dead_letter_jobs SET failed_at = datetime('now', '-40 days')")
        .run();

      const deleted = await service.deleteDeadLetterJobs(30);
      expect(deleted).toBe(1);
    });
  });
});
