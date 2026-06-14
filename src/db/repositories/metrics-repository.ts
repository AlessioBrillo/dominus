import type Database from 'better-sqlite3';

export interface StageMetricRow {
  pipelineRunId?: string;
  stageName: string;
  passed: number;
  filtered: number;
  durationMs: number;
  error: boolean;
}

interface MetricRecord {
  id: number;
  pipeline_run_id: string;
  stage_name: string;
  passed: number;
  filtered: number;
  duration_ms: number;
  error: number;
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
  constructor(private readonly db: Database.Database) {}

  insertBatch(runId: string, stages: StageMetricRow[]): number {
    if (stages.length === 0) return 0;
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO pipeline_metrics
        (pipeline_run_id, stage_name, passed, filtered, duration_ms, error)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const insertMany = this.db.transaction((rows: StageMetricRow[]) => {
      for (const row of rows) {
        stmt.run(runId, row.stageName, row.passed, row.filtered, row.durationMs, row.error ? 1 : 0);
      }
    });
    insertMany(stages);
    return stages.length;
  }

  findByRunId(runId: string): StageMetricRow[] {
    const rows = this.db
      .prepare('SELECT * FROM pipeline_metrics WHERE pipeline_run_id = ? ORDER BY stage_name')
      .all(runId) as MetricRecord[];
    return rows.map(toMetricRow);
  }

  findRecentRuns(limit: number = 20): MetricsHistory[] {
    const runIds = this.db
      .prepare(
        `SELECT DISTINCT pm.pipeline_run_id, pr.started_at
           FROM pipeline_metrics pm
           LEFT JOIN pipeline_runs pr ON pr.run_id = pm.pipeline_run_id
           ORDER BY pr.started_at DESC
           LIMIT ?`,
      )
      .all(limit) as { pipeline_run_id: string; started_at: string | null }[];
    return runIds.map((r) => {
      const stages = this.findByRunId(r.pipeline_run_id);
      return {
        runId: r.pipeline_run_id,
        startedAt: r.started_at ?? '',
        stages,
      };
    });
  }

  getAggregates(): MetricAggregate[] {
    const rows = this.db
      .prepare(
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
      )
      .all() as Array<{
      stage_name: string;
      total_duration_ms: number;
      total_passed: number;
      total_filtered: number;
      run_count: number;
      error_count: number;
    }>;

    return rows.map((r) => ({
      stageName: r.stage_name,
      totalDurationMs: r.total_duration_ms,
      totalPassed: r.total_passed,
      totalFiltered: r.total_filtered,
      runCount: r.run_count,
      errorCount: r.error_count,
      avgDurationMs: r.run_count > 0 ? Math.round(r.total_duration_ms / r.run_count) : 0,
      p50DurationMs: this.#percentileForStage(r.stage_name, 0.5),
      p95DurationMs: this.#percentileForStage(r.stage_name, 0.95),
    }));
  }

  deleteByRunId(runId: string): number {
    const result = this.db
      .prepare('DELETE FROM pipeline_metrics WHERE pipeline_run_id = ?')
      .run(runId);
    return Number(result.changes);
  }

  #percentileForStage(stageName: string, percentile: number): number {
    const rows = this.db
      .prepare(
        `SELECT duration_ms
           FROM pipeline_metrics
          WHERE stage_name = ?
          ORDER BY duration_ms ASC`,
      )
      .all(stageName) as { duration_ms: number }[];
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
  };
}
