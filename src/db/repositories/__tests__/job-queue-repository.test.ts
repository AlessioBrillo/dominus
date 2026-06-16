import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../migrator.js';
import { JobQueueRepository } from '../job-queue-repository.js';

function openTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

describe('JobQueueRepository', () => {
  let db: Database.Database;
  let repo: JobQueueRepository;

  beforeEach(() => {
    db = openTestDb();
    repo = new JobQueueRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('enqueue', () => {
    it('inserts a job and returns its id', () => {
      const id = repo.enqueue('PIPELINE_RUN', { task: 'test' });
      expect(id).toBeGreaterThan(0);
    });

    it('stores job_type and payload_json', () => {
      const id = repo.enqueue('BACKUP', { retentionDays: 7 });
      const job = repo.getById(id);
      expect(job).not.toBeNull();
      expect(job!.jobType).toBe('BACKUP');
      expect(JSON.parse(job!.payloadJson)).toEqual({ retentionDays: 7 });
    });

    it('defaults priority to 0, maxAttempts to 3, status to queued', () => {
      const id = repo.enqueue('PRUNE', {});
      const job = repo.getById(id);
      expect(job!.priority).toBe(0);
      expect(job!.maxAttempts).toBe(3);
      expect(job!.status).toBe('queued');
      expect(job!.attempts).toBe(0);
    });

    it('accepts custom priority and maxAttempts', () => {
      const id = repo.enqueue('PIPELINE_RUN', {}, { priority: 10, maxAttempts: 5 });
      const job = repo.getById(id);
      expect(job!.priority).toBe(10);
      expect(job!.maxAttempts).toBe(5);
    });

    it('accepts a scheduled_at in the future', () => {
      const future = new Date(Date.now() + 86400000).toISOString();
      const id = repo.enqueue('WATCHLIST_POLL', {}, { scheduledAt: future });
      const job = repo.getById(id);
      expect(job!.scheduledAt).toBe(future);
    });
  });

  describe('dequeue', () => {
    it('returns the highest-priority queued job', () => {
      repo.enqueue('PRUNE', {}, { priority: 0 });
      const highId = repo.enqueue('PIPELINE_RUN', {}, { priority: 10 });
      const job = repo.dequeue();
      expect(job).not.toBeNull();
      expect(job!.id).toBe(highId);
      expect(job!.status).toBe('running');
      expect(job!.attempts).toBe(1);
      expect(job!.startedAt).toBeDefined();
    });

    it('returns null when no queued jobs exist', () => {
      const job = repo.dequeue();
      expect(job).toBeNull();
    });

    it('does not return already-running jobs', () => {
      repo.enqueue('PRUNE', {});
      repo.dequeue();
      const second = repo.dequeue();
      expect(second).toBeNull();
    });

    it('does not return future-scheduled jobs', () => {
      const future = new Date(Date.now() + 86400000).toISOString();
      repo.enqueue('BACKUP', {}, { scheduledAt: future });
      const job = repo.dequeue();
      expect(job).toBeNull();
    });

    it('atomically sets started_at and increments attempts', () => {
      repo.enqueue('BACKTEST_BUILD', { minSampleSize: 10 });
      const job = repo.dequeue();
      expect(job!.startedAt).toBeDefined();
      expect(job!.startedAt!.length).toBeGreaterThan(0);
    });
  });

  describe('complete', () => {
    it('marks a running job as completed with a result', () => {
      const id = repo.enqueue('BACKUP', { retentionDays: 7 });
      repo.dequeue();
      repo.complete(id, { path: '/tmp/backup.db', sizeBytes: 100 });
      const job = repo.getById(id);
      expect(job!.status).toBe('completed');
      expect(job!.resultJson).toBeDefined();
      expect(JSON.parse(job!.resultJson!)).toEqual({ path: '/tmp/backup.db', sizeBytes: 100 });
      expect(job!.finishedAt).toBeDefined();
    });

    it('is idempotent on already-completed jobs', () => {
      const id = repo.enqueue('PRUNE', {});
      repo.dequeue();
      repo.complete(id, { deleted: 5 });
      repo.complete(id, { deleted: 10 });
      const job = repo.getById(id);
      expect(JSON.parse(job!.resultJson!).deleted).toBe(10);
    });
  });

  describe('fail', () => {
    it('requeues a job when attempts < maxAttempts', () => {
      const id = repo.enqueue('PIPELINE_RUN', {}, { maxAttempts: 3 });
      repo.dequeue();
      repo.fail(id, 'transient error');
      const job = repo.getById(id);
      expect(job!.status).toBe('queued');
      expect(job!.error).toBe('transient error');
    });

    it('moves to dead_letter when maxAttempts exceeded', () => {
      const id = repo.enqueue('PIPELINE_RUN', {}, { maxAttempts: 1 });
      repo.dequeue();
      repo.fail(id, 'permanent error');
      const job = repo.getById(id);
      expect(job).toBeNull();
      const deadLetters = repo.getDeadLetter();
      expect(deadLetters).toHaveLength(1);
      expect(deadLetters[0]!.originalJobId).toBe(id);
      expect(deadLetters[0]!.error).toBe('permanent error');
    });

    it('does nothing for an unknown job id', () => {
      expect(() => repo.fail(99999, 'unknown')).not.toThrow();
    });
  });

  describe('requeueStuck', () => {
    it('requeues running jobs older than maxRunningAgeMs', () => {
      const id = repo.enqueue('WATCHLIST_POLL', {});
      repo.dequeue();
      db.prepare(
        "UPDATE job_queue SET started_at = datetime('now', '-10 minutes') WHERE id = ?",
      ).run(id);
      const requeued = repo.requeueStuck(5000);
      expect(requeued).toBe(1);
      const job = repo.getById(id);
      expect(job!.status).toBe('queued');
      expect(job!.startedAt).toBeUndefined();
    });

    it('does not affect recent running jobs', () => {
      const id = repo.enqueue('PRUNE', {});
      repo.dequeue();
      const requeued = repo.requeueStuck(300000);
      expect(requeued).toBe(0);
      const job = repo.getById(id);
      expect(job!.status).toBe('running');
    });

    it('is idempotent — returns 0 when nothing is stuck', () => {
      const first = repo.requeueStuck(1000);
      const second = repo.requeueStuck(1000);
      expect(first).toBe(0);
      expect(second).toBe(0);
    });
  });

  describe('getById', () => {
    it('returns null for a non-existent id', () => {
      expect(repo.getById(99999)).toBeNull();
    });

    it('round-trips all fields', () => {
      const id = repo.enqueue(
        'BACKTEST_BUILD',
        { minSampleSize: 5 },
        { priority: 3, maxAttempts: 2 },
      );
      const job = repo.getById(id);
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
    it('returns job with parsed payload', () => {
      const id = repo.enqueue('PIPELINE_RUN', { task: 'hello', value: 42 });
      const result = repo.getByIdWithPayload<{ task: string; value: number }>(id);
      expect(result).not.toBeNull();
      expect(result!.job.id).toBe(id);
      expect(result!.payload).toEqual({ task: 'hello', value: 42 });
    });

    it('returns null for unknown id', () => {
      expect(repo.getByIdWithPayload(99999)).toBeNull();
    });
  });

  describe('list', () => {
    it('returns all jobs ordered by priority desc, scheduled_at asc', () => {
      repo.enqueue('PRUNE', {}, { priority: 0 });
      repo.enqueue('PIPELINE_RUN', {}, { priority: 10 });
      const jobs = repo.list();
      expect(jobs).toHaveLength(2);
      expect(jobs[0]!.jobType).toBe('PIPELINE_RUN');
    });

    it('filters by status', () => {
      repo.enqueue('BACKUP', {});
      repo.enqueue('BACKUP', {});
      const jobs = repo.list({ status: 'queued' });
      expect(jobs).toHaveLength(2);
      expect(repo.list({ status: 'running' })).toHaveLength(0);
    });

    it('filters by jobType', () => {
      repo.enqueue('BACKUP', {});
      repo.enqueue('PRUNE', {});
      const jobs = repo.list({ jobType: 'BACKUP' });
      expect(jobs).toHaveLength(1);
    });

    it('respects limit and offset', () => {
      for (let i = 0; i < 5; i++) {
        repo.enqueue('PRUNE', { index: i });
      }
      expect(repo.list({ limit: 2 })).toHaveLength(2);
      expect(repo.list({ limit: 10 })).toHaveLength(5);
    });
  });

  describe('getStats', () => {
    it('reports counts per status', () => {
      const id = repo.enqueue('BACKUP', {});
      repo.enqueue('PRUNE', {});
      repo.dequeue();
      repo.complete(id, { ok: true });
      const stats = repo.getStats();
      expect(stats.queued).toBe(1);
      expect(stats.running).toBe(0);
      expect(stats.completed).toBe(1);
      expect(stats.total).toBe(2);
    });

    it('returns zero counts on empty queue', () => {
      const stats = repo.getStats();
      expect(stats.total).toBe(0);
      expect(stats.queued).toBe(0);
    });
  });

  describe('dead letter operations', () => {
    it('getDeadLetter returns dead letters in reverse chronological order', () => {
      const id = repo.enqueue('PIPELINE_RUN', {}, { maxAttempts: 1 });
      repo.dequeue();
      repo.fail(id, 'fail');
      const letters = repo.getDeadLetter();
      expect(letters).toHaveLength(1);
      expect(letters[0]!.originalJobId).toBe(id);
      expect(letters[0]!.error).toBe('fail');
    });

    it('getDeadLetter respects limit', () => {
      for (let i = 0; i < 3; i++) {
        const id = repo.enqueue('PRUNE', {}, { maxAttempts: 1 });
        repo.dequeue();
        repo.fail(id, `err${i}`);
      }
      expect(repo.getDeadLetter({ limit: 2 })).toHaveLength(2);
    });

    it('retryDeadLetter re-enqueues from dead letter and removes it', () => {
      const id = repo.enqueue('PRUNE', { data: 1 }, { maxAttempts: 1 });
      repo.dequeue();
      repo.fail(id, 'oops');
      const letters = repo.getDeadLetter();
      const newJobId = repo.retryDeadLetter(letters[0]!.id);
      expect(newJobId).toBeGreaterThan(0);
      expect(repo.getDeadLetter()).toHaveLength(0);
      const newJob = repo.getById(newJobId!);
      expect(newJob).not.toBeNull();
      expect(newJob!.jobType).toBe('PRUNE');
    });

    it('retryDeadLetter returns null for unknown dead letter', () => {
      expect(repo.retryDeadLetter(99999)).toBeNull();
    });
  });

  describe('deleteCompleted', () => {
    it('deletes completed jobs older than the specified days', () => {
      const id = repo.enqueue('BACKUP', {});
      repo.dequeue();
      repo.complete(id, {});
      db.prepare("UPDATE job_queue SET finished_at = datetime('now', '-10 days') WHERE id = ?").run(
        id,
      );
      const deleted = repo.deleteCompleted(7);
      expect(deleted).toBe(1);
      expect(repo.getById(id)).toBeNull();
    });

    it('does not delete recent completed jobs', () => {
      const id = repo.enqueue('BACKUP', {});
      repo.dequeue();
      repo.complete(id, {});
      const deleted = repo.deleteCompleted(7);
      expect(deleted).toBe(0);
      expect(repo.getById(id)).not.toBeNull();
    });
  });

  describe('deleteDeadLetter', () => {
    it('deletes old dead letter entries', () => {
      const id = repo.enqueue('PRUNE', {}, { maxAttempts: 1 });
      repo.dequeue();
      repo.fail(id, 'err');
      db.prepare("UPDATE dead_letter_jobs SET failed_at = datetime('now', '-40 days')").run();
      const deleted = repo.deleteDeadLetter(30);
      expect(deleted).toBe(1);
      expect(repo.getDeadLetter()).toHaveLength(0);
    });

    it('does not delete recent dead letter entries', () => {
      const id = repo.enqueue('PRUNE', {}, { maxAttempts: 1 });
      repo.dequeue();
      repo.fail(id, 'err');
      const deleted = repo.deleteDeadLetter(30);
      expect(deleted).toBe(0);
    });
  });
});
