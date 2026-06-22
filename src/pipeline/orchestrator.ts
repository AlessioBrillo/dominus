import type { DomainCandidate } from '../types/candidate.js';
import type { CandidateGenerationInput } from './stages/candidate-generation-stage.js';
import type { CandidateGenerationStage } from './stages/candidate-generation-stage.js';
import type { DnsPreFilterStage } from './stages/dns-prefilter-stage.js';
import type { RdapConfirmationStage } from './stages/rdap-confirmation-stage.js';
import type { ScoringStage, ScoredCandidate } from './stages/scoring-stage.js';
import type { TrademarkGateStage } from './stages/trademark-gate-stage.js';
import { ProviderError } from '../types/errors.js';
import { getLogger } from '../logger.js';

export interface PipelineMetricsDelegate {
  recordStage(
    stageName: string,
    passed: number,
    filtered: number,
    durationMs: number,
    error: boolean,
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

export class PipelineOrchestrator {
  #abortController: AbortController | null = null;
  #running: boolean = false;
  #onStageProgress?: (
    stageName: string,
    passed: number,
    filtered: number,
    durationMs: number,
    error: boolean,
  ) => void;

  constructor(
    private readonly generationStage: CandidateGenerationStage,
    private readonly dnsStage: DnsPreFilterStage,
    private readonly rdapStage: RdapConfirmationStage,
    private readonly scoringStage: ScoringStage,
    private readonly trademarkStage: TrademarkGateStage<ScoredCandidate>,
    private readonly timeoutMs: number = 3_600_000,
    private readonly metrics?: PipelineMetricsDelegate,
  ) {}

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

  async run(input: CandidateGenerationInput): Promise<PipelineResult> {
    if (this.#running) {
      throw new Error(
        'Pipeline run already in progress — concurrent runs are not supported on this instance',
      );
    }
    this.#running = true;

    try {
      return await this.#runInternal(input);
    } finally {
      this.#running = false;
    }
  }

  async #runInternal(input: CandidateGenerationInput): Promise<PipelineResult> {
    this.#abortController = new AbortController();
    const signal = this.#abortController.signal;
    const start = Date.now();
    const stageSummary: PipelineResult['stageSummary'] = {};
    const stageErrors: StageError[] = [];
    const aborted = (): boolean =>
      signal.aborted || (this.timeoutMs > 0 && Date.now() - start >= this.timeoutMs);

    if (aborted()) throw new PipelineTimeoutError(this.timeoutMs, Date.now() - start);

    let gen: {
      passed: DomainCandidate[];
      filtered: DomainCandidate[];
      stageName: string;
      durationMs: number;
    };
    try {
      gen = await this.#withTimeout(
        'CandidateGeneration',
        (s) => this.generationStage.process([input], s),
        start,
        signal,
      );
    } catch (err) {
      logger.error({ err }, 'Pipeline: CandidateGeneration stage fatally failed');
      return {
        runId: 'unknown',
        recommended: [],
        scored: [],
        allCandidates: [],
        stageSummary: {
          CandidateGeneration: { passed: 0, filtered: 0, durationMs: Date.now() - start },
        },
        totalDurationMs: Date.now() - start,
        stageErrors: [
          { stageName: 'CandidateGeneration', message: String(err), candidateCount: 0 },
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
    const runId = gen.passed[0]?.pipelineRunId ?? 'unknown';
    if (aborted()) {
      this.#abortController.abort();
      throw new PipelineTimeoutError(this.timeoutMs, Date.now() - start);
    }

    const dns = await this.#runStageSafe(
      'DnsPreFilter',
      (s) => this.dnsStage.process(gen.passed, s),
      start,
      stageSummary,
      stageErrors,
      signal,
    );
    if (dns === null) return this.#abortWithError(runId, stageSummary, stageErrors, start);
    if (aborted()) {
      this.#abortController.abort();
      throw new PipelineTimeoutError(this.timeoutMs, Date.now() - start);
    }

    const rdap = await this.#runStageSafe(
      'RdapConfirmation',
      (s) => this.rdapStage.process(dns.passed, s),
      start,
      stageSummary,
      stageErrors,
      signal,
    );
    if (rdap === null) return this.#abortWithError(runId, stageSummary, stageErrors, start);
    if (aborted()) {
      this.#abortController.abort();
      throw new PipelineTimeoutError(this.timeoutMs, Date.now() - start);
    }

    const scoring = await this.#runStageSafe(
      'Scoring',
      (s) => this.scoringStage.process(rdap.passed, s),
      start,
      stageSummary,
      stageErrors,
      signal,
    );
    if (scoring === null) return this.#abortWithError(runId, stageSummary, stageErrors, start);
    if (aborted()) {
      this.#abortController.abort();
      throw new PipelineTimeoutError(this.timeoutMs, Date.now() - start);
    }

    const trademark = await this.#runStageSafe(
      'TrademarkGate',
      (s) => this.trademarkStage.process(scoring.passed, s),
      start,
      stageSummary,
      stageErrors,
      signal,
    );
    if (trademark === null) return this.#abortWithError(runId, stageSummary, stageErrors, start);

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

    this.#abortController = null;

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
    signal: AbortSignal,
  ): Promise<{ passed: T[]; filtered: T[]; stageName: string; durationMs: number } | null> {
    try {
      const result = await this.#withTimeout(label, fn, startMs, signal);
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
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(
        { err, label },
        `Pipeline: ${label} stage fatally failed — recovering with empty result`,
      );
      const stageError: StageError = {
        stageName: label,
        message: msg,
        candidateCount: 0,
      };
      if (err instanceof ProviderError) {
        stageError.provider = err.provider;
        stageError.isTransient = true;
      }
      errors.push(stageError);
      const durationMs = Date.now() - startMs;
      summary[label] = { passed: 0, filtered: 0, durationMs };
      this.metrics?.recordStage(label, 0, 0, durationMs, true);
      this.#onStageProgress?.(label, 0, 0, durationMs, true);
      return { passed: [], filtered: [], stageName: label, durationMs };
    }
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
    signal: AbortSignal,
  ): Promise<T> {
    if (this.timeoutMs <= 0) return fn(signal);

    const elapsed = Date.now() - startMs;
    const remaining = this.timeoutMs - elapsed;
    if (remaining <= 0) {
      this.#abortController?.abort();
      throw new PipelineTimeoutError(this.timeoutMs, elapsed);
    }

    return raceWithTimeout(fn(signal), remaining, label, signal, this.#abortController);
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
  const timeout = new Promise<never>((_, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new PipelineTimeoutError(timeoutMs, Date.now() - (deadline - timeoutMs)));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      abortController?.abort();
      const elapsed = Date.now() - (deadline - timeoutMs);
      logger.warn({ label, timeoutMs, elapsed }, 'Pipeline stage timed out');
      reject(new PipelineTimeoutError(timeoutMs, elapsed));
    }, timeoutMs).unref();
  });
  return Promise.race([
    promise.finally(() => {
      clearTimeout(timer);
    }),
    timeout,
  ]);
}
