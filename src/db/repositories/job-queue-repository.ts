// SPDX-License-Identifier: AGPL-3.0-only
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
      lockedBy: row.locked_by ?? undefined,
      heartbeatAt: row.heartbeat_at ?? undefined,
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

  /**
   * Atomically enqueue a job only if the queue depth is below the given limit.
   * Prevents TOCTOU races between depth check and insert in concurrent scenarios
   * (multiple workers or API servers sharing the same queue).
   *
   * Returns the new job id on success, or throws an error if the queue is full.
   */
  async enqueueWithDepthCheck(
    jobType: string,
    payload: object,
    maxDepth: number,
    options: { priority?: number; maxAttempts?: number; scheduledAt?: string } = {},
  ): Promise<number> {
    const row = await this.#db.queryOne<{ id: number }>(
      `INSERT INTO job_queue (job_type, payload_json, priority, max_attempts, scheduled_at)
       SELECT ?, ?, ?, ?, ?
       WHERE (SELECT COUNT(*) FROM job_queue WHERE status IN ('queued', 'running')) < ?
       RETURNING id`,
      [
        jobType,
        JSON.stringify(payload),
        options.priority ?? 0,
        options.maxAttempts ?? 3,
        options.scheduledAt ?? this.#ts(),
        maxDepth,
      ],
    );
    if (!row) {
      throw new Error(
        `Job queue depth limit reached (${maxDepth}) — rejecting enqueue of ${jobType}. ` +
          'Increase JOB_QUEUE_MAX_DEPTH or wait for the worker to drain pending jobs.',
      );
    }
    return row.id;
  }

  /**
   * Claim the next eligible job for this worker.
   *
   * On Postgres, multiple workers race against the same table across
   * separate connections, so the candidate-selection subquery uses
   * FOR UPDATE SKIP LOCKED: it row-locks the candidate and lets any other
   * worker's concurrent SELECT skip past it instead of blocking or
   * double-claiming it. SQLite has a single writer (better-sqlite3 is
   * synchronous), so the plain SELECT is already atomic there and
   * FOR UPDATE SKIP LOCKED is not valid SQLite syntax.
   */
  async dequeue(workerId = 'unknown'): Promise<JobQueueRow | null> {
    const selectClause =
      this.#db.dialect === 'postgres'
        ? `SELECT id FROM job_queue
           WHERE status = 'queued'
             AND scheduled_at <= CURRENT_TIMESTAMP
           ORDER BY priority DESC, scheduled_at ASC
           LIMIT 1
           FOR UPDATE SKIP LOCKED`
        : `SELECT id FROM job_queue
           WHERE status = 'queued'
             AND scheduled_at <= CURRENT_TIMESTAMP
           ORDER BY priority DESC, scheduled_at ASC
           LIMIT 1`;

    const row = await this.#db.queryOne<any>(
      `UPDATE job_queue
       SET status = 'running',
           attempts = attempts + 1,
           started_at = CURRENT_TIMESTAMP,
           heartbeat_at = CURRENT_TIMESTAMP,
           locked_by = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = (${selectClause})
       RETURNING *`,
      [workerId],
    );
    return row ? this.#rowToJob(row) : null;
  }

  /**
   * Heartbeat for jobs this worker still owns. Scoped by locked_by so a
   * job reaped and re-claimed by another worker never gets its heartbeat
   * clobbered by the original (now-stale) owner.
   */
  async heartbeat(jobIds: number[], workerId: string): Promise<void> {
    if (jobIds.length === 0) return;
    const placeholders = jobIds.map(() => '?').join(', ');
    await this.#db.exec(
      `UPDATE job_queue
       SET heartbeat_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE id IN (${placeholders})
         AND locked_by = ?
         AND status = 'running'`,
      [...jobIds, workerId],
    );
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

  async fail(jobId: number, error: string): Promise<boolean> {
    const job = await this.getById(jobId);
    if (!job) return false;

    const nextAttempt = job.attempts + 1;
    const isDeadLetter = nextAttempt > job.maxAttempts;

    if (isDeadLetter) {
      await this.moveToDeadLetter(jobId, error, nextAttempt);
      return true;
    }

    await this.#db.exec(
      `UPDATE job_queue
       SET status = 'queued',
           error = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [error, jobId],
    );
    return false;
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

  /**
   * Reap jobs whose owning worker has gone silent, instead of any job that
   * has merely run long. A job with a fresh heartbeat is left alone no
   * matter its age; a job whose heartbeat has gone stale (or predates the
   * heartbeat column, for rows claimed before this migration) is requeued.
   * Without this distinction, any job slower than maxRunningAgeMs — not
   * just ones from a dead worker — gets requeued and can run twice
   * alongside its still-live original execution.
   */
  async requeueStuck(maxRunningAgeMs: number = 300000): Promise<number> {
    const cutoff = this.#ts(new Date(Date.now() - maxRunningAgeMs));
    const result = await this.#db.exec(
      `UPDATE job_queue
       SET status = 'queued',
           started_at = NULL,
           locked_by = NULL,
           heartbeat_at = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE status = 'running'
         AND (
           (heartbeat_at IS NOT NULL AND heartbeat_at <= ?)
           OR (heartbeat_at IS NULL AND started_at IS NOT NULL AND started_at <= ?)
         )`,
      [cutoff, cutoff],
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

  /** Total rows in the dead-letter table (job_queue status counts do not
   *  include dead letters — they live in a separate table). */
  async countDeadLetter(): Promise<number> {
    const rows = await this.#db.query<{ count: number }>(
      'SELECT COUNT(*) as count FROM dead_letter_jobs',
    );
    return rows[0]?.count ?? 0;
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
