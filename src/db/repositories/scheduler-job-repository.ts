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

  async upsert(input: {
    jobName: string;
    cronExpression: string;
    description: string;
  }): Promise<SchedulerJobRow> {
    await this.db.exec(
      `INSERT INTO scheduler_jobs (job_name, cron_expression, description)
       VALUES (?, ?, ?)
       ON CONFLICT(job_name) DO UPDATE SET
         cron_expression = excluded.cron_expression,
         description = excluded.description,
          updated_at = CURRENT_TIMESTAMP`,
      [input.jobName, input.cronExpression, input.description],
    );
    return (await this.findByJobName(input.jobName))!;
  }

  async updateResult(
    jobName: string,
    result: { lastRunAt: string; lastResult: string; durationMs: number; isError: boolean },
  ): Promise<void> {
    await this.db.exec(
      `UPDATE scheduler_jobs SET
         last_run_at = ?,
         last_result = ?,
         last_duration_ms = ?,
         consecutive_failures = CASE WHEN ? THEN consecutive_failures + 1 ELSE 0 END,
         updated_at = CURRENT_TIMESTAMP
        WHERE job_name = ?`,
      [result.lastRunAt, result.lastResult, result.durationMs, result.isError ? 1 : 0, jobName],
    );
  }

  async findByJobName(jobName: string): Promise<SchedulerJobRow | null> {
    const row = await this.db.queryOne<SchedulerDbRow>(
      'SELECT * FROM scheduler_jobs WHERE job_name = ?',
      [jobName],
    );
    return row ? rowToJob(row) : null;
  }

  async findAll(): Promise<SchedulerJobRow[]> {
    return (
      await this.db.query<SchedulerDbRow>('SELECT * FROM scheduler_jobs ORDER BY job_name')
    ).map(rowToJob);
  }

  async prune(maxAgeDays: number = 90): Promise<number> {
    const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000)
      .toISOString()
      .replace('T', ' ')
      .replace(/\.\d{3}Z$/, '');
    const result = await this.db.exec('DELETE FROM scheduler_jobs WHERE updated_at < ?', [cutoff]);
    return result.changes;
  }
}
