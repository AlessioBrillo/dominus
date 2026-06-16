import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type Database from 'better-sqlite3';
import type { PipelineOrchestrator, PipelineResult } from '../pipeline/orchestrator.js';
import type { CandidateGenerationInput } from '../pipeline/stages/candidate-generation-stage.js';
import type { CandidateRepository } from '../db/repositories/candidate-repository.js';
import type { ScoringRepository } from '../db/repositories/scoring-repository.js';
import {
  PipelineRunsRepository,
  type PipelineRunInputs,
  type PipelineRunResults,
} from '../db/repositories/pipeline-runs-repository.js';
import { MetricsRepository } from '../db/repositories/metrics-repository.js';
import { type PipelineProgressService } from './pipeline-progress-service.js';

/** Default retention window for pipeline_runs rows, in days (ADR-0011). */
export const DEFAULT_PIPELINE_RUN_RETENTION_DAYS = 180;

export interface PersistenceSummary {
  candidatesPersisted: number;
  scoresPersisted: number;
}

export interface PipelineRunResult extends PipelineResult {
  persistence: PersistenceSummary;
  /** Start timestamp captured by the service (ISO-8601 UTC). */
  startedAt: string;
  /** Pipeline_runs row id (UUID); also the runId persisted to candidates/scoring_runs. */
  runRowId: string;
}

/** Options for the PipelineRunService.run() entrypoint. */
export interface PipelineRunOptions {
  /** Override the host version recorded on the pipeline_runs row. */
  hostVersion?: string;
  /**
   * External run ID to use instead of generating a new UUID.
   * When provided, this ID is used as the pipeline_runs PK and
   * referenced in candidates/scoring_runs. This lets callers
   * (e.g. JobQueue handler) keep a consistent run ID across the
   * enqueue → process → complete lifecycle.
   */
  externalRunId?: string;
}

/**
 * Application-layer coordinator that runs the pipeline and persists results.
 *
 * This is the only module that depends on both `pipeline/` and `db/` — it sits
 * above both in the module DAG. `pipeline/` and `scoring/` remain pure and
 * never import from `db/`.
 *
 * All writes happen inside a single better-sqlite3 transaction for atomicity.
 * A row is inserted into `pipeline_runs` BEFORE the orchestrator runs and is
 * completed (with `finishedAt`, `total_duration_ms`, stage/result summary,
 * and optional `error`) when the run ends. Error paths complete the row
 * with `error` set and rethrow the original exception.
 */
export class PipelineRunService {
  readonly #db: Database.Database;
  readonly #orchestrator: PipelineOrchestrator;
  readonly #candidateRepo: CandidateRepository;
  readonly #scoringRepo: ScoringRepository;
  readonly #runsRepo: PipelineRunsRepository;
  readonly #hostVersion: string;
  readonly #retentionDays: number;

  readonly #metricsRepo: MetricsRepository;
  readonly #progressService: PipelineProgressService | undefined;

  constructor(
    db: Database.Database,
    orchestrator: PipelineOrchestrator,
    candidateRepo: CandidateRepository,
    scoringRepo: ScoringRepository,
    runsRepo: PipelineRunsRepository = new PipelineRunsRepository(db),
    hostVersion: string = readHostVersion(),
    retentionDays: number = DEFAULT_PIPELINE_RUN_RETENTION_DAYS,
    metricsRepo: MetricsRepository = new MetricsRepository(db),
    progressService?: PipelineProgressService,
  ) {
    this.#db = db;
    this.#orchestrator = orchestrator;
    this.#candidateRepo = candidateRepo;
    this.#scoringRepo = scoringRepo;
    this.#runsRepo = runsRepo;
    this.#hostVersion = hostVersion;
    this.#retentionDays = retentionDays;
    this.#metricsRepo = metricsRepo;
    this.#progressService = progressService;
  }

  async run(
    input: CandidateGenerationInput,
    options: PipelineRunOptions = {},
  ): Promise<PipelineRunResult> {
    const startedAt = new Date().toISOString();
    const runRowId = options.externalRunId ?? randomUUID();
    const retainedUntil = computeRetainedUntil(startedAt, this.#retentionDays);
    const inputs = snapshotInputs(input);
    const hostVersion = options.hostVersion ?? this.#hostVersion;

    // Pre-insert: a pipeline_runs row is written BEFORE the orchestrator runs.
    // Operators can observe a "stuck" row if the process crashes, which is
    // more useful than a missing row (ADR-0011 §5.2).
    this.#runsRepo.insert({
      runId: runRowId,
      startedAt,
      hostVersion,
      retainedUntil,
      inputs,
    });

    const startedMs = Date.now();
    let result: PipelineResult;
    try {
      if (this.#progressService) {
        const runId = runRowId;
        this.#orchestrator.setOnStageProgress((stageName, passed, filtered, durationMs, error) => {
          this.#progressService!.broadcast(runId, {
            type: 'stage',
            runId,
            stageName,
            passed,
            filtered,
            durationMs,
            error,
          });
        });
      }
      result = await this.#orchestrator.run(input);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.#runsRepo.complete(runRowId, {
        finishedAt: new Date().toISOString(),
        totalDurationMs: Date.now() - startedMs,
        stageSummary: {},
        resultsSummary: emptyResults(),
        error: message,
      });
      throw err;
    }

    // Persist inside a single transaction. better-sqlite3 transactions are
    // synchronous — the async pipeline work is already done above.
    // The transaction is wrapped in try/catch so that persistence failures
    // still complete the pipeline_runs row with a meaningful error.
    let persistence: PersistenceSummary;
    try {
      persistence = this.#db.transaction((): PersistenceSummary => {
        let candidatesPersisted = 0;
        let scoresPersisted = 0;

        const idByDomain = new Map<string, number>();
        for (const candidate of result.allCandidates) {
          const persisted = this.#candidateRepo.upsert(candidate);
          if (persisted.id !== undefined) {
            idByDomain.set(persisted.domain, persisted.id);
          }
          candidatesPersisted++;
        }

        for (const scored of result.scored) {
          if (scored.scoreResult === null) continue;
          const id = idByDomain.get(scored.domain);
          if (id !== undefined) {
            this.#scoringRepo.insert(id, result.runId, scored.scoreResult);
            scoresPersisted++;
          }
        }

        if (result.runId !== runRowId) {
          this.#db
            .prepare('UPDATE candidates SET pipeline_run_id = ? WHERE pipeline_run_id = ?')
            .run(runRowId, result.runId);
          this.#db
            .prepare('UPDATE scoring_runs SET run_id = ? WHERE run_id = ?')
            .run(runRowId, result.runId);
        }

        return { candidatesPersisted, scoresPersisted };
      })();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.#runsRepo.complete(runRowId, {
        finishedAt: new Date().toISOString(),
        totalDurationMs: Date.now() - startedMs,
        stageSummary: result.stageSummary,
        resultsSummary: emptyResults(),
        error: `Persistence failed: ${message}`,
      });
      throw err;
    }

    // Persist per-stage metrics for observability.
    this.#persistStageMetrics(runRowId, result);

    const totalDurationMs = Date.now() - startedMs;

    // Broadcast completion to SSE clients.
    if (this.#progressService) {
      const totalPassed = Object.values(result.stageSummary).reduce((sum, s) => sum + s.passed, 0);
      const totalFiltered = Object.values(result.stageSummary).reduce(
        (sum, s) => sum + s.filtered,
        0,
      );
      this.#progressService.broadcast(runRowId, {
        type: 'complete',
        runId: runRowId,
        totalDurationMs,
        totalPassed,
        totalFiltered,
        stageErrors: result.stageErrors.length,
      });
      this.#progressService.removeClient(runRowId);
    }

    // Complete the pipeline_runs row with stage + result summary.
    this.#runsRepo.complete(runRowId, {
      finishedAt: new Date().toISOString(),
      totalDurationMs,
      stageSummary: result.stageSummary,
      resultsSummary: buildResultsSummary(result, persistence),
    });

    return {
      ...result,
      persistence,
      startedAt,
      runRowId,
    };
  }

  #persistStageMetrics(runId: string, result: PipelineResult): void {
    const stages: Array<{
      stageName: string;
      passed: number;
      filtered: number;
      durationMs: number;
      error: boolean;
    }> = [];

    for (const [name, summary] of Object.entries(result.stageSummary)) {
      const hasError = result.stageErrors.some((e) => e.stageName === name);
      stages.push({
        stageName: name,
        passed: summary.passed,
        filtered: summary.filtered,
        durationMs: summary.durationMs,
        error: hasError,
      });
    }

    if (stages.length > 0) {
      this.#metricsRepo.insertBatch(runId, stages);
    }
  }
}

function snapshotInputs(input: CandidateGenerationInput): PipelineRunInputs {
  return {
    keywords: input.keywords?.length ?? 0,
    brandableNames: input.brandableNames?.length ?? 0,
    closeoutDomains: input.closeoutDomains?.length ?? 0,
    closeoutEntries: input.closeoutEntries?.length ?? 0,
  };
}

function buildResultsSummary(
  result: PipelineResult,
  persistence: PersistenceSummary,
): PipelineRunResults {
  const statusByDomain = new Map<string, string>();
  for (const c of result.allCandidates) {
    statusByDomain.set(c.domain, c.status);
  }
  let trademarkBlocked = 0;
  let unscored = 0;
  for (const status of statusByDomain.values()) {
    if (status === 'trademark_blocked') trademarkBlocked++;
    else if (status === 'dns_filtered' || status === 'rdap_filtered' || status === 'unscored')
      unscored++;
  }
  return {
    candidatesEvaluated: persistence.candidatesPersisted,
    recommended: result.recommended.length,
    trademarkBlocked,
    unscored,
    errors: result.stageErrors.length,
  };
}

function emptyResults(): PipelineRunResults {
  return { candidatesEvaluated: 0, recommended: 0, trademarkBlocked: 0, unscored: 0, errors: 0 };
}

function computeRetainedUntil(startedAt: string, days: number): string {
  const start = new Date(startedAt);
  return new Date(start.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

let cachedHostVersion: string | null = null;

function readHostVersion(): string {
  if (cachedHostVersion !== null) return cachedHostVersion;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // Walk up to the project root: from dist/app or src/app → ../../package.json
    const pkgPath = join(here, '..', '..', 'package.json');
    const raw = readFileSync(pkgPath, 'utf-8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    cachedHostVersion = typeof parsed.version === 'string' ? parsed.version : 'unknown';
  } catch {
    cachedHostVersion = 'unknown';
  }
  return cachedHostVersion;
}
