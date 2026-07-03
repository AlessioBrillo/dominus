/* eslint-disable @typescript-eslint/no-explicit-any */
import type { DatabaseProvider } from '../provider/interface.js';
import type { JobQueueRow, JobQueueStats, DeadLetterJobRow } from '../../types/job-queue.js';

export class JobQueueRepository {
  #db: DatabaseProvider;

  constructor(db: DatabaseProvider) {
    this.#db = db;
  }

  #ts(date: Date = new Date()): string {
    return date
      .toISOString()
      .replace('T', ' ')
      .replace(/\.\d{3}Z$/, '');
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

  async enqueue(
    jobType: string,
    payload: object,
    options: { priority?: number; maxAttempts?: number; scheduledAt?: string } = {},
  ): Promise<number> {
    const result = await this.#db.exec(
      `INSERT INTO job_queue (job_type, payload_json, priority, max_attempts, scheduled_at)
       VALUES (?, ?, ?, ?, ?)`,
      [
        jobType,
        JSON.stringify(payload),
        options.priority ?? 0,
        options.maxAttempts ?? 3,
        options.scheduledAt ?? this.#ts(),
      ],
    );
    return result.lastInsertRowid as number;
  }

  async dequeue(): Promise<JobQueueRow | null> {
    const row = await this.#db.queryOne<any>(
      `UPDATE job_queue
       SET status = 'running',
           attempts = attempts + 1,
           started_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = (
         SELECT id FROM job_queue
         WHERE status = 'queued'
           AND scheduled_at <= CURRENT_TIMESTAMP
         ORDER BY priority DESC, scheduled_at ASC
         LIMIT 1
       )
       RETURNING *`,
    );
    return row ? this.#rowToJob(row) : null;
  }

  async complete(jobId: number, result: object): Promise<void> {
    await this.#db.exec(
      `UPDATE job_queue
       SET status = 'completed',
           finished_at = CURRENT_TIMESTAMP,
           result_json = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [JSON.stringify(result), jobId],
    );
  }

  async fail(jobId: number, error: string): Promise<void> {
    const job = await this.getById(jobId);
    if (!job) return;

    const nextAttempt = job.attempts + 1;
    const isDeadLetter = nextAttempt > job.maxAttempts;

    if (isDeadLetter) {
      await this.moveToDeadLetter(jobId, error, nextAttempt);
      return;
    }

    await this.#db.exec(
      `UPDATE job_queue
       SET status = 'queued',
           error = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [error, jobId],
    );
  }

  private async moveToDeadLetter(jobId: number, error: string, attempts: number): Promise<void> {
    const job = await this.getById(jobId);
    if (!job) return;

    await this.#db.transaction(async () => {
      await this.#db.exec(
        `INSERT INTO dead_letter_jobs (original_job_id, job_type, payload_json, error, attempts, original_created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [job.id, job.jobType, job.payloadJson, error, attempts, job.createdAt],
      );

      await this.#db.exec('DELETE FROM job_queue WHERE id = ?', [jobId]);
    });
  }

  async requeueStuck(maxRunningAgeMs: number = 300000): Promise<number> {
    const cutoff = this.#ts(new Date(Date.now() - maxRunningAgeMs));
    const result = await this.#db.exec(
      `UPDATE job_queue
       SET status = 'queued',
           started_at = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE status = 'running'
         AND started_at IS NOT NULL
         AND started_at <= ?`,
      [cutoff],
    );
    return result.changes;
  }

  async getById(id: number): Promise<JobQueueRow | null> {
    const row = await this.#db.queryOne<any>('SELECT * FROM job_queue WHERE id = ?', [id]);
    return row ? this.#rowToJob(row) : null;
  }

  async getByIdWithPayload<T>(id: number): Promise<{ job: JobQueueRow; payload: T } | null> {
    const job = await this.getById(id);
    if (!job) return null;
    return { job, payload: JSON.parse(job.payloadJson) as T };
  }

  async list(
    options: {
      status?: string;
      jobType?: string;
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<JobQueueRow[]> {
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

    params.push(limit, offset);
    const rows = await this.#db.query<any>(
      `SELECT * FROM job_queue
       ${where}
       ORDER BY priority DESC, scheduled_at ASC
       LIMIT ? OFFSET ?`,
      params,
    );
    return rows.map((r) => this.#rowToJob(r));
  }

  async getStats(): Promise<JobQueueStats> {
    const rows = await this.#db.query<{ status: string; count: number }>(
      `SELECT
         status,
         COUNT(*) as count
       FROM job_queue
       GROUP BY status`,
    );

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

  async getDeadLetter(
    options: { limit?: number; offset?: number } = {},
  ): Promise<DeadLetterJobRow[]> {
    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;
    const rows = await this.#db.query<any>(
      `SELECT * FROM dead_letter_jobs
       ORDER BY failed_at DESC
       LIMIT ? OFFSET ?`,
      [limit, offset],
    );
    return rows.map((r) => this.#rowToDeadLetter(r));
  }

  async retryDeadLetter(deadLetterId: number): Promise<number | null> {
    const dl = await this.#db.queryOne<any>('SELECT * FROM dead_letter_jobs WHERE id = ?', [
      deadLetterId,
    ]);
    if (!dl) return null;

    const jobId = await this.enqueue(dl.job_type, JSON.parse(dl.payload_json), {
      priority: 10,
      maxAttempts: 3,
    });

    await this.#db.exec('DELETE FROM dead_letter_jobs WHERE id = ?', [deadLetterId]);
    return jobId;
  }

  async deleteCompleted(olderThanDays: number = 7): Promise<number> {
    const cutoff = this.#ts(new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000));
    const result = await this.#db.exec(
      `DELETE FROM job_queue
       WHERE status = 'completed'
         AND finished_at < ?`,
      [cutoff],
    );
    return result.changes;
  }

  async deleteDeadLetter(olderThanDays: number = 30): Promise<number> {
    const cutoff = this.#ts(new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000));
    const result = await this.#db.exec(
      `DELETE FROM dead_letter_jobs
       WHERE failed_at < ?`,
      [cutoff],
    );
    return result.changes;
  }
}
