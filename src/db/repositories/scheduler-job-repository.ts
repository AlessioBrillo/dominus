import type Database from 'better-sqlite3';

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
  constructor(private readonly db: Database.Database) {}

  upsert(input: { jobName: string; cronExpression: string; description: string }): SchedulerJobRow {
    this.db
      .prepare(
        `INSERT INTO scheduler_jobs (job_name, cron_expression, description)
         VALUES (?, ?, ?)
         ON CONFLICT(job_name) DO UPDATE SET
           cron_expression = excluded.cron_expression,
           description = excluded.description,
           updated_at = datetime('now')`,
      )
      .run(input.jobName, input.cronExpression, input.description);
    return this.findByJobName(input.jobName)!;
  }

  updateResult(
    jobName: string,
    result: { lastRunAt: string; lastResult: string; durationMs: number; isError: boolean },
  ): void {
    this.db
      .prepare(
        `UPDATE scheduler_jobs SET
           last_run_at = ?,
           last_result = ?,
           last_duration_ms = ?,
           consecutive_failures = CASE WHEN ? THEN consecutive_failures + 1 ELSE 0 END,
           updated_at = datetime('now')
         WHERE job_name = ?`,
      )
      .run(result.lastRunAt, result.lastResult, result.durationMs, result.isError ? 1 : 0, jobName);
  }

  findByJobName(jobName: string): SchedulerJobRow | null {
    const row = this.db.prepare('SELECT * FROM scheduler_jobs WHERE job_name = ?').get(jobName) as
      | SchedulerDbRow
      | undefined;
    return row ? rowToJob(row) : null;
  }

  findAll(): SchedulerJobRow[] {
    return (
      this.db.prepare('SELECT * FROM scheduler_jobs ORDER BY job_name').all() as SchedulerDbRow[]
    ).map(rowToJob);
  }

  prune(maxAgeDays: number = 90): number {
    const result = this.db
      .prepare("DELETE FROM scheduler_jobs WHERE updated_at < datetime('now', ?)")
      .run(`-${maxAgeDays} days`);
    return result.changes;
  }
}
