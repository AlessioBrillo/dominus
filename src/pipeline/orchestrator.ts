import type { DomainCandidate } from '../types/candidate.js';
import type { CandidateGenerationInput } from './stages/candidate-generation-stage.js';
import type { CandidateGenerationStage } from './stages/candidate-generation-stage.js';
import type { DnsPreFilterStage } from './stages/dns-prefilter-stage.js';
import type { RdapConfirmationStage } from './stages/rdap-confirmation-stage.js';
import type { ScoringStage, ScoredCandidate } from './stages/scoring-stage.js';
import type { TrademarkGateStage } from './stages/trademark-gate-stage.js';
import type { DatabaseProvider } from '../db/provider/interface.js';
import { ProviderError } from '../types/errors.js';
import { getLogger } from '../logger.js';
import { resolveTenantId } from '../utils/tenant-context.js';
import type { StageResult } from './stage.js';
import type { CheckpointStore, StageCheckpoint } from './checkpoint-store.js';
import { getResumeIndex } from './db-checkpoint-store.js';

export interface LockProvider {
  tryLock(lockName: string, ttlMs: number): Promise<boolean>;
  renewLock(lockName: string, ttlMs: number): Promise<boolean>;
  unlock(lockName: string): Promise<void>;
}

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
}

export interface StageError {
  stageName: string;
  message: string;
  candidateCount: number;
  provider?: string;
  isTransient?: boolean;
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
     *  (SQLite). When unset, falls back to the in-memory #running flag. */
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

  async run(input: CandidateGenerationInput, externalRunId?: string): Promise<PipelineResult> {
    const tenantId = resolveTenantId();

    if (this.#activeTenants.has(tenantId)) {
      throw new Error(
        `Pipeline run already in progress for tenant '${tenantId}' — concurrent per-tenant runs are not supported on this instance`,
      );
    }

    const controller = new AbortController();
    this.#activeTenants.add(tenantId);
    this.#runControllers.set(tenantId, controller);

    if (this.#lock) {
      const acquired = await this.#lock.tryLock(pipelineLockName(), PIPELINE_LOCK_TTL_MS);
      if (!acquired) {
        this.#activeTenants.delete(tenantId);
        this.#runControllers.delete(tenantId);
        throw new Error(
          'Pipeline run already in progress on another instance — ' +
            `advisory lock '${pipelineLockName()}' could not be acquired. ` +
            'Retry when the current run completes or expires.',
        );
      }
      logger.info({ workerId: process.pid }, 'Pipeline advisory lock acquired');
      this.#startHeartbeat();
    }

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

  #startHeartbeat(): void {
    if (this.#heartbeatTimer) return;
    this.#heartbeatTimer = setInterval(async () => {
      if (!this.#lock) return;
      const renewed = await this.#lock
        .renewLock(pipelineLockName(), PIPELINE_LOCK_TTL_MS)
        .catch(() => false);
      if (!renewed) {
        logger.warn('Pipeline lock heartbeat failed — lock may have been lost');
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
      controller,
      key,
    );
    if (dns === null) return this.#abortWithError(runId, stageSummary, stageErrors, start);
    if (isAborted()) {
      controller.abort();
      throw new PipelineTimeoutError(this.timeoutMs, Date.now() - start);
    }

    // --- Stage 3: RdapConfirmation ---
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
      controller,
      key,
    );
    if (rdap === null) return this.#abortWithError(runId, stageSummary, stageErrors, start);
    if (isAborted()) {
      controller.abort();
      throw new PipelineTimeoutError(this.timeoutMs, Date.now() - start);
    }

    // --- Stage 4: Scoring ---
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
      controller,
      key,
    );
    if (scoring === null) return this.#abortWithError(runId, stageSummary, stageErrors, start);
    if (isAborted()) {
      controller.abort();
      throw new PipelineTimeoutError(this.timeoutMs, Date.now() - start);
    }

    // --- Stage 5: TrademarkGate ---
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
    controller: AbortController,
    key: string,
  ): Promise<{ passed: T[]; filtered: T[]; stageName: string; durationMs: number } | null> {
    const signal = controller.signal;
    for (let attempt = 1; attempt <= STAGE_RETRY_MAX; attempt++) {
      try {
        await this.#ensureLockHeld(key);
        const result = await this.#withTimeout(label, fn, startMs, controller);
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
          false,
        );
        this.#onStageProgress?.(
          result.stageName,
          result.passed.length,
          result.filtered.length,
          result.durationMs,
          false,
        );

        if (attempt > 1) {
          logger.info({ label, attempt }, 'Pipeline: stage recovered on retry');
        }
        return result;
      } catch (err) {
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

    const result = await this.#runStageSafe(label, fn, startMs, summary, errors, controller, key);
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
    };
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

    return raceWithTimeout(fn(signal), remaining, label, signal, controller);
  }
}

function raceWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
  signal: AbortSignal,
  abortController: AbortController | null,
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
      abortController?.abort();
      const elapsed = Date.now() - (deadline - timeoutMs);
      logger.warn({ label, timeoutMs, elapsed }, 'Pipeline stage timed out');
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
