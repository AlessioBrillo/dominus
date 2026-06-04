import type { DomainCandidate } from '../types/candidate.js';
import type { CandidateGenerationInput } from './stages/candidate-generation-stage.js';
import type { CandidateGenerationStage } from './stages/candidate-generation-stage.js';
import type { DnsPreFilterStage } from './stages/dns-prefilter-stage.js';
import type { RdapConfirmationStage } from './stages/rdap-confirmation-stage.js';
import type { ScoringStage, ScoredCandidate } from './stages/scoring-stage.js';
import type { TrademarkGateStage } from './stages/trademark-gate-stage.js';

export interface PipelineResult {
  runId: string;
  /** Candidates that are scored AND have trademark clearance — the buy list. */
  recommended: ScoredCandidate[];
  /**
   * All candidates that were scored (recommended or not, TM-blocked or not).
   * Used by the persistence layer to write scoring_runs rows even for non-recommended names.
   */
  scored: ScoredCandidate[];
  /** Every candidate that entered the pipeline, with its final status. */
  allCandidates: DomainCandidate[];
  stageSummary: Record<string, { passed: number; filtered: number; durationMs: number }>;
  totalDurationMs: number;
}

export class PipelineOrchestrator {
  constructor(
    private readonly generationStage: CandidateGenerationStage,
    private readonly dnsStage: DnsPreFilterStage,
    private readonly rdapStage: RdapConfirmationStage,
    private readonly scoringStage: ScoringStage,
    // The gate is generic over ScoredCandidate so scoreResult is preserved.
    private readonly trademarkStage: TrademarkGateStage<ScoredCandidate>,
  ) {}

  async run(input: CandidateGenerationInput): Promise<PipelineResult> {
    const start = Date.now();
    const stageSummary: PipelineResult['stageSummary'] = {};

    // Stage 1 — Candidate generation
    const gen = await this.generationStage.process([input]);
    stageSummary[gen.stageName] = { passed: gen.passed.length, filtered: gen.filtered.length, durationMs: gen.durationMs };
    const runId = gen.passed[0]?.pipelineRunId ?? 'unknown';

    // Stage 2 — DNS pre-filter
    const dns = await this.dnsStage.process(gen.passed);
    stageSummary[dns.stageName] = { passed: dns.passed.length, filtered: dns.filtered.length, durationMs: dns.durationMs };

    // Stage 3 — RDAP confirmation (drops registered + premium names)
    const rdap = await this.rdapStage.process(dns.passed);
    stageSummary[rdap.stageName] = { passed: rdap.passed.length, filtered: rdap.filtered.length, durationMs: rdap.durationMs };

    // Stage 4 — Scoring (heuristic engine produces expected_value / confidence / buy_max)
    const scoring = await this.scoringStage.process(rdap.passed);
    stageSummary[scoring.stageName] = { passed: scoring.passed.length, filtered: scoring.filtered.length, durationMs: scoring.durationMs };

    // Stage 5 — Trademark gate (runs LAST; only on score-recommended names to preserve
    //            rate-limited USPTO/EUIPO calls — Principle 3 + 6).
    const trademark = await this.trademarkStage.process(scoring.passed);
    stageSummary[trademark.stageName] = { passed: trademark.passed.length, filtered: trademark.filtered.length, durationMs: trademark.durationMs };

    // All scored candidates (for persistence): those that passed scoring + those that were
    // then blocked or held at the trademark gate all carry a scoreResult.
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
}
