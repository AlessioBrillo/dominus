import type Database from 'better-sqlite3';

/**
 * One row of the `pipeline_runs` table (ADR-0011).
 *
 * The shape mirrors the orchestrator's `PipelineResult` plus a few
 * operator-friendly fields (`host_version`, `retained_until`, `error`).
 * JSON columns are returned as parsed objects to keep callers from
 * dealing with stringly-typed payloads.
 */
export interface PipelineRun {
  runId: string;
  startedAt: string;
  finishedAt: string | null;
  totalDurationMs: number | null;
  stageSummary: Record<string, { passed: number; filtered: number; durationMs: number }>;
  inputs: PipelineRunInputs;
  resultsSummary: PipelineRunResults;
  hostVersion: string;
  retainedUntil: string;
  error: string | null;
}

export interface PipelineRunInputs {
  keywords: number;
  brandableNames: number;
  closeoutDomains: number;
  closeoutEntries: number;
}

export interface PipelineRunResults {
  candidatesEvaluated: number;
  recommended: number;
  trademarkBlocked: number;
  unscored: number;
  errors: number;
}

export interface InsertPipelineRunInput {
  runId: string;
  startedAt: string;
  finishedAt?: string | null;
  totalDurationMs?: number | null;
  stageSummary?: Record<string, { passed: number; filtered: number; durationMs: number }>;
  inputs?: PipelineRunInputs;
  resultsSummary?: PipelineRunResults;
  hostVersion: string;
  retainedUntil: string;
  error?: string | null;
}

export interface CompletePipelineRunInput {
  finishedAt: string;
  totalDurationMs: number;
  stageSummary: Record<string, { passed: number; filtered: number; durationMs: number }>;
  resultsSummary: PipelineRunResults;
  error?: string | null;
}

export interface ListPipelineRunsOptions {
  since?: string;
  until?: string;
  limit?: number;
}

interface PipelineRunRow {
  run_id: string;
  started_at: string;
  finished_at: string | null;
  total_duration_ms: number | null;
  stage_summary: string;
  inputs: string;
  results_summary: string;
  host_version: string;
  retained_until: string;
  error: string | null;
}

const EMPTY_INPUTS: PipelineRunInputs = {
  keywords: 0,
  brandableNames: 0,
  closeoutDomains: 0,
  closeoutEntries: 0,
};

const EMPTY_RESULTS: PipelineRunResults = {
  candidatesEvaluated: 0,
  recommended: 0,
  trademarkBlocked: 0,
  unscored: 0,
  errors: 0,
};

const EMPTY_STAGE_SUMMARY: Record<
  string,
  { passed: number; filtered: number; durationMs: number }
> = {};

function parseJsonOr<T>(raw: string, fallback: T): T {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object') return fallback;
    return parsed as T;
  } catch {
    return fallback;
  }
}

function rowToRun(row: PipelineRunRow): PipelineRun {
  return {
    runId: row.run_id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    totalDurationMs: row.total_duration_ms,
    stageSummary: parseJsonOr(row.stage_summary, EMPTY_STAGE_SUMMARY),
    inputs: parseJsonOr(row.inputs, EMPTY_INPUTS),
    resultsSummary: parseJsonOr(row.results_summary, EMPTY_RESULTS),
    hostVersion: row.host_version,
    retainedUntil: row.retained_until,
    error: row.error,
  };
}

/**
 * CRUD over the `pipeline_runs` table.
 *
 * The orchestrator pipeline writes one row per run. Pruning is
 * explicit (operator-driven) and idempotent. findAll is the primary
 * discovery surface for the `dominus runs list` CLI and the
 * `/api/runs` REST endpoint.
 */
export class PipelineRunsRepository {
  constructor(private readonly db: Database.Database) {}

  /**
   * Insert a new run. The run is created in a "started" state —
   * `finishedAt`, `totalDurationMs`, and `error` are null until
   * the orchestrator calls `complete()`.
   */
  insert(input: InsertPipelineRunInput): PipelineRun {
    const row = this.db
      .prepare(
        `INSERT INTO pipeline_runs
           (run_id, started_at, finished_at, total_duration_ms,
            stage_summary, inputs, results_summary, host_version,
            retained_until, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING *`,
      )
      .get(
        input.runId,
        input.startedAt,
        input.finishedAt ?? null,
        input.totalDurationMs ?? null,
        JSON.stringify(input.stageSummary ?? EMPTY_STAGE_SUMMARY),
        JSON.stringify(input.inputs ?? EMPTY_INPUTS),
        JSON.stringify(input.resultsSummary ?? EMPTY_RESULTS),
        input.hostVersion,
        input.retainedUntil,
        input.error ?? null,
      ) as PipelineRunRow;
    return rowToRun(row);
  }

  /**
   * Mark a run as finished. Updates finished_at, total_duration_ms,
   * stage_summary, results_summary, and (optionally) error. Returns
   * the updated row, or null when the run_id is unknown.
   */
  complete(runId: string, input: CompletePipelineRunInput): PipelineRun | null {
    const result = this.db
      .prepare(
        `UPDATE pipeline_runs
            SET finished_at = ?,
                total_duration_ms = ?,
                stage_summary = ?,
                results_summary = ?,
                error = ?
          WHERE run_id = ?
          RETURNING *`,
      )
      .get(
        input.finishedAt,
        input.totalDurationMs,
        JSON.stringify(input.stageSummary),
        JSON.stringify(input.resultsSummary),
        input.error ?? null,
        runId,
      ) as PipelineRunRow | undefined;
    return result ? rowToRun(result) : null;
  }

  findById(runId: string): PipelineRun | null {
    const row = this.db.prepare('SELECT * FROM pipeline_runs WHERE run_id = ?').get(runId) as
      | PipelineRunRow
      | undefined;
    return row ? rowToRun(row) : null;
  }

  /**
   * List runs ordered by started_at DESC, with optional date filters.
   * `since` and `until` are inclusive ISO-8601 strings compared
   * lexicographically (which works for the canonical UTC format).
   */
  findAll(options: ListPipelineRunsOptions = {}): PipelineRun[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (options.since !== undefined) {
      where.push('started_at >= ?');
      params.push(options.since);
    }
    if (options.until !== undefined) {
      where.push('started_at <= ?');
      params.push(options.until);
    }
    const whereClause = where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`;
    const limitClause = options.limit !== undefined && options.limit > 0 ? 'LIMIT ?' : '';
    const finalParams =
      options.limit !== undefined && options.limit > 0 ? [...params, options.limit] : params;
    const sql = `SELECT * FROM pipeline_runs ${whereClause} ORDER BY started_at DESC ${limitClause}`;
    const rows = this.db.prepare(sql).all(...finalParams) as PipelineRunRow[];
    return rows.map(rowToRun);
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM pipeline_runs').get() as { n: number };
    return row.n;
  }

  /**
   * Count runs whose `started_at` is strictly before `cutoff`.
   * Used by `prune --before --dry-run` to preview deletions.
   */
  countBefore(cutoff: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM pipeline_runs WHERE started_at < ?')
      .get(cutoff) as { n: number };
    return row.n;
  }

  /**
   * Delete every run whose `started_at` is strictly before `cutoff`.
   * Used by `prune --before <days>` to override the retained_until-
   * based expiry with an absolute age threshold. Returns the number
   * of rows deleted.
   */
  pruneBefore(cutoff: string): number {
    const result = this.db.prepare('DELETE FROM pipeline_runs WHERE started_at < ?').run(cutoff);
    return Number(result.changes);
  }

  /**
   * Delete every run whose `retained_until` is strictly before `now`.
   * Returns the number of rows deleted. Idempotent — a second call
   * with the same `now` is a no-op.
   */
  prune(now: string = new Date().toISOString()): number {
    const result = this.db.prepare('DELETE FROM pipeline_runs WHERE retained_until < ?').run(now);
    return Number(result.changes);
  }

  /** Test helper: clear every row. Not exposed via CLI. */
  deleteAll(): void {
    this.db.prepare('DELETE FROM pipeline_runs').run();
  }
}
