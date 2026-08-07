// SPDX-License-Identifier: AGPL-3.0-only
import type { DomainCandidate } from '../types/candidate.js';
import type { CandidateGenerationInput } from './stages/candidate-generation-stage.js';
import type { CandidateGenerationStage } from './stages/candidate-generation-stage.js';
import type { DnsPreFilterStage } from './stages/dns-prefilter-stage.js';
import type { RdapConfirmationStage } from './stages/rdap-confirmation-stage.js';
import type { ScoringStage, ScoredCandidate } from './stages/scoring-stage.js';
import type { TrademarkGateStage } from './stages/trademark-gate-stage.js';
import type { DatabaseProvider } from '../db/provider/interface.js';
import type { LockProvider } from '../types/lock.js';
import { ProviderError } from '../types/errors.js';
import { getLogger } from '../logger.js';
import { resolveTenantId } from '../utils/tenant-context.js';
import type { StageDegradation, StageResult } from './stage.js';
import type { CheckpointStore, StageCheckpoint } from './checkpoint-store.js';
import { getResumeIndex } from './db-checkpoint-store.js';

export interface PipelineMetricsDelegate {
  recordStage(
    stageName: string,
    passed: number,
    filtered: number,
    durationMs: number,
    error: boolean,
    retries?: number,
    errorCodes?: string[],
  ): void;
  recordPipelineRun(totalCandidates: number, recommended: number, durationMs: number): void;
}

const logger = getLogger();

export interface PipelineResult {
  runId: string;
  recommended: ScoredCandidate[];
  scored: ScoredCandidate[];
  allCandidates: DomainCandidate[];
  stageSummary: Record<string, { passed: number; filtered: number; durationMs: number }>;
  totalDurationMs: number;
  stageErrors: StageError[];
  /** True when one or more stages exhausted retries and produced empty results.
   *  The pipeline continued but output is degraded (missing candidates that
   *  would have flowed through the failed stage). */
  degraded: boolean;
  /** Machine-readable reasons for a degraded run. Empty when the run is clean.
   *  Each entry names the stage that failed and how much of its input was
   *  processed before the degradation, so callers can decide whether the
   *  partial output is actionable (e.g. CLI exit code, UI banner). */
  degradedReasons: StageDegradation[];
}

export interface StageError {
  stageName: string;
  message: string;
  candidateCount: number;
  provider?: string;
  isTransient?: boolean;
}

export type { StageDegradation, StageDegradationReason } from './stage.js';

/** Options for the per-stage execution budget.
 *  The budget scales with the number of candidates flowing into the stage, so
 *  large runs are not killed by a fixed timeout, while stalled stages still
 *  degrade instead of blocking the pipeline forever. */
export interface StageBudgetOptions {
  /** Fixed time granted to a stage regardless of input size. */
  baseMs?: number;
  /** Time granted per input candidate. */
  perCandidateMs?: number;
  /** Hard ceiling on the computed budget. */
  capMs?: number;
  /** Extra time granted after the budget fires, during which an abort-aware
   *  stage may still resolve with partial results (harvest window). */
  graceMs?: number;
}

const STAGE_BUDGET_DEFAULT_BASE_MS = 30_000;
const STAGE_BUDGET_DEFAULT_PER_CANDIDATE_MS = 200;
const STAGE_BUDGET_DEFAULT_CAP_MS = 3_600_000;
export const STAGE_BUDGET_DEFAULT_GRACE_MS = 5_000;

export function computeStageBudgetMs(candidateCount: number, options?: StageBudgetOptions): number {
  const baseMs = options?.baseMs ?? STAGE_BUDGET_DEFAULT_BASE_MS;
  const perCandidateMs = options?.perCandidateMs ?? STAGE_BUDGET_DEFAULT_PER_CANDIDATE_MS;
  const capMs = options?.capMs ?? STAGE_BUDGET_DEFAULT_CAP_MS;
  return Math.min(baseMs + candidateCount * perCandidateMs, capMs);
}

/** Thrown when a stage exceeds its budget and does not resolve with partial
 *  results within the grace window. Never retried — the run continues in
 *  degraded mode (see ADR-0037). */
export class StageBudgetExceededError extends Error {
  readonly inputCount: number;

  constructor(inputCount: number, budgetMs: number, label: string) {
    super(
      `Stage '${label}' exceeded its budget of ${budgetMs}ms (input: ${inputCount} candidates)`,
    );
    this.name = 'StageBudgetExceededError';
    this.inputCount = inputCount;
  }
}

export class PipelineTimeoutError extends Error {
  readonly timeoutMs: number;
  readonly elapsedMs: number;

  constructor(timeoutMs: number, elapsedMs: number) {
    super(`Pipeline aborted after ${elapsedMs}ms (timeout: ${timeoutMs}ms)`);
    this.name = 'PipelineTimeoutError';
    this.timeoutMs = timeoutMs;
    this.elapsedMs = elapsedMs;
  }
}

function pipelineLockName(): string {
  return `pipeline_run:${resolveTenantId()}`;
}

/**
 * TTL for the pipeline advisory lock, in milliseconds.
 * Kept intentionally short (2 min) — a heartbeat loop renews it every 60s
 * so the lock only lives ~2 min after the process crashes.
 */
const PIPELINE_LOCK_TTL_MS = 120_000;

/** Heartbeat interval for lock renewal (every 30s, well within the 120s TTL). */
const PIPELINE_LOCK_HEARTBEAT_MS = 30_000;

/**
 * Maximum number of retry attempts for transient stage failures.
 */
const STAGE_RETRY_MAX = 3;

/**
 * Base delay for exponential backoff in milliseconds.
 * Actual delays: 1s, 2s, 4s (with ±20% jitter).
 */
const STAGE_RETRY_BASE_DELAY_MS = 1_000;

/**
 * Error code prefixes that indicate a transient failure eligible for retry.
 */
const TRANSIENT_ERROR_PATTERNS = [
  'ECONNRESET',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ENOTFOUND',
  'SQLITE_BUSY',
  'RATE_LIMITED',
  'TIMEOUT',
  '429',
  '503',
];

export class PipelineOrchestrator {
  #activeTenants: Set<string> = new Set();
  #runControllers: Map<string, AbortController> = new Map();
  #heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  #heartbeatFailures = 0;
  #onStageProgress?: (
    stageName: string,
    passed: number,
    filtered: number,
    durationMs: number,
    error: boolean,
  ) => void;
  /** Called at the start of each run to clear provider caches. */
  #onRunStart?: () => void;

  #lock: LockProvider | null = null;
  #checkpointStore: CheckpointStore | null = null;

  /** Promise-chain mutex that serialises tenant-slot acquisition.
   *  Used only when no distributed lock is configured. */
  #tenantMutex: { promise: Promise<void>; resolve: () => void } = {
    promise: Promise.resolve(),
    resolve: () => undefined,
  };

  constructor(
    private readonly generationStage: CandidateGenerationStage,
    private readonly dnsStage: DnsPreFilterStage,
    private readonly rdapStage: RdapConfirmationStage,
    private readonly scoringStage: ScoringStage,
    private readonly trademarkStage: TrademarkGateStage<ScoredCandidate>,
    private readonly timeoutMs: number = 3_600_000,
    private readonly metrics?: PipelineMetricsDelegate,
    /** Optional DatabaseProvider for advisory lock. When set, the lock
     *  is shared across instances (PostgreSQL) or within a single instance
     *  (SQLite). When unset, falls back to the in-process #running flag. */
    db?: DatabaseProvider,
    /** Optional LockProvider (e.g. RedisLock) that takes precedence over db
     *  for distributed locking. When set, lock operations use this instead
     *  of the DatabaseProvider, enabling cross-process locking without
     *  database contention. See ADR-0033. */
    lockProvider?: LockProvider,
    /** Optional CheckpointStore for incremental pipeline persistence.
     *  When set, the orchestrator saves a checkpoint after each stage
     *  and can resume from the last completed stage on recovery. */
    checkpointStore?: CheckpointStore,
    /** Per-stage execution budget. The budget scales with the number of
     *  candidates flowing into each stage (see {@link computeStageBudgetMs}),
     *  so large runs are not killed by a fixed timeout while stalled stages
     *  still degrade instead of blocking the pipeline. When a stage exceeds
     *  its budget, abort-aware stages are given a short grace window to return
     *  partial results, otherwise the stage degrades with empty results and
     *  the run is marked {@link StageDegradationReason timeout}. */
    private readonly stageBudget: StageBudgetOptions = {},
  ) {
    this.#lock = lockProvider ?? db ?? null;
    this.#checkpointStore = checkpointStore ?? null;
  }

  setOnStageProgress(
    cb: (
      stageName: string,
      passed: number,
      filtered: number,
      durationMs: number,
      error: boolean,
    ) => void,
  ): void {
    this.#onStageProgress = cb;
  }

  /** Register a callback invoked before each pipeline run starts.
   *  Typically used to clear in-memory provider caches so stale DNS
   *  or trademark results are not reused across runs. */
  setOnRunStart(cb: () => void): void {
    this.#onRunStart = cb;
  }

  async run(
    input: CandidateGenerationInput,
    externalRunId?: string,
    externalSignal?: AbortSignal,
  ): Promise<PipelineResult> {
    const tenantId = resolveTenantId();
    const controller = new AbortController();

    // Merge external signal (e.g. from worker shutdown) with internal controller:
    // when either fires, both fire.
    if (externalSignal) {
      if (externalSignal.aborted) {
        // Signal was already aborted before we could listen — abort immediately.
        controller.abort(externalSignal.reason);
      } else {
        externalSignal.addEventListener(
          'abort',
          () => {
            if (!controller.signal.aborted) controller.abort(externalSignal.reason);
          },
          { once: true },
        );
      }
    }

    // ---- Tenant admission: serialised via advisory lock or in-process mutex ----
    if (this.#lock) {
      // Distributed lock — serialises across all instances.
      const acquired = await this.#lock.tryLock(pipelineLockName(), PIPELINE_LOCK_TTL_MS);
      if (!acquired) {
        throw new Error(
          'Pipeline run already in progress on another instance — ' +
            `advisory lock '${pipelineLockName()}' could not be acquired. ` +
            'Retry when the current run completes or expires.',
        );
      }
      // Lock held exclusively — double-check that no local run is active
      // (defensive: should never trigger inside the lock).
      if (this.#activeTenants.has(tenantId)) {
        await this.#lock.unlock(pipelineLockName()).catch(() => {});
        throw new Error(
          `Pipeline run already in progress for tenant '${tenantId}' — concurrent per-tenant runs are not supported on this instance`,
        );
      }
      this.#activeTenants.add(tenantId);
      this.#runControllers.set(tenantId, controller);
      logger.info({ workerId: process.pid }, 'Pipeline advisory lock acquired');
      this.#startHeartbeat();
    } else {
      // No distributed lock — serialise via in-process tenant slot.
      await this.#acquireTenantSlot(tenantId, controller);
    }
    // ---- End tenant admission ----

    try {
      return await this.#runInternal(input, controller, tenantId, externalRunId);
    } finally {
      this.#stopHeartbeat();
      if (this.#lock) {
        await this.#lock.unlock(pipelineLockName()).catch(() => {});
        logger.info({ workerId: process.pid }, 'Pipeline advisory lock released');
      }
      if (this.#checkpointStore && externalRunId) {
        await this.#checkpointStore.clear(externalRunId).catch(() => {});
      }
      this.#runControllers.delete(tenantId);
      this.#activeTenants.delete(tenantId);
    }
  }

  /** Serialised tenant-slot acquisition for the no-lock (in-process) path.
   *  Uses a promise-chain mutex so the {@link #activeTenants} check-then-add
   *  is atomic w.r.t. concurrent {@link run()} calls on the same instance. */
  async #acquireTenantSlot(tenantId: string, controller: AbortController): Promise<void> {
    const prev = this.#tenantMutex.promise;
    let nextResolve!: () => void;
    this.#tenantMutex.promise = new Promise<void>((resolve) => {
      nextResolve = resolve;
    });
    await prev;

    try {
      if (this.#activeTenants.has(tenantId)) {
        throw new Error(
          `Pipeline run already in progress for tenant '${tenantId}' — concurrent per-tenant runs are not supported on this instance`,
        );
      }
      this.#activeTenants.add(tenantId);
      this.#runControllers.set(tenantId, controller);
    } finally {
      nextResolve();
    }
  }

  #startHeartbeat(): void {
    if (this.#heartbeatTimer) return;
    this.#heartbeatFailures = 0;
    this.#heartbeatTimer = setInterval(async () => {
      if (!this.#lock) return;
      const renewed = await this.#lock
        .renewLock(pipelineLockName(), PIPELINE_LOCK_TTL_MS)
        .catch(() => false);
      if (renewed) {
        this.#heartbeatFailures = 0;
      } else {
        this.#heartbeatFailures++;
        if (this.#heartbeatFailures >= 3) {
          logger.error(
            { failures: this.#heartbeatFailures },
            'Pipeline lock heartbeat failed 3 consecutive times — lock may have been lost. Aborting run.',
          );
          for (const [, ac] of this.#runControllers) {
            ac.abort();
          }
        } else {
          logger.warn(
            { failures: this.#heartbeatFailures },
            'Pipeline lock heartbeat transient failure — retrying',
          );
        }
      }
    }, PIPELINE_LOCK_HEARTBEAT_MS).unref();
  }

  async #ensureLockHeld(key: string): Promise<void> {
    if (!this.#lock) return;
    const renewed = await this.#lock
      .renewLock(pipelineLockName(), PIPELINE_LOCK_TTL_MS)
      .catch(() => false);
    if (!renewed) {
      this.#runControllers.get(key)?.abort();
      throw new Error(
        'Pipeline lock lost — another worker may have acquired it. ' +
          'Aborting to prevent split-brain writes.',
      );
    }
  }

  #stopHeartbeat(): void {
    if (this.#heartbeatTimer) {
      clearInterval(this.#heartbeatTimer);
      this.#heartbeatTimer = null;
    }
  }

  async #runInternal(
    input: CandidateGenerationInput,
    controller: AbortController,
    key: string,
    externalRunId?: string,
  ): Promise<PipelineResult> {
    const signal = controller.signal;
    const start = Date.now();

    const runId = externalRunId ?? key;

    this.#onRunStart?.();
    const stageSummary: PipelineResult['stageSummary'] = {};
    const stageErrors: StageError[] = [];
    const degradations: StageDegradation[] = [];
    const isAborted = (): boolean =>
      signal.aborted || (this.timeoutMs > 0 && Date.now() - start >= this.timeoutMs);

    if (isAborted()) throw new PipelineTimeoutError(this.timeoutMs, Date.now() - start);

    // --- Checkpoint resume load ---
    let resumeIndex = -1; // -1 = no resume; N = skip first N stages
    const cpResults: Record<string, StageCheckpoint> = {};

    if (this.#checkpointStore && runId) {
      const cp = await this.#checkpointStore.load(runId);
      if (cp) {
        resumeIndex = getResumeIndex(cp.lastCompletedStage);
        Object.assign(cpResults, cp.allStageResults);
        logger.info(
          { runId, lastCompletedStage: cp.lastCompletedStage, resumeIndex },
          'Pipeline: resuming from checkpoint',
        );
      }
    }

    const saveCheckpoint = (
      stageName: string,
      passed: DomainCandidate[],
      filtered: DomainCandidate[],
      durationMs: number,
    ): void => {
      if (!this.#checkpointStore || !runId) return;
      this.#checkpointStore
        .save(runId, stageName, passed, filtered, durationMs)
        .catch((err: unknown) =>
          logger.warn({ err, stage: stageName }, 'Pipeline: checkpoint save failed'),
        );
    };

    // --- Stage 1: CandidateGeneration ---
    let gen: {
      passed: DomainCandidate[];
      filtered: DomainCandidate[];
      stageName: string;
      durationMs: number;
    };

    if (resumeIndex > 0 && cpResults['CandidateGenerationStage']) {
      const saved = cpResults['CandidateGenerationStage']!;
      gen = {
        passed: saved.passed,
        filtered: saved.filtered,
        stageName: 'CandidateGenerationStage',
        durationMs: saved.durationMs,
      };
      stageSummary[gen.stageName] = {
        passed: gen.passed.length,
        filtered: gen.filtered.length,
        durationMs: gen.durationMs,
      };
      this.#onStageProgress?.(
        gen.stageName,
        gen.passed.length,
        gen.filtered.length,
        gen.durationMs,
        false,
      );
    } else {
      try {
        gen = await this.#withTimeout(
          'CandidateGeneration',
          (s) => this.generationStage.process([input], s, externalRunId),
          start,
          controller,
        );
      } catch (err) {
        logger.error({ err }, 'Pipeline: CandidateGeneration stage fatally failed');
        const errDuration = Date.now() - start;
        return {
          runId: 'unknown',
          recommended: [],
          scored: [],
          allCandidates: [],
          stageSummary: {
            CandidateGeneration: { passed: 0, filtered: 0, durationMs: errDuration },
          },
          totalDurationMs: errDuration,
          stageErrors: [
            {
              stageName: 'CandidateGeneration',
              message: String(err),
              candidateCount: input ? 1 : 0,
            },
          ],
          degraded: true,
          degradedReasons: [],
        };
      }
      stageSummary[gen.stageName] = {
        passed: gen.passed.length,
        filtered: gen.filtered.length,
        durationMs: gen.durationMs,
      };
      this.metrics?.recordStage(
        gen.stageName,
        gen.passed.length,
        gen.filtered.length,
        gen.durationMs,
        false,
      );
      this.#onStageProgress?.(
        gen.stageName,
        gen.passed.length,
        gen.filtered.length,
        gen.durationMs,
        false,
      );
      saveCheckpoint(gen.stageName, gen.passed, gen.filtered, gen.durationMs);
    }
    if (isAborted()) {
      controller.abort();
      throw new PipelineTimeoutError(this.timeoutMs, Date.now() - start);
    }

    // --- Stage 2: DnsPreFilter ---
    await this.#ensureLockHeld(key);
    const dns = await this.#runStageWithCheckpoint(
      1,
      'DnsPreFilter',
      (s) => this.dnsStage.process(gen.passed, s),
      resumeIndex,
      cpResults,
      runId,
      start,
      stageSummary,
      stageErrors,
      degradations,
      gen.passed.length,
      controller,
      key,
    );
    if (dns === null) return this.#abortWithError(runId, stageSummary, stageErrors, start);
    if (isAborted()) {
      controller.abort();
      throw new PipelineTimeoutError(this.timeoutMs, Date.now() - start);
    }

    // --- Stage 3: RdapConfirmation ---
    await this.#ensureLockHeld(key);
    const rdap = await this.#runStageWithCheckpoint(
      2,
      'RdapConfirmation',
      (s) => this.rdapStage.process(dns.passed, s),
      resumeIndex,
      cpResults,
      runId,
      start,
      stageSummary,
      stageErrors,
      degradations,
      dns.passed.length,
      controller,
      key,
    );
    if (rdap === null) return this.#abortWithError(runId, stageSummary, stageErrors, start);
    if (isAborted()) {
      controller.abort();
      throw new PipelineTimeoutError(this.timeoutMs, Date.now() - start);
    }

    // --- Stage 4: Scoring ---
    await this.#ensureLockHeld(key);
    const scoring = await this.#runStageWithCheckpoint(
      3,
      'Scoring',
      (s) => this.scoringStage.process(rdap.passed, s),
      resumeIndex,
      cpResults,
      runId,
      start,
      stageSummary,
      stageErrors,
      degradations,
      rdap.passed.length,
      controller,
      key,
    );
    if (scoring === null) return this.#abortWithError(runId, stageSummary, stageErrors, start);
    if (isAborted()) {
      controller.abort();
      throw new PipelineTimeoutError(this.timeoutMs, Date.now() - start);
    }

    // --- Stage 5: TrademarkGate ---
    await this.#ensureLockHeld(key);
    const trademark = await this.#runStageWithCheckpoint(
      4,
      'TrademarkGate',
      (s) => this.trademarkStage.process(scoring.passed, s),
      resumeIndex,
      cpResults,
      runId,
      start,
      stageSummary,
      stageErrors,
      degradations,
      scoring.passed.length,
      controller,
      key,
    );
    if (trademark === null) return this.#abortWithError(runId, stageSummary, stageErrors, start);

    // --- Assemble final result ---
    const scored: ScoredCandidate[] = [
      ...scoring.filtered,
      ...trademark.passed,
      ...trademark.filtered,
    ];

    const allCandidates: DomainCandidate[] = [
      ...gen.filtered,
      ...dns.filtered,
      ...rdap.filtered,
      ...scoring.filtered,
      ...trademark.filtered,
      ...trademark.passed,
    ];

    this.metrics?.recordPipelineRun(
      allCandidates.length,
      trademark.passed.length,
      Date.now() - start,
    );

    return {
      runId,
      recommended: trademark.passed,
      scored,
      allCandidates,
      stageSummary,
      totalDurationMs: Date.now() - start,
      stageErrors,
      degraded: stageErrors.length > 0 || degradations.length > 0,
      degradedReasons: degradations,
    };
  }

  async #runStageSafe<T>(
    label: string,
    fn: (
      signal: AbortSignal,
    ) => Promise<{ passed: T[]; filtered: T[]; stageName: string; durationMs: number }>,
    startMs: number,
    summary: PipelineResult['stageSummary'],
    errors: StageError[],
    degradations: StageDegradation[],
    inputCount: number,
    controller: AbortController,
    key: string,
  ): Promise<{ passed: T[]; filtered: T[]; stageName: string; durationMs: number } | null> {
    const signal = controller.signal;
    for (let attempt = 1; attempt <= STAGE_RETRY_MAX; attempt++) {
      try {
        await this.#ensureLockHeld(key);
        const { result, timedOut } = await this.#runStageTimed(
          label,
          fn,
          inputCount,
          startMs,
          controller,
        );
        summary[result.stageName] = {
          passed: result.passed.length,
          filtered: result.filtered.length,
          durationMs: result.durationMs,
        };
        this.metrics?.recordStage(
          result.stageName,
          result.passed.length,
          result.filtered.length,
          result.durationMs,
          timedOut,
        );
        this.#onStageProgress?.(
          result.stageName,
          result.passed.length,
          result.filtered.length,
          result.durationMs,
          timedOut,
        );

        if (timedOut) {
          const processed = result.passed.length + result.filtered.length;
          degradations.push({
            stageName: label,
            reason: 'timeout',
            processedCount: processed,
            expectedCount: inputCount,
          });
          logger.warn(
            { label, inputCount, processed },
            `Pipeline: ${label} stage exceeded its budget — continuing with partial results`,
          );
        }

        // Merge degradations reported by the stage itself (fail-closed paths
        // that still produced partial output, e.g. DNS consensus-unverified).
        if (result.degradations !== undefined && result.degradations.length > 0) {
          degradations.push(...result.degradations);
        }

        if (attempt > 1) {
          logger.info({ label, attempt }, 'Pipeline: stage recovered on retry');
        }
        return result;
      } catch (err) {
        if (err instanceof StageBudgetExceededError) {
          degradations.push({
            stageName: label,
            reason: 'timeout',
            processedCount: 0,
            expectedCount: err.inputCount,
          });
          const durationMs = Date.now() - startMs;
          summary[label] = { passed: 0, filtered: 0, durationMs };
          this.metrics?.recordStage(label, 0, 0, durationMs, true, 0, ['STAGE_BUDGET_EXCEEDED']);
          this.#onStageProgress?.(label, 0, 0, durationMs, true);
          logger.error(
            { err, label, inputCount: err.inputCount },
            `Pipeline: ${label} stage exceeded its budget — recovering with empty result`,
          );
          return { passed: [], filtered: [], stageName: label, durationMs };
        }

        const error = err instanceof Error ? err : new Error(String(err));
        const msg = error.message;

        // Only retry on transient errors — fatal errors (bad config, invalid
        // input, aborted signal) fail immediately.
        const isTransient = TRANSIENT_ERROR_PATTERNS.some((p) => msg.includes(p));

        if (!isTransient || attempt >= STAGE_RETRY_MAX || signal.aborted) {
          const totalAttempts = attempt;
          const originalErrorCode =
            err instanceof ProviderError
              ? err.code
              : (TRANSIENT_ERROR_PATTERNS.find((p) => msg.includes(p)) ?? 'UNKNOWN');
          logger.error(
            { err, label, attempt: totalAttempts, maxAttempts: STAGE_RETRY_MAX },
            isTransient
              ? `Pipeline: ${label} stage exhausted retries — recovering with empty result`
              : `Pipeline: ${label} stage fatally failed — recovering with empty result`,
          );
          const stageError: StageError = {
            stageName: label,
            message: msg,
            candidateCount: 0,
            isTransient,
          };
          if (err instanceof ProviderError) {
            stageError.provider = err.provider;
          }
          errors.push(stageError);
          degradations.push({
            stageName: label,
            reason: 'error',
            processedCount: 0,
            expectedCount: inputCount,
            message: msg,
          });
          const durationMs = Date.now() - startMs;
          summary[label] = { passed: 0, filtered: 0, durationMs };
          this.metrics?.recordStage(label, 0, 0, durationMs, true, totalAttempts - 1, [
            originalErrorCode,
          ]);
          this.#onStageProgress?.(label, 0, 0, durationMs, true);
          return { passed: [], filtered: [], stageName: label, durationMs };
        }

        // Exponential backoff with jitter: 1s, 2s, 4s (±20%)
        const delay = Math.min(STAGE_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), 30_000);
        const jitter = delay * (0.8 + Math.random() * 0.4);
        logger.warn(
          { err, label, attempt, delayMs: Math.round(jitter) },
          `Pipeline: ${label} stage transient failure — retrying`,
        );
        await new Promise((resolve) => setTimeout(resolve, jitter));
      }
    }

    return null;
  }

  /** Run a stage with optional checkpoint resume.
   *  If {@link resumeIndex} > {@link index}, the stage is reconstructed from
   *  checkpoint data and the live execution branch is skipped entirely.
   *  Otherwise the stage runs normally and a checkpoint is persisted on success. */
  async #runStageWithCheckpoint<T>(
    index: number,
    label: string,
    fn: (signal: AbortSignal) => Promise<StageResult<T>>,
    resumeIndex: number,
    cpResults: Record<string, StageCheckpoint>,
    runId: string | undefined,
    startMs: number,
    summary: PipelineResult['stageSummary'],
    errors: StageError[],
    degradations: StageDegradation[],
    inputCount: number,
    controller: AbortController,
    key: string,
  ): Promise<StageResult<T> | null> {
    if (resumeIndex > index) {
      const saved = cpResults[label];
      if (saved) {
        const result: StageResult<T> = {
          passed: saved.passed as unknown as T[],
          filtered: saved.filtered as unknown as T[],
          stageName: label,
          durationMs: saved.durationMs,
        };
        summary[label] = {
          passed: result.passed.length,
          filtered: result.filtered.length,
          durationMs: result.durationMs,
        };
        this.#onStageProgress?.(
          label,
          result.passed.length,
          result.filtered.length,
          result.durationMs,
          false,
        );
        return result;
      }
    }

    const result = await this.#runStageSafe(
      label,
      fn,
      startMs,
      summary,
      errors,
      degradations,
      inputCount,
      controller,
      key,
    );
    if (result === null) return null;

    if (this.#checkpointStore && runId) {
      this.#checkpointStore
        .save(
          runId,
          label,
          result.passed as unknown as DomainCandidate[],
          result.filtered as unknown as DomainCandidate[],
          result.durationMs,
        )
        .catch((err: unknown) =>
          logger.warn({ err, stage: label }, 'Pipeline: checkpoint save failed'),
        );
    }

    return result;
  }

  #abortWithError(
    runId: string,
    stageSummary: PipelineResult['stageSummary'],
    stageErrors: StageError[],
    start: number,
  ): PipelineResult {
    return {
      runId,
      recommended: [],
      scored: [],
      allCandidates: [],
      stageSummary,
      totalDurationMs: Date.now() - start,
      stageErrors,
      degraded: true,
      degradedReasons: [],
    };
  }

  /** Run a stage under a candidate-scaled budget with a partial-result harvest
   *  window. When the budget fires the stage's own signal is aborted; an
   *  abort-aware stage may still resolve with the results computed so far
   *  within {@link StageBudgetOptions.graceMs}. If it does, the caller sees
   *  {@code timedOut: true} alongside the partial result. If it does not, a
   *  {@link StageBudgetExceededError} is thrown and the stage degrades empty. */
  async #runStageTimed<T>(
    label: string,
    fn: (signal: AbortSignal) => Promise<StageResult<T>>,
    inputCount: number,
    startMs: number,
    controller: AbortController,
  ): Promise<{ result: StageResult<T>; timedOut: boolean }> {
    const signal = controller.signal;
    const elapsed = Date.now() - startMs;

    // Hard pipeline-level deadline: aborts the whole run.
    if (this.timeoutMs > 0 && elapsed >= this.timeoutMs) {
      controller.abort();
      throw new PipelineTimeoutError(this.timeoutMs, elapsed);
    }

    const budgetMs = computeStageBudgetMs(inputCount, this.stageBudget);
    const graceMs = this.stageBudget.graceMs ?? STAGE_BUDGET_DEFAULT_GRACE_MS;

    let effectiveTimeout = Number.POSITIVE_INFINITY;
    if (this.timeoutMs > 0) effectiveTimeout = Math.min(effectiveTimeout, this.timeoutMs - elapsed);
    if (budgetMs > 0) effectiveTimeout = Math.min(effectiveTimeout, budgetMs);

    if (!Number.isFinite(effectiveTimeout) || effectiveTimeout <= 0) {
      return { result: await fn(signal), timedOut: false };
    }

    const stageController = new AbortController();
    const stageSignal = signal
      ? AbortSignal.any([signal, stageController.signal])
      : stageController.signal;

    return new Promise<{ result: StageResult<T>; timedOut: boolean }>((resolve, reject) => {
      let settled = false;
      let budgetHit = false;

      const settle = (action: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(budgetTimer);
        clearTimeout(graceTimer);
        action();
      };

      const budgetTimer = setTimeout(() => {
        if (settled) return;
        budgetHit = true;
        stageController.abort(new PipelineTimeoutError(effectiveTimeout, effectiveTimeout));
        logger.warn(
          { label, budgetMs: effectiveTimeout, inputCount },
          'Pipeline: stage budget exceeded — aborting stage, harvesting partial results',
        );
      }, effectiveTimeout).unref();

      const graceTimer = setTimeout(() => {
        settle(() => reject(new StageBudgetExceededError(inputCount, effectiveTimeout, label)));
      }, effectiveTimeout + graceMs).unref();

      fn(stageSignal).then(
        (result) => {
          settle(() => resolve({ result, timedOut: budgetHit }));
        },
        (err: unknown) => {
          settle(() => {
            // The stage aborted itself out of the budget (AbortError) — treat
            // it as a budget exhaustion rather than a provider failure.
            const isAbort =
              err instanceof DOMException || (err instanceof Error && err.name === 'AbortError');
            if (budgetHit && isAbort) {
              reject(new StageBudgetExceededError(inputCount, effectiveTimeout, label));
            } else {
              reject(err);
            }
          });
        },
      );
    });
  }

  async #withTimeout<T>(
    label: string,
    fn: (signal: AbortSignal) => Promise<T>,
    startMs: number,
    controller: AbortController,
  ): Promise<T> {
    const signal = controller.signal;
    if (this.timeoutMs <= 0) return fn(signal);

    const elapsed = Date.now() - startMs;
    const remaining = this.timeoutMs - elapsed;
    if (remaining <= 0) {
      controller.abort();
      throw new PipelineTimeoutError(this.timeoutMs, elapsed);
    }

    return raceWithTimeout(fn(signal), remaining, label, signal, controller, false);
  }
}

function raceWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
  signal: AbortSignal,
  abortController: AbortController | null,
  stageLevel: boolean = false,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = Date.now() + timeoutMs;
  let abortHandler: (() => void) | null = null;

  const timeoutPromise = new Promise<never>((_, reject) => {
    abortHandler = (): void => {
      clearTimeout(timer);
      reject(new PipelineTimeoutError(timeoutMs, Date.now() - (deadline - timeoutMs)));
    };

    if (signal.aborted) {
      abortHandler();
      return;
    }

    signal.addEventListener('abort', abortHandler, { once: true });

    timer = setTimeout(() => {
      signal.removeEventListener('abort', abortHandler!);
      abortHandler = null;
      // Stage-level timeout aborts the stage controller (not the pipeline),
      // allowing subsequent stages to run in degraded mode.
      if (!stageLevel) abortController?.abort();
      const elapsed = Date.now() - (deadline - timeoutMs);
      logger.warn({ label, timeoutMs, elapsed, stageLevel }, 'Pipeline stage timed out');
      reject(new PipelineTimeoutError(timeoutMs, elapsed));
    }, timeoutMs).unref();
  });

  return Promise.race([
    promise.finally(() => {
      clearTimeout(timer);
      if (abortHandler) {
        signal.removeEventListener('abort', abortHandler);
      }
    }),
    timeoutPromise,
  ]);
}
