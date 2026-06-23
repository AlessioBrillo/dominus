import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../migrator.js';
import { SqliteProvider } from '../../provider/sqlite-adapter.js';
import { JobQueueRepository } from '../job-queue-repository.js';

function openTestDb(): SqliteProvider {
  const provider = new SqliteProvider(new Database(':memory:'));
  provider.rawDb.pragma('journal_mode = WAL');
  provider.rawDb.pragma('foreign_keys = ON');
  runMigrations(provider.rawDb);
  return provider;
}

describe('JobQueueRepository', () => {
  let provider: SqliteProvider;
  let repo: JobQueueRepository;

  beforeEach(() => {
    provider = openTestDb();
    repo = new JobQueueRepository(provider);
  });

  afterEach(() => {
    provider.close();
  });

  describe('enqueue', () => {
    it('inserts a job and returns its id', async () => {
      const id = await repo.enqueue('PIPELINE_RUN', { task: 'test' });
      expect(id).toBeGreaterThan(0);
    });

    it('stores job_type and payload_json', async () => {
      const id = await repo.enqueue('BACKUP', { retentionDays: 7 });
      const job = await repo.getById(id);
      expect(job).not.toBeNull();
      expect(job!.jobType).toBe('BACKUP');
      expect(JSON.parse(job!.payloadJson)).toEqual({ retentionDays: 7 });
    });

    it('defaults priority to 0, maxAttempts to 3, status to queued', async () => {
      const id = await repo.enqueue('PRUNE', {});
      const job = await repo.getById(id);
      expect(job!.priority).toBe(0);
      expect(job!.maxAttempts).toBe(3);
      expect(job!.status).toBe('queued');
      expect(job!.attempts).toBe(0);
    });

    it('accepts custom priority and maxAttempts', async () => {
      const id = await repo.enqueue('PIPELINE_RUN', {}, { priority: 10, maxAttempts: 5 });
      const job = await repo.getById(id);
      expect(job!.priority).toBe(10);
      expect(job!.maxAttempts).toBe(5);
    });

    it('accepts a scheduled_at in the future', async () => {
      const future = new Date(Date.now() + 86400000).toISOString();
      const id = await repo.enqueue('WATCHLIST_POLL', {}, { scheduledAt: future });
      const job = await repo.getById(id);
      expect(job!.scheduledAt).toBe(future);
    });
  });

  describe('dequeue', () => {
    it('returns the highest-priority queued job', async () => {
      await repo.enqueue('PRUNE', {}, { priority: 0 });
      const highId = await repo.enqueue('PIPELINE_RUN', {}, { priority: 10 });
      const job = await repo.dequeue();
      expect(job).not.toBeNull();
      expect(job!.id).toBe(highId);
      expect(job!.status).toBe('running');
      expect(job!.attempts).toBe(1);
      expect(job!.startedAt).toBeDefined();
    });

    it('returns null when no queued jobs exist', async () => {
      const job = await repo.dequeue();
      expect(job).toBeNull();
    });

    it('does not return already-running jobs', async () => {
      await repo.enqueue('PRUNE', {});
      await repo.dequeue();
      const second = await repo.dequeue();
      expect(second).toBeNull();
    });

    it('does not return future-scheduled jobs', async () => {
      const future = new Date(Date.now() + 86400000).toISOString();
      await repo.enqueue('BACKUP', {}, { scheduledAt: future });
      const job = await repo.dequeue();
      expect(job).toBeNull();
    });

    it('atomically sets started_at and increments attempts', async () => {
      await repo.enqueue('BACKTEST_BUILD', { minSampleSize: 10 });
      const job = await repo.dequeue();
      expect(job!.startedAt).toBeDefined();
      expect(job!.startedAt!.length).toBeGreaterThan(0);
    });
  });

  describe('complete', () => {
    it('marks a running job as completed with a result', async () => {
      const id = await repo.enqueue('BACKUP', { retentionDays: 7 });
      await repo.dequeue();
      await repo.complete(id, { path: '/tmp/backup.db', sizeBytes: 100 });
      const job = await repo.getById(id);
      expect(job!.status).toBe('completed');
      expect(job!.resultJson).toBeDefined();
      expect(JSON.parse(job!.resultJson!)).toEqual({ path: '/tmp/backup.db', sizeBytes: 100 });
      expect(job!.finishedAt).toBeDefined();
    });

    it('is idempotent on already-completed jobs', async () => {
      const id = await repo.enqueue('PRUNE', {});
      await repo.dequeue();
      await repo.complete(id, { deleted: 5 });
      await repo.complete(id, { deleted: 10 });
      const job = await repo.getById(id);
      expect(JSON.parse(job!.resultJson!).deleted).toBe(10);
    });
  });

  describe('fail', () => {
    it('requeues a job when attempts < maxAttempts', async () => {
      const id = await repo.enqueue('PIPELINE_RUN', {}, { maxAttempts: 3 });
      await repo.dequeue();
      await repo.fail(id, 'transient error');
      const job = await repo.getById(id);
      expect(job!.status).toBe('queued');
      expect(job!.error).toBe('transient error');
    });

    it('moves to dead_letter when maxAttempts exceeded', async () => {
      const id = await repo.enqueue('PIPELINE_RUN', {}, { maxAttempts: 1 });
      await repo.dequeue();
      await repo.fail(id, 'permanent error');
      const job = await repo.getById(id);
      expect(job).toBeNull();
      const deadLetters = await repo.getDeadLetter();
      expect(deadLetters).toHaveLength(1);
      expect(deadLetters[0]!.originalJobId).toBe(id);
      expect(deadLetters[0]!.error).toBe('permanent error');
    });

    it('does nothing for an unknown job id', async () => {
      await repo.fail(99999, 'unknown');
    });
  });

  describe('requeueStuck', () => {
    it('requeues running jobs older than maxRunningAgeMs', async () => {
      const id = await repo.enqueue('WATCHLIST_POLL', {});
      await repo.dequeue();
      provider.rawDb
        .prepare("UPDATE job_queue SET started_at = datetime('now', '-10 minutes') WHERE id = ?")
        .run(id);
      const requeued = await repo.requeueStuck(5000);
      expect(requeued).toBe(1);
      const job = await repo.getById(id);
      expect(job!.status).toBe('queued');
      expect(job!.startedAt).toBeUndefined();
    });

    it('does not affect recent running jobs', async () => {
      const id = await repo.enqueue('PRUNE', {});
      await repo.dequeue();
      const requeued = await repo.requeueStuck(300000);
      expect(requeued).toBe(0);
      const job = await repo.getById(id);
      expect(job!.status).toBe('running');
    });

    it('is idempotent — returns 0 when nothing is stuck', async () => {
      const first = await repo.requeueStuck(1000);
      const second = await repo.requeueStuck(1000);
      expect(first).toBe(0);
      expect(second).toBe(0);
    });
  });

  describe('getById', () => {
    it('returns null for a non-existent id', async () => {
      expect(await repo.getById(99999)).toBeNull();
    });

    it('round-trips all fields', async () => {
      const id = await repo.enqueue(
        'BACKTEST_BUILD',
        { minSampleSize: 5 },
        { priority: 3, maxAttempts: 2 },
      );
      const job = await repo.getById(id);
      expect(job!.id).toBe(id);
      expect(job).not.toBeNull();
      expect(job!.jobType).toBe('BACKTEST_BUILD');
      expect(job!.priority).toBe(3);
      expect(job!.maxAttempts).toBe(2);
      expect(job!.status).toBe('queued');
      expect(job!.createdAt).toBeDefined();
      expect(job!.updatedAt).toBeDefined();
    });
  });

  describe('getByIdWithPayload', () => {
    it('returns job with parsed payload', async () => {
      const id = await repo.enqueue('PIPELINE_RUN', { task: 'hello', value: 42 });
      const result = await repo.getByIdWithPayload<{ task: string; value: number }>(id);
      expect(result).not.toBeNull();
      expect(result!.job.id).toBe(id);
      expect(result!.payload).toEqual({ task: 'hello', value: 42 });
    });

    it('returns null for unknown id', async () => {
      expect(await repo.getByIdWithPayload(99999)).toBeNull();
    });
  });

  describe('list', () => {
    it('returns all jobs ordered by priority desc, scheduled_at asc', async () => {
      await repo.enqueue('PRUNE', {}, { priority: 0 });
      await repo.enqueue('PIPELINE_RUN', {}, { priority: 10 });
      const jobs = await repo.list();
      expect(jobs).toHaveLength(2);
      expect(jobs[0]!.jobType).toBe('PIPELINE_RUN');
    });

    it('filters by status', async () => {
      await repo.enqueue('BACKUP', {});
      await repo.enqueue('BACKUP', {});
      const jobs = await repo.list({ status: 'queued' });
      expect(jobs).toHaveLength(2);
      expect(await repo.list({ status: 'running' })).toHaveLength(0);
    });

    it('filters by jobType', async () => {
      await repo.enqueue('BACKUP', {});
      await repo.enqueue('PRUNE', {});
      const jobs = await repo.list({ jobType: 'BACKUP' });
      expect(jobs).toHaveLength(1);
    });

    it('respects limit and offset', async () => {
      for (let i = 0; i < 5; i++) {
        await repo.enqueue('PRUNE', { index: i });
      }
      expect(await repo.list({ limit: 2 })).toHaveLength(2);
      expect(await repo.list({ limit: 10 })).toHaveLength(5);
    });
  });

  describe('getStats', () => {
    it('reports counts per status', async () => {
      const id = await repo.enqueue('BACKUP', {});
      await repo.enqueue('PRUNE', {});
      await repo.dequeue();
      await repo.complete(id, { ok: true });
      const stats = await repo.getStats();
      expect(stats.queued).toBe(1);
      expect(stats.running).toBe(0);
      expect(stats.completed).toBe(1);
      expect(stats.total).toBe(2);
    });

    it('returns zero counts on empty queue', async () => {
      const stats = await repo.getStats();
      expect(stats.total).toBe(0);
      expect(stats.queued).toBe(0);
    });
  });

  describe('dead letter operations', () => {
    it('getDeadLetter returns dead letters in reverse chronological order', async () => {
      const id = await repo.enqueue('PIPELINE_RUN', {}, { maxAttempts: 1 });
      await repo.dequeue();
      await repo.fail(id, 'fail');
      const letters = await repo.getDeadLetter();
      expect(letters).toHaveLength(1);
      expect(letters[0]!.originalJobId).toBe(id);
      expect(letters[0]!.error).toBe('fail');
    });

    it('getDeadLetter respects limit', async () => {
      for (let i = 0; i < 3; i++) {
        const id = await repo.enqueue('PRUNE', {}, { maxAttempts: 1 });
        await repo.dequeue();
        await repo.fail(id, `err${i}`);
      }
      expect(await repo.getDeadLetter({ limit: 2 })).toHaveLength(2);
    });

    it('retryDeadLetter re-enqueues from dead letter and removes it', async () => {
      const id = await repo.enqueue('PRUNE', { data: 1 }, { maxAttempts: 1 });
      await repo.dequeue();
      await repo.fail(id, 'oops');
      const letters = await repo.getDeadLetter();
      const newJobId = await repo.retryDeadLetter(letters[0]!.id);
      expect(newJobId).toBeGreaterThan(0);
      expect(await repo.getDeadLetter()).toHaveLength(0);
      const newJob = await repo.getById(newJobId!);
      expect(newJob).not.toBeNull();
      expect(newJob!.jobType).toBe('PRUNE');
    });

    it('retryDeadLetter returns null for unknown dead letter', async () => {
      expect(await repo.retryDeadLetter(99999)).toBeNull();
    });
  });

  describe('deleteCompleted', () => {
    it('deletes completed jobs older than the specified days', async () => {
      const id = await repo.enqueue('BACKUP', {});
      await repo.dequeue();
      await repo.complete(id, {});
      provider.rawDb
        .prepare("UPDATE job_queue SET finished_at = datetime('now', '-10 days') WHERE id = ?")
        .run(id);
      const deleted = await repo.deleteCompleted(7);
      expect(deleted).toBe(1);
      expect(await repo.getById(id)).toBeNull();
    });

    it('does not delete recent completed jobs', async () => {
      const id = await repo.enqueue('BACKUP', {});
      await repo.dequeue();
      await repo.complete(id, {});
      const deleted = await repo.deleteCompleted(7);
      expect(deleted).toBe(0);
      expect(await repo.getById(id)).not.toBeNull();
    });
  });

  describe('deleteDeadLetter', () => {
    it('deletes old dead letter entries', async () => {
      const id = await repo.enqueue('PRUNE', {}, { maxAttempts: 1 });
      await repo.dequeue();
      await repo.fail(id, 'err');
      provider.rawDb
        .prepare("UPDATE dead_letter_jobs SET failed_at = datetime('now', '-40 days')")
        .run();
      const deleted = await repo.deleteDeadLetter(30);
      expect(deleted).toBe(1);
      expect(await repo.getDeadLetter()).toHaveLength(0);
    });

    it('does not delete recent dead letter entries', async () => {
      const id = await repo.enqueue('PRUNE', {}, { maxAttempts: 1 });
      await repo.dequeue();
      await repo.fail(id, 'err');
      const deleted = await repo.deleteDeadLetter(30);
      expect(deleted).toBe(0);
    });
  });
});
