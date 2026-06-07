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

  constructor(
    db: Database.Database,
    orchestrator: PipelineOrchestrator,
    candidateRepo: CandidateRepository,
    scoringRepo: ScoringRepository,
    runsRepo: PipelineRunsRepository = new PipelineRunsRepository(db),
    hostVersion: string = readHostVersion(),
    retentionDays: number = DEFAULT_PIPELINE_RUN_RETENTION_DAYS,
  ) {
    this.#db = db;
    this.#orchestrator = orchestrator;
    this.#candidateRepo = candidateRepo;
    this.#scoringRepo = scoringRepo;
    this.#runsRepo = runsRepo;
    this.#hostVersion = hostVersion;
    this.#retentionDays = retentionDays;
  }

  async run(
    input: CandidateGenerationInput,
    options: PipelineRunOptions = {},
  ): Promise<PipelineRunResult> {
    const startedAt = new Date().toISOString();
    const runRowId = randomUUID();
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
    const persistence = this.#db.transaction((): PersistenceSummary => {
      let candidatesPersisted = 0;
      let scoresPersisted = 0;

      // Upsert every candidate that passed through the pipeline (any status).
      // The Map keyed by domain lets us look up the persisted id for scoring rows.
      const idByDomain = new Map<string, number>();
      for (const candidate of result.allCandidates) {
        const persisted = this.#candidateRepo.upsert(candidate);
        if (persisted.id !== undefined) {
          idByDomain.set(persisted.domain, persisted.id);
        }
        candidatesPersisted++;
      }

      // Persist scores for every candidate that was evaluated by the scoring engine,
      // whether recommended, not-recommended, or TM-blocked. Partial history is
      // valuable for tuning weights against real results.
      // Candidates that errored during scoring carry scoreResult === null;
      // skip them rather than writing a null row (the scoring_runs columns
      // are all NOT NULL, so the INSERT would crash).
      for (const scored of result.scored) {
        if (scored.scoreResult === null) continue;
        const id = idByDomain.get(scored.domain);
        if (id !== undefined) {
          this.#scoringRepo.insert(id, result.runId, scored.scoreResult);
          scoresPersisted++;
        }
      }

      // Align the orchestrator-level runId (used inside candidates + scoring_runs)
      // with the service-level runRowId (used in pipeline_runs). This makes
      // pipeline_runs the single source of truth for "what ran together" and
      // lets REST endpoints (e.g. GET /api/runs/:runId/candidates) join on
      // pipeline_runs.run_id. ADR-0011 §5.3.
      if (result.runId !== runRowId) {
        this.#db.prepare('UPDATE candidates SET pipeline_run_id = ? WHERE pipeline_run_id = ?').run(runRowId, result.runId);
        this.#db.prepare('UPDATE scoring_runs SET run_id = ? WHERE run_id = ?').run(runRowId, result.runId);
      }

      return { candidatesPersisted, scoresPersisted };
    })();

    const totalDurationMs = Date.now() - startedMs;

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
    else if (status === 'dns_filtered' || status === 'rdap_filtered' || status === 'unscored') unscored++;
  }
  return {
    candidatesEvaluated: persistence.candidatesPersisted,
    recommended: result.recommended.length,
    trademarkBlocked,
    unscored,
    errors: 0,
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
