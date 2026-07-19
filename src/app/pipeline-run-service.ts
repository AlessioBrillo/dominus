import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { DatabaseProvider } from '../db/provider/interface.js';
import type { PipelineOrchestrator, PipelineResult } from '../pipeline/orchestrator.js';
import type { CandidateGenerationInput } from '../pipeline/stages/candidate-generation-stage.js';
import type { DomainCandidate } from '../types/candidate.js';
import type { CandidateRepository } from '../db/repositories/candidate-repository.js';
import type { ScoringRepository } from '../db/repositories/scoring-repository.js';
import {
  PipelineRunsRepository,
  type PipelineRunInputs,
  type PipelineRunResults,
} from '../db/repositories/pipeline-runs-repository.js';
import { MetricsRepository } from '../db/repositories/metrics-repository.js';
import { getLogger } from '../logger.js';
import { type PipelineProgressService } from './pipeline-progress-service.js';
import type { JobQueueService } from './job-queue-service.js';

const logger = getLogger();

/** Default retention window for pipeline_runs rows, in days (ADR-0011). */
export const DEFAULT_PIPELINE_RUN_RETENTION_DAYS = 180;

/**
 * Maximum number of candidate/score rows to persist in a single transaction.
 * Larger batches improve throughput but hold the database lock longer.
 * For SQLite with a dedicated bulk-write connection (WAL mode), this is
 * primarily a memory concern. For PostgreSQL, it prevents prolonged
 * lock contention on the main connection.
 *
 * Adaptive batch sizing: the persistence loop measures write duration and
 * reduces batch size when writes take too long (SQLite contention). The
 * batch size can range between MIN and MAX. Default: 500.
 * See: ponytail: adaptive batch sizing — global lock, per-account locks if
 * throughput matters on multi-tenant PG.
 */
const PERSISTENCE_BATCH_SIZE_INITIAL = 500;
const PERSISTENCE_BATCH_SIZE_MIN = 100;
const PERSISTENCE_BATCH_SIZE_MAX = 1000;
/** If a write batch takes longer than this (ms), halve the batch size. */
const PERSISTENCE_BATCH_SLOW_THRESHOLD_MS = 500;
/** If a write batch finishes faster than this (ms), double the batch size. */
const PERSISTENCE_BATCH_FAST_THRESHOLD_MS = 100;

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
  /**
   * When true, create draft marketplace listings for recommended
   * candidates after the run completes. Requires setOnRunComplete
   * to be wired with an AutoListingService-compatible handler.
   */
  autoList?: boolean;
  /**
   * External AbortSignal for cancellation (e.g., from worker shutdown).
   * When the signal fires, the orchestrator aborts the current run.
   * Previously, the worker's abort signal was never forwarded to the
   * pipeline, causing in-flight runs to continue until timeout even
   * during graceful shutdown. Default: undefined (no external signal).
   */
  signal?: AbortSignal;
}

export type OnRunComplete = (
  result: PipelineRunResult,
  options?: PipelineRunOptions,
) => void | Promise<void>;

export interface EnqueueRunResult {
  runId: string;
  jobId: string | null;
}

/**
 * Application-layer coordinator that runs the pipeline and persists results.
 *
 * This is the only module that depends on both `pipeline/` and `db/` — it sits
 * above both in the module DAG. `pipeline/` and `scoring/` remain pure and
 * never import from `db/`.
 *
 * SUPPORTED EXECUTION MODES:
 *
 * 1. DEFAULT (auto): When `workerEnabled` is true, `run()` enqueues via the
 *    job queue and returns immediately. When false, it runs synchronously.
 *
 * 2. runSync(): Always runs the pipeline synchronously. Used by the job queue
 *    PipelineRunHandler (which is already inside the worker context) and by
 *    callers that explicitly request sync execution via --sync flag.
 *
 * 3. enqueueRun(): Inserts a pipeline_runs row and enqueues a job via the
 *    JobQueueService. Returns { runId, jobId } immediately. The job queue
 *    worker picks it up asynchronously.
 */
export class PipelineRunService {
  readonly #provider: DatabaseProvider;
  readonly #orchestrator: PipelineOrchestrator;
  readonly #candidateRepo: CandidateRepository;
  readonly #scoringRepo: ScoringRepository;
  readonly #runsRepo: PipelineRunsRepository;
  readonly #hostVersion: string;
  readonly #retentionDays: number;

  readonly #metricsRepo: MetricsRepository;
  readonly #progressService: PipelineProgressService | undefined;
  readonly #jobQueueService: JobQueueService | undefined;
  readonly #workerEnabled: boolean;
  /** Dedicated provider for pipeline persistence writes (separate SQLite connection). */
  readonly #bulkWriteProvider: DatabaseProvider | undefined;
  #onRunComplete: OnRunComplete | undefined;

  constructor(
    provider: DatabaseProvider,
    orchestrator: PipelineOrchestrator,
    candidateRepo: CandidateRepository,
    scoringRepo: ScoringRepository,
    runsRepo: PipelineRunsRepository = new PipelineRunsRepository(provider),
    hostVersion: string = readHostVersion(),
    retentionDays: number = DEFAULT_PIPELINE_RUN_RETENTION_DAYS,
    metricsRepo: MetricsRepository = new MetricsRepository(provider),
    progressService?: PipelineProgressService,
    jobQueueService?: JobQueueService,
    workerEnabled: boolean = false,
    /** When provided, candidate/score persistence uses this connection instead of the
     *  main provider. On SQLite with WAL mode, this allows the main connection
     *  to serve reads while a bulk write transaction runs on this dedicated conn. */
    bulkWriteProvider?: DatabaseProvider,
  ) {
    this.#provider = provider;
    this.#orchestrator = orchestrator;
    this.#candidateRepo = candidateRepo;
    this.#scoringRepo = scoringRepo;
    this.#runsRepo = runsRepo;
    this.#hostVersion = hostVersion;
    this.#retentionDays = retentionDays;
    this.#metricsRepo = metricsRepo;
    this.#progressService = progressService;
    this.#jobQueueService = jobQueueService;
    this.#workerEnabled = workerEnabled;
    this.#bulkWriteProvider = bulkWriteProvider;
  }

  setOnRunComplete(cb: OnRunComplete): void {
    this.#onRunComplete = cb;
  }

  /** The provider used for persistence writes (bulk-write if available, main otherwise). */
  get #persistenceProvider(): DatabaseProvider {
    return this.#bulkWriteProvider ?? this.#provider;
  }

  /**
   * Default entry point. Behaviour depends on `workerEnabled`:
   *  - true:  enqueue via job queue, return immediately (async)
   *  - false: run synchronously (legacy fallback)
   */
  async run(
    input: CandidateGenerationInput,
    options: PipelineRunOptions = {},
  ): Promise<PipelineRunResult | EnqueueRunResult> {
    if (this.#workerEnabled && this.#jobQueueService) {
      return this.enqueueRun(input);
    }
    return this.runSync(input, options);
  }

  /**
   * Enqueue a pipeline run via the job queue and return immediately.
   * The pipeline_runs row is created before enqueuing so the operator can
   * observe a 'stuck' row if the worker crashes (ADR-0011 §5.2).
   */
  async enqueueRun(input: CandidateGenerationInput): Promise<EnqueueRunResult> {
    if (!this.#jobQueueService) {
      throw new Error(
        'Cannot enqueue pipeline run: JobQueueService is not available. ' +
          'Set WORKER_ENABLED=true and ensure job queue is configured.',
      );
    }

    const startedAt = new Date().toISOString();
    const runRowId = randomUUID();
    const retainedUntil = computeRetainedUntil(startedAt, this.#retentionDays);
    const hostVersion = this.#hostVersion;

    await this.#runsRepo.insert({
      runId: runRowId,
      startedAt,
      hostVersion,
      retainedUntil,
      inputs: snapshotInputs(input),
    });

    const { jobId } = await this.#jobQueueService.enqueuePipelineRun(input, runRowId);

    return { runId: runRowId, jobId };
  }

  /**
   * Synchronous execution: runs the full pipeline inline and persists all
   * results before returning. This is the legacy path used by the job queue
   * PipelineRunHandler (which is already inside the worker) and by callers
   * that explicitly request sync mode via the --sync CLI flag.
   */
  async runSync(
    input: CandidateGenerationInput,
    options: PipelineRunOptions = {},
  ): Promise<PipelineRunResult> {
    const startedAt = new Date().toISOString();
    const runRowId = options.externalRunId ?? randomUUID();
    const retainedUntil = computeRetainedUntil(startedAt, this.#retentionDays);
    const inputs = snapshotInputs(input);
    const hostVersion = options.hostVersion ?? this.#hostVersion;

    // When an externalRunId is provided (async path via enqueueRun), the
    // pipeline_runs row was already inserted before enqueuing so the operator
    // can observe a 'started' row if the worker crashes (ADR-0011 §5.2).
    // Skip the insert and use the existing row's values.
    if (options.externalRunId) {
      const existing = await this.#runsRepo.findById(runRowId);
      if (!existing) {
        await this.#runsRepo.insert({
          runId: runRowId,
          startedAt,
          hostVersion,
          retainedUntil,
          inputs,
        });
      }
    } else {
      await this.#runsRepo.insert({
        runId: runRowId,
        startedAt,
        hostVersion,
        retainedUntil,
        inputs,
      });
    }

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
      result = await this.#orchestrator.run(input, runRowId, options.signal);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.#runsRepo.complete(runRowId, {
        finishedAt: new Date().toISOString(),
        totalDurationMs: Date.now() - startedMs,
        stageSummary: {},
        resultsSummary: emptyResults(),
        error: message,
      });
      throw err;
    }

    let persistence: PersistenceSummary;
    try {
      // Phase 1: upsert candidates in batches with adaptive sizing.
      // Each batch is a separate transaction so no single write holds the
      // database lock for the entire candidate set (critical for PG, beneficial for SQLite).
      // Adaptive batch sizing monitors write duration and adjusts batch size
      // to avoid prolonged lock contention under load.
      const idByDomain = new Map<string, number>();
      let candidatesPersisted = 0;

      let batchSize = PERSISTENCE_BATCH_SIZE_INITIAL;
      const upsertBatch = async (batch: DomainCandidate[]): Promise<void> => {
        const start = Date.now();
        await this.#persistenceProvider.transaction(async () => {
          for (const candidate of batch) {
            const persisted = await this.#candidateRepo.upsert(candidate);
            if (persisted.id !== undefined) {
              idByDomain.set(persisted.domain, persisted.id);
            }
          }
        });
        const elapsed = Date.now() - start;
        if (
          elapsed > PERSISTENCE_BATCH_SLOW_THRESHOLD_MS &&
          batchSize > PERSISTENCE_BATCH_SIZE_MIN
        ) {
          batchSize = Math.max(PERSISTENCE_BATCH_SIZE_MIN, Math.floor(batchSize / 2));
        } else if (
          elapsed < PERSISTENCE_BATCH_FAST_THRESHOLD_MS &&
          batchSize < PERSISTENCE_BATCH_SIZE_MAX
        ) {
          batchSize = Math.min(PERSISTENCE_BATCH_SIZE_MAX, batchSize * 2);
        }
      };

      for (let i = 0; i < result.allCandidates.length; i += batchSize) {
        const batch = result.allCandidates.slice(i, i + batchSize);
        await upsertBatch(batch);
        candidatesPersisted += batch.length;
      }

      // Phase 2: insert scores in batches, each in its own transaction.
      let scoresPersisted = 0;
      const scoredWithIds = result.scored.filter(
        (s) => s.scoreResult !== null && idByDomain.has(s.domain),
      );

      // Reset batch size for score inserts (different write pattern)
      batchSize = PERSISTENCE_BATCH_SIZE_INITIAL;
      for (let i = 0; i < scoredWithIds.length; i += batchSize) {
        const batch = scoredWithIds.slice(i, i + batchSize);
        const start = Date.now();
        await this.#persistenceProvider.transaction(async () => {
          for (const scored of batch) {
            const id = idByDomain.get(scored.domain)!;
            await this.#scoringRepo.insert(id, result.runId, scored.scoreResult!);
            scoresPersisted++;
          }
        });
        const elapsed = Date.now() - start;
        if (
          elapsed > PERSISTENCE_BATCH_SLOW_THRESHOLD_MS &&
          batchSize > PERSISTENCE_BATCH_SIZE_MIN
        ) {
          batchSize = Math.max(PERSISTENCE_BATCH_SIZE_MIN, Math.floor(batchSize / 2));
        } else if (
          elapsed < PERSISTENCE_BATCH_FAST_THRESHOLD_MS &&
          batchSize < PERSISTENCE_BATCH_SIZE_MAX
        ) {
          batchSize = Math.min(PERSISTENCE_BATCH_SIZE_MAX, batchSize * 2);
        }
      }

      persistence = { candidatesPersisted, scoresPersisted };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.#runsRepo.complete(runRowId, {
        finishedAt: new Date().toISOString(),
        totalDurationMs: Date.now() - startedMs,
        stageSummary: result.stageSummary,
        resultsSummary: emptyResults(),
        error: `Persistence failed: ${message}`,
      });
      throw err;
    }

    await this.#persistStageMetrics(runRowId, result);

    const totalDurationMs = Date.now() - startedMs;

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

    await this.#runsRepo.complete(runRowId, {
      finishedAt: new Date().toISOString(),
      totalDurationMs,
      stageSummary: result.stageSummary,
      resultsSummary: buildResultsSummary(result, persistence),
    });

    const pipelineResult: PipelineRunResult = {
      ...result,
      persistence,
      startedAt,
      runRowId,
    };

    if (this.#onRunComplete) {
      try {
        await Promise.race([
          Promise.resolve(this.#onRunComplete(pipelineResult, options)),
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error('onRunComplete hook timed out after 10s')),
              10_000,
            ).unref(),
          ),
        ]);
      } catch (err) {
        logger.error({ err, runId: runRowId }, 'PipelineRunService: onRunComplete hook failed');
      }
    }

    return pipelineResult;
  }

  async #persistStageMetrics(runId: string, result: PipelineResult): Promise<void> {
    const stages: Array<{
      stageName: string;
      passed: number;
      filtered: number;
      durationMs: number;
      error: boolean;
      retries?: number;
      errorCodes?: string[];
    }> = [];

    for (const [name, summary] of Object.entries(result.stageSummary)) {
      const stageErrors = result.stageErrors.filter((e) => e.stageName === name);
      const hasError = stageErrors.length > 0;
      stages.push({
        stageName: name,
        passed: summary.passed,
        filtered: summary.filtered,
        durationMs: summary.durationMs,
        error: hasError,
        retries: hasError ? 1 : 0,
        errorCodes: hasError ? stageErrors.map((e) => e.message.substring(0, 50)) : [],
      });
    }

    if (stages.length > 0) {
      await this.#metricsRepo.insertBatch(runId, stages);
    }
  }
}

function snapshotInputs(input: CandidateGenerationInput): PipelineRunInputs {
  return {
    keywords: input.keywords?.length ?? 0,
    brandableNames: input.brandableNames?.length ?? 0,
    closeoutDomains: input.closeoutDomains?.length ?? 0,
    closeoutEntries: input.closeoutEntries?.length ?? 0,
    domains: input.domains?.length ?? 0,
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
