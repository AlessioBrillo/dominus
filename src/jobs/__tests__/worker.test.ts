/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/explicit-function-return-type */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../db/migrator.js';
import { JobQueueRepository } from '../../db/repositories/job-queue-repository.js';
import { JobWorker } from '../worker.js';
import type { JobType, JobHandler, JobPayload, JobResult } from '../../types/job-queue.js';

function openTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function makeMockHandler(
  jobType: JobType,
  onHandle?: (payload: JobPayload, signal?: AbortSignal) => Promise<JobResult>,
): JobHandler<any, any> {
  return {
    jobType,
    handle: vi.fn(onHandle ?? (async () => ({}) as JobResult)),
  };
}

const FAST_POLL = { pollIntervalMs: 20, gracefulShutdownTimeoutMs: 100 };

describe('JobWorker', () => {
  let db: Database.Database;
  let repo: JobQueueRepository;
  let handlers: Map<JobType, JobHandler<any, any>>;
  const workers: JobWorker[] = [];

  beforeEach(() => {
    db = openTestDb();
    repo = new JobQueueRepository(db);
    handlers = new Map();
  });

  afterEach(async () => {
    for (const w of workers) {
      await w.stop().catch(() => {});
    }
    workers.length = 0;
    if (db.open) {
      db.close();
    }
  });

  describe('start / stop', () => {
    it('starts and stops gracefully', async () => {
      const worker = new JobWorker(db, handlers, FAST_POLL);
      workers.push(worker);

      worker.start();
      expect(worker.getStatus().running).toBe(true);

      await worker.stop();
      expect(worker.getStatus().running).toBe(false);
    });

    it('is idempotent on repeated start', () => {
      const worker = new JobWorker(db, handlers, FAST_POLL);
      workers.push(worker);

      worker.start();
      worker.start();
      expect(worker.getStatus().running).toBe(true);
      worker.stop();
    });

    it('is idempotent on repeated stop', async () => {
      const worker = new JobWorker(db, handlers);
      workers.push(worker);

      worker.start();
      await worker.stop();
      await worker.stop();
    });
  });

  describe('job processing', () => {
    it('dequeues and processes a job, completing it', async () => {
      const handler = makeMockHandler('PRUNE', async () => ({
        deletedCandidates: 5,
        deletedJobQueue: 0,
        deletedPipelineRuns: 0,
        deletedProviderCache: 0,
        deletedScoringRuns: 0,
      }));
      handlers.set('PRUNE', handler);
      const worker = new JobWorker(db, handlers, FAST_POLL);
      workers.push(worker);

      const jobId = repo.enqueue('PRUNE', { maxAgeDays: 30 });
      worker.start();

      await vi.waitFor(
        () => {
          expect(repo.getById(jobId)?.status).toBe('completed');
        },
        { timeout: 5000, interval: 20 },
      );

      expect(handler.handle).toHaveBeenCalledTimes(1);
    });

    it('handles job failure and requeues within attempt limit', async () => {
      const handler = makeMockHandler('BACKUP', async () => {
        throw new Error('disk full');
      });
      handlers.set('BACKUP', handler);
      const worker = new JobWorker(db, handlers, FAST_POLL);
      workers.push(worker);

      const jobId = repo.enqueue('BACKUP', {}, { maxAttempts: 3 });
      worker.start();

      await vi.waitFor(
        () => {
          expect(repo.getById(jobId)?.attempts).toBeGreaterThanOrEqual(1);
        },
        { timeout: 5000, interval: 20 },
      );
    });

    it('moves job to dead letter when maxAttempts exceeded', async () => {
      const handler = makeMockHandler('BACKUP', async () => {
        throw new Error('fatal');
      });
      handlers.set('BACKUP', handler);
      const worker = new JobWorker(db, handlers, FAST_POLL);
      workers.push(worker);

      const jobId = repo.enqueue('BACKUP', {}, { maxAttempts: 1 });
      worker.start();

      await vi.waitFor(
        () => {
          expect(repo.getById(jobId)).toBeNull();
        },
        { timeout: 5000, interval: 20 },
      );

      const deadLetters = repo.getDeadLetter();
      expect(deadLetters).toHaveLength(1);
      expect(deadLetters[0]!.error).toContain('fatal');
    });

    it('moves job to dead letter when no handler registered and maxAttempts exhausted', async () => {
      const worker = new JobWorker(db, handlers, FAST_POLL);
      workers.push(worker);

      const jobId = repo.enqueue('PIPELINE_RUN', {}, { maxAttempts: 1 });
      worker.start();

      await vi.waitFor(
        () => {
          expect(repo.getById(jobId)).toBeNull();
        },
        { timeout: 5000, interval: 20 },
      );

      const deadLetters = repo.getDeadLetter();
      expect(deadLetters.length).toBeGreaterThanOrEqual(1);
    });

    it('aborts running jobs during shutdown', async () => {
      let signalReceived: AbortSignal | undefined;
      const handler = makeMockHandler('PIPELINE_RUN', async (_, signal) => {
        signalReceived = signal;
        await new Promise((_, reject) => {
          signal!.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        });
        return { runId: 'ignored', recommended: 0, scored: 0, totalDurationMs: 0, stageErrors: [] };
      });
      handlers.set('PIPELINE_RUN', handler);
      const worker = new JobWorker(db, handlers, {
        pollIntervalMs: 20,
        gracefulShutdownTimeoutMs: 200,
      });
      workers.push(worker);

      repo.enqueue('PIPELINE_RUN', { candidateGenerationInput: { keywords: [] }, runId: 'r1' });
      worker.start();

      await vi.waitFor(
        () => {
          expect(worker.getStatus().activeJobs).toBe(1);
        },
        { timeout: 5000, interval: 20 },
      );

      await worker.stop();
      expect(signalReceived).toBeDefined();
      expect(signalReceived?.aborted).toBe(true);
    });
  });

  describe('concurrency', () => {
    it('processes up to the configured concurrency limit', async () => {
      let concurrent = 0;
      let maxConcurrent = 0;
      const handler = makeMockHandler('PRUNE', async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 200));
        concurrent--;
        return {
          deletedCandidates: 1,
          deletedJobQueue: 0,
          deletedPipelineRuns: 0,
          deletedProviderCache: 0,
          deletedScoringRuns: 0,
        };
      });
      handlers.set('PRUNE', handler);
      const worker = new JobWorker(db, handlers, {
        concurrency: 3,
        pollIntervalMs: 20,
        gracefulShutdownTimeoutMs: 100,
      });
      workers.push(worker);

      for (let i = 0; i < 5; i++) {
        repo.enqueue('PRUNE', {});
      }
      worker.start();

      await new Promise((resolve) => setTimeout(resolve, 800));
      expect(maxConcurrent).toBeGreaterThanOrEqual(2);
      expect(maxConcurrent).toBeLessThanOrEqual(3);
    });
  });

  describe('getStatus', () => {
    it('returns correct status before and after start', () => {
      const worker = new JobWorker(db, handlers, FAST_POLL);
      workers.push(worker);

      expect(worker.getStatus()).toEqual({ running: false, activeJobs: 0, concurrency: 2 });
      worker.start();
      expect(worker.getStatus().running).toBe(true);
      worker.stop();
    });
  });
});
