import type { DatabaseProvider } from '../provider/interface.js';

export interface SchedulerJobRow {
  jobName: string;
  cronExpression: string;
  description: string;
  enabled: boolean;
  lastRunAt: string | null;
  lastResult: string | null;
  lastDurationMs: number | null;
  consecutiveFailures: number;
}

interface SchedulerDbRow {
  job_name: string;
  cron_expression: string;
  description: string;
  enabled: number;
  last_run_at: string | null;
  last_result: string | null;
  last_duration_ms: number | null;
  consecutive_failures: number;
}

function rowToJob(row: SchedulerDbRow): SchedulerJobRow {
  return {
    jobName: row.job_name,
    cronExpression: row.cron_expression,
    description: row.description,
    enabled: row.enabled === 1,
    lastRunAt: row.last_run_at,
    lastResult: row.last_result,
    lastDurationMs: row.last_duration_ms,
    consecutiveFailures: row.consecutive_failures,
  };
}

export class SchedulerJobRepository {
  constructor(private readonly db: DatabaseProvider) {}

  upsert(input: { jobName: string; cronExpression: string; description: string }): SchedulerJobRow {
    this.db.exec(
      `INSERT INTO scheduler_jobs (job_name, cron_expression, description)
       VALUES (?, ?, ?)
       ON CONFLICT(job_name) DO UPDATE SET
         cron_expression = excluded.cron_expression,
         description = excluded.description,
         updated_at = datetime('now')`,
      [input.jobName, input.cronExpression, input.description],
    );
    return this.findByJobName(input.jobName)!;
  }

  updateResult(
    jobName: string,
    result: { lastRunAt: string; lastResult: string; durationMs: number; isError: boolean },
  ): void {
    this.db.exec(
      `UPDATE scheduler_jobs SET
         last_run_at = ?,
         last_result = ?,
         last_duration_ms = ?,
         consecutive_failures = CASE WHEN ? THEN consecutive_failures + 1 ELSE 0 END,
         updated_at = datetime('now')
       WHERE job_name = ?`,
      [result.lastRunAt, result.lastResult, result.durationMs, result.isError ? 1 : 0, jobName],
    );
  }

  findByJobName(jobName: string): SchedulerJobRow | null {
    const row = this.db.queryOne<SchedulerDbRow>(
      'SELECT * FROM scheduler_jobs WHERE job_name = ?',
      [jobName],
    );
    return row ? rowToJob(row) : null;
  }

  findAll(): SchedulerJobRow[] {
    return this.db
      .query<SchedulerDbRow>('SELECT * FROM scheduler_jobs ORDER BY job_name')
      .map(rowToJob);
  }

  prune(maxAgeDays: number = 90): number {
    const result = this.db.exec(
      "DELETE FROM scheduler_jobs WHERE updated_at < datetime('now', ?)",
      [`-${maxAgeDays} days`],
    );
    return result.changes;
  }
}
