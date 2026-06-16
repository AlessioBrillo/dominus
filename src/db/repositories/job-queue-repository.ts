/* eslint-disable @typescript-eslint/no-explicit-any */
import type Database from 'better-sqlite3';
import type { JobQueueRow, JobQueueStats, DeadLetterJobRow } from '../../types/job-queue.js';

export class JobQueueRepository {
  #db: Database.Database;

  constructor(db: Database.Database) {
    this.#db = db;
  }

  #rowToJob(row: any): JobQueueRow {
    return {
      id: row.id,
      jobType: row.job_type,
      payloadJson: row.payload_json,
      status: row.status,
      priority: row.priority,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      scheduledAt: row.scheduled_at,
      startedAt: row.started_at ?? undefined,
      finishedAt: row.finished_at ?? undefined,
      error: row.error ?? undefined,
      resultJson: row.result_json ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  #rowToDeadLetter(row: any): DeadLetterJobRow {
    return {
      id: row.id,
      originalJobId: row.original_job_id,
      jobType: row.job_type,
      payloadJson: row.payload_json,
      error: row.error,
      attempts: row.attempts,
      failedAt: row.failed_at,
      originalCreatedAt: row.original_created_at,
    };
  }

  enqueue(
    jobType: string,
    payload: object,
    options: { priority?: number; maxAttempts?: number; scheduledAt?: string } = {},
  ): number {
    const stmt = this.#db.prepare(`
      INSERT INTO job_queue (job_type, payload_json, priority, max_attempts, scheduled_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      jobType,
      JSON.stringify(payload),
      options.priority ?? 0,
      options.maxAttempts ?? 3,
      options.scheduledAt ?? new Date().toISOString(),
    );
    return result.lastInsertRowid as number;
  }

  dequeue(): JobQueueRow | null {
    const stmt = this.#db.prepare(`
      UPDATE job_queue
      SET status = 'running',
          attempts = attempts + 1,
          started_at = datetime('now'),
          updated_at = datetime('now')
      WHERE id = (
        SELECT id FROM job_queue
        WHERE status = 'queued'
          AND scheduled_at <= datetime('now')
        ORDER BY priority DESC, scheduled_at ASC
        LIMIT 1
      )
      RETURNING *
    `);
    const row = stmt.get() as any;
    return row ? this.#rowToJob(row) : null;
  }

  complete(jobId: number, result: object): void {
    const stmt = this.#db.prepare(`
      UPDATE job_queue
      SET status = 'completed',
          finished_at = datetime('now'),
          result_json = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `);
    stmt.run(JSON.stringify(result), jobId);
  }

  fail(jobId: number, error: string): void {
    const job = this.getById(jobId);
    if (!job) return;

    const nextAttempt = job.attempts + 1;
    const isDeadLetter = nextAttempt > job.maxAttempts;

    if (isDeadLetter) {
      this.moveToDeadLetter(jobId, error, nextAttempt);
      return;
    }

    const stmt = this.#db.prepare(`
      UPDATE job_queue
      SET status = 'queued',
          error = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `);
    stmt.run(error, jobId);
  }

  private moveToDeadLetter(jobId: number, error: string, attempts: number): void {
    const job = this.getById(jobId);
    if (!job) return;

    const tx = this.#db.transaction(() => {
      const insert = this.#db.prepare(`
        INSERT INTO dead_letter_jobs (original_job_id, job_type, payload_json, error, attempts, original_created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      insert.run(job.id, job.jobType, job.payloadJson, error, attempts, job.createdAt);

      const del = this.#db.prepare('DELETE FROM job_queue WHERE id = ?');
      del.run(jobId);
    });
    tx();
  }

  requeueStuck(maxRunningAgeMs: number = 300000): number {
    const stmt = this.#db.prepare(`
      UPDATE job_queue
      SET status = 'queued',
          started_at = NULL,
          updated_at = datetime('now')
      WHERE status = 'running'
        AND started_at IS NOT NULL
        AND (strftime('%s', 'now') - strftime('%s', started_at)) * 1000 > ?
    `);
    const result = stmt.run(maxRunningAgeMs);
    return result.changes;
  }

  getById(id: number): JobQueueRow | null {
    const stmt = this.#db.prepare('SELECT * FROM job_queue WHERE id = ?');
    const row = stmt.get(id) as any;
    return row ? this.#rowToJob(row) : null;
  }

  getByIdWithPayload<T>(id: number): { job: JobQueueRow; payload: T } | null {
    const job = this.getById(id);
    if (!job) return null;
    return { job, payload: JSON.parse(job.payloadJson) as T };
  }

  list(
    options: {
      status?: string;
      jobType?: string;
      limit?: number;
      offset?: number;
    } = {},
  ): JobQueueRow[] {
    const conditions: string[] = [];
    const params: any[] = [];

    if (options.status) {
      conditions.push('status = ?');
      params.push(options.status);
    }
    if (options.jobType) {
      conditions.push('job_type = ?');
      params.push(options.jobType);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;

    const stmt = this.#db.prepare(`
      SELECT * FROM job_queue
      ${where}
      ORDER BY priority DESC, scheduled_at ASC
      LIMIT ? OFFSET ?
    `);
    params.push(limit, offset);
    return stmt.all(...params).map((r: any) => this.#rowToJob(r));
  }

  getStats(): JobQueueStats {
    const stmt = this.#db.prepare(`
      SELECT
        status,
        COUNT(*) as count
      FROM job_queue
      GROUP BY status
    `);
    const rows = stmt.all() as { status: string; count: number }[];

    const stats: JobQueueStats = {
      queued: 0,
      running: 0,
      completed: 0,
      failed: 0,
      deadLetter: 0,
      total: 0,
    };

    for (const row of rows) {
      stats[row.status as keyof JobQueueStats] = row.count;
      stats.total += row.count;
    }

    return stats;
  }

  getDeadLetter(options: { limit?: number; offset?: number } = {}): DeadLetterJobRow[] {
    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;
    const stmt = this.#db.prepare(`
      SELECT * FROM dead_letter_jobs
      ORDER BY failed_at DESC
      LIMIT ? OFFSET ?
    `);
    return stmt.all(limit, offset).map((r: any) => this.#rowToDeadLetter(r));
  }

  retryDeadLetter(deadLetterId: number): number | null {
    const dl = this.#db
      .prepare('SELECT * FROM dead_letter_jobs WHERE id = ?')
      .get(deadLetterId) as any;
    if (!dl) return null;

    const jobId = this.enqueue(dl.job_type, JSON.parse(dl.payload_json), {
      priority: 10,
      maxAttempts: 3,
    });

    this.#db.prepare('DELETE FROM dead_letter_jobs WHERE id = ?').run(deadLetterId);
    return jobId;
  }

  deleteCompleted(olderThanDays: number = 7): number {
    const stmt = this.#db.prepare(`
      DELETE FROM job_queue
      WHERE status = 'completed'
        AND finished_at < datetime('now', ?)
    `);
    const result = stmt.run(`-${olderThanDays} days`);
    return result.changes;
  }

  deleteDeadLetter(olderThanDays: number = 30): number {
    const stmt = this.#db.prepare(`
      DELETE FROM dead_letter_jobs
      WHERE failed_at < datetime('now', ?)
    `);
    const result = stmt.run(`-${olderThanDays} days`);
    return result.changes;
  }
}
