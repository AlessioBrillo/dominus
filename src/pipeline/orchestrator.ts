import type { DomainCandidate } from '../types/candidate.js';
import type { CandidateGenerationInput } from './stages/candidate-generation-stage.js';
import type { CandidateGenerationStage } from './stages/candidate-generation-stage.js';
import type { DnsPreFilterStage } from './stages/dns-prefilter-stage.js';
import type { RdapConfirmationStage } from './stages/rdap-confirmation-stage.js';
import type { ScoringStage, ScoredCandidate } from './stages/scoring-stage.js';
import type { TrademarkGateStage } from './stages/trademark-gate-stage.js';
import { getLogger } from '../logger.js';

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
  constructor(
    private readonly generationStage: CandidateGenerationStage,
    private readonly dnsStage: DnsPreFilterStage,
    private readonly rdapStage: RdapConfirmationStage,
    private readonly scoringStage: ScoringStage,
    private readonly trademarkStage: TrademarkGateStage<ScoredCandidate>,
    private readonly timeoutMs: number = 3_600_000,
  ) {}

  async run(input: CandidateGenerationInput): Promise<PipelineResult> {
    const start = Date.now();
    const stageSummary: PipelineResult['stageSummary'] = {};
    const stageErrors: StageError[] = [];
    const aborted = (): boolean => this.timeoutMs > 0 && Date.now() - start >= this.timeoutMs;

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
        () => this.generationStage.process([input]),
        start,
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
    const runId = gen.passed[0]?.pipelineRunId ?? 'unknown';
    if (aborted()) throw new PipelineTimeoutError(this.timeoutMs, Date.now() - start);

    const dns = await this.#runStageSafe(
      'DnsPreFilter',
      () => this.dnsStage.process(gen.passed),
      start,
      stageSummary,
      stageErrors,
    );
    if (dns === null) return this.#abortWithError(runId, stageSummary, stageErrors, start);
    if (aborted()) throw new PipelineTimeoutError(this.timeoutMs, Date.now() - start);

    const rdap = await this.#runStageSafe(
      'RdapConfirmation',
      () => this.rdapStage.process(dns.passed),
      start,
      stageSummary,
      stageErrors,
    );
    if (rdap === null) return this.#abortWithError(runId, stageSummary, stageErrors, start);
    if (aborted()) throw new PipelineTimeoutError(this.timeoutMs, Date.now() - start);

    const scoring = await this.#runStageSafe(
      'Scoring',
      () => this.scoringStage.process(rdap.passed),
      start,
      stageSummary,
      stageErrors,
    );
    if (scoring === null) return this.#abortWithError(runId, stageSummary, stageErrors, start);
    if (aborted()) throw new PipelineTimeoutError(this.timeoutMs, Date.now() - start);

    const trademark = await this.#runStageSafe(
      'TrademarkGate',
      () => this.trademarkStage.process(scoring.passed),
      start,
      stageSummary,
      stageErrors,
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
    fn: () => Promise<{ passed: T[]; filtered: T[]; stageName: string; durationMs: number }>,
    startMs: number,
    summary: PipelineResult['stageSummary'],
    errors: StageError[],
  ): Promise<{ passed: T[]; filtered: T[]; stageName: string; durationMs: number } | null> {
    try {
      const result = await this.#withTimeout(label, fn, startMs);
      summary[result.stageName] = {
        passed: result.passed.length,
        filtered: result.filtered.length,
        durationMs: result.durationMs,
      };
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(
        { err, label },
        `Pipeline: ${label} stage fatally failed — recovering with empty result`,
      );
      errors.push({ stageName: label, message: msg, candidateCount: 0 });
      summary[label] = { passed: 0, filtered: 0, durationMs: Date.now() - startMs };
      return { passed: [], filtered: [], stageName: label, durationMs: Date.now() - startMs };
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

  async #withTimeout<T>(label: string, fn: () => Promise<T>, startMs: number): Promise<T> {
    if (this.timeoutMs <= 0) return fn();

    const elapsed = Date.now() - startMs;
    const remaining = this.timeoutMs - elapsed;
    if (remaining <= 0) throw new PipelineTimeoutError(this.timeoutMs, elapsed);

    return raceWithTimeout(fn(), remaining, label);
  }
}

function raceWithTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = Date.now() + timeoutMs;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
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
