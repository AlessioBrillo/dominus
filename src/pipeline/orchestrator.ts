import type { DomainCandidate } from '../types/candidate.js';
import type { CandidateGenerationInput } from './stages/candidate-generation-stage.js';
import type { CandidateGenerationStage } from './stages/candidate-generation-stage.js';
import type { DnsPreFilterStage } from './stages/dns-prefilter-stage.js';
import type { RdapConfirmationStage } from './stages/rdap-confirmation-stage.js';
import type { ScoringStage, ScoredCandidate } from './stages/scoring-stage.js';
import type { TrademarkGateStage } from './stages/trademark-gate-stage.js';

export interface PipelineResult {
  runId: string;
  recommended: ScoredCandidate[];
  scored: ScoredCandidate[];
  allCandidates: DomainCandidate[];
  stageSummary: Record<string, { passed: number; filtered: number; durationMs: number }>;
  totalDurationMs: number;
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
    const aborted = (): boolean => this.timeoutMs > 0 && Date.now() - start >= this.timeoutMs;

    const gen = await this.#withTimeout(
      'CandidateGeneration',
      () => this.generationStage.process([input]),
      start,
    );
    stageSummary[gen.stageName] = {
      passed: gen.passed.length,
      filtered: gen.filtered.length,
      durationMs: gen.durationMs,
    };
    const runId = gen.passed[0]?.pipelineRunId ?? 'unknown';
    if (aborted()) throw new PipelineTimeoutError(this.timeoutMs, Date.now() - start);

    const dns = await this.#withTimeout(
      'DnsPreFilter',
      () => this.dnsStage.process(gen.passed),
      start,
    );
    stageSummary[dns.stageName] = {
      passed: dns.passed.length,
      filtered: dns.filtered.length,
      durationMs: dns.durationMs,
    };
    if (aborted()) throw new PipelineTimeoutError(this.timeoutMs, Date.now() - start);

    const rdap = await this.#withTimeout(
      'RdapConfirmation',
      () => this.rdapStage.process(dns.passed),
      start,
    );
    stageSummary[rdap.stageName] = {
      passed: rdap.passed.length,
      filtered: rdap.filtered.length,
      durationMs: rdap.durationMs,
    };
    if (aborted()) throw new PipelineTimeoutError(this.timeoutMs, Date.now() - start);

    const scoring = await this.#withTimeout(
      'Scoring',
      () => this.scoringStage.process(rdap.passed),
      start,
    );
    stageSummary[scoring.stageName] = {
      passed: scoring.passed.length,
      filtered: scoring.filtered.length,
      durationMs: scoring.durationMs,
    };
    if (aborted()) throw new PipelineTimeoutError(this.timeoutMs, Date.now() - start);

    const trademark = await this.#withTimeout(
      'TrademarkGate',
      () => this.trademarkStage.process(scoring.passed),
      start,
    );
    stageSummary[trademark.stageName] = {
      passed: trademark.passed.length,
      filtered: trademark.filtered.length,
      durationMs: trademark.durationMs,
    };

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
    };
  }

  async #withTimeout<T>(_label: string, fn: () => Promise<T>, startMs: number): Promise<T> {
    if (this.timeoutMs <= 0) return fn();

    const remaining = this.timeoutMs - (Date.now() - startMs);
    if (remaining <= 0) throw new PipelineTimeoutError(this.timeoutMs, Date.now() - startMs);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining).unref();

    try {
      return await fn();
    } finally {
      clearTimeout(timer);
    }
  }
}
