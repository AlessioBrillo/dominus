import type { DatabaseProvider } from '../provider/interface.js';

export interface StageMetricRow {
  pipelineRunId?: string;
  stageName: string;
  passed: number;
  filtered: number;
  durationMs: number;
  error: boolean;
  retries?: number;
  errorCodes?: string[];
}

interface MetricRecord {
  id: number;
  pipeline_run_id: string;
  stage_name: string;
  passed: number;
  filtered: number;
  duration_ms: number;
  error: number;
  retries: number;
  error_codes: string;
  recorded_at: string;
}

export interface MetricAggregate {
  stageName: string;
  totalDurationMs: number;
  totalPassed: number;
  totalFiltered: number;
  runCount: number;
  errorCount: number;
  avgDurationMs: number;
  p50DurationMs: number;
  p95DurationMs: number;
}

export interface MetricsHistory {
  runId: string;
  startedAt: string;
  stages: StageMetricRow[];
}

export class MetricsRepository {
  constructor(private readonly db: DatabaseProvider) {}

  async insertBatch(runId: string, stages: StageMetricRow[]): Promise<number> {
    if (stages.length === 0) return 0;
    await this.db.transaction(async () => {
      for (const row of stages) {
        await this.db.exec(
          `INSERT OR REPLACE INTO pipeline_metrics
            (pipeline_run_id, stage_name, passed, filtered, duration_ms, error, retries, error_codes)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            runId,
            row.stageName,
            row.passed,
            row.filtered,
            row.durationMs,
            row.error ? 1 : 0,
            row.retries ?? 0,
            JSON.stringify(row.errorCodes ?? []),
          ],
        );
      }
    });
    return stages.length;
  }

  async findByRunId(runId: string): Promise<StageMetricRow[]> {
    const rows = await this.db.query<MetricRecord>(
      'SELECT * FROM pipeline_metrics WHERE pipeline_run_id = ? ORDER BY stage_name',
      [runId],
    );
    return rows.map(toMetricRow);
  }

  async findRecentRuns(limit: number = 20): Promise<MetricsHistory[]> {
    const runIds = await this.db.query<{ pipeline_run_id: string; started_at: string | null }>(
      `SELECT DISTINCT pm.pipeline_run_id, pr.started_at
         FROM pipeline_metrics pm
         LEFT JOIN pipeline_runs pr ON pr.run_id = pm.pipeline_run_id
         ORDER BY pr.started_at DESC
         LIMIT ?`,
      [limit],
    );
    const results: MetricsHistory[] = [];
    for (const r of runIds) {
      const stages = await this.findByRunId(r.pipeline_run_id);
      results.push({
        runId: r.pipeline_run_id,
        startedAt: r.started_at ?? '',
        stages,
      });
    }
    return results;
  }

  async getAggregates(): Promise<MetricAggregate[]> {
    const rows = await this.db.query<{
      stage_name: string;
      total_duration_ms: number;
      total_passed: number;
      total_filtered: number;
      run_count: number;
      error_count: number;
    }>(
      `SELECT
         stage_name,
         SUM(duration_ms) AS total_duration_ms,
         SUM(passed) AS total_passed,
         SUM(filtered) AS total_filtered,
         COUNT(*) AS run_count,
         SUM(error) AS error_count
       FROM pipeline_metrics
       GROUP BY stage_name
       ORDER BY stage_name`,
    );

    const results: MetricAggregate[] = [];
    for (const r of rows) {
      results.push({
        stageName: r.stage_name,
        totalDurationMs: r.total_duration_ms,
        totalPassed: r.total_passed,
        totalFiltered: r.total_filtered,
        runCount: r.run_count,
        errorCount: r.error_count,
        avgDurationMs: r.run_count > 0 ? Math.round(r.total_duration_ms / r.run_count) : 0,
        p50DurationMs: await this.#percentileForStage(r.stage_name, 0.5),
        p95DurationMs: await this.#percentileForStage(r.stage_name, 0.95),
      });
    }
    return results;
  }

  async deleteByRunId(runId: string): Promise<number> {
    const result = await this.db.exec('DELETE FROM pipeline_metrics WHERE pipeline_run_id = ?', [
      runId,
    ]);
    return result.changes;
  }

  async #percentileForStage(stageName: string, percentile: number): Promise<number> {
    const rows = await this.db.query<{ duration_ms: number }>(
      `SELECT duration_ms
         FROM pipeline_metrics
        WHERE stage_name = ?
        ORDER BY duration_ms ASC`,
      [stageName],
    );
    if (rows.length === 0) return 0;
    const index = Math.ceil(percentile * rows.length) - 1;
    return rows[Math.max(0, index)]?.duration_ms ?? 0;
  }
}

function toMetricRow(r: MetricRecord): StageMetricRow {
  return {
    pipelineRunId: r.pipeline_run_id,
    stageName: r.stage_name,
    passed: r.passed,
    filtered: r.filtered,
    durationMs: r.duration_ms,
    error: r.error !== 0,
    retries: r.retries,
    errorCodes: safeParseJsonArray(r.error_codes),
  };
}

function safeParseJsonArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
