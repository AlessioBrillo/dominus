import { randomUUID } from 'node:crypto';
import type { PortfolioEntry } from '../types/portfolio.js';
import type { ScoringEngine } from '../scoring/scoring-engine.js';
import { GateVerdict, type TrademarkGate } from '../trademark/trademark-gate.js';
import type { CandidateRepository } from '../db/repositories/candidate-repository.js';
import type { ScoringRepository } from '../db/repositories/scoring-repository.js';
import { CandidateSource, CandidateStatus } from '../types/candidate.js';

/**
 * Re-evaluates every entry in the operator's portfolio against the
 * current scoring engine and trademark gate. It is the bridge that
 * makes the portfolio verdicts evidence-based (closes the bug where
 * `currentScore` was never written, so every entry with renewal in
 * horizon was incorrectly verdict=Drop).
 *
 * Why this is NOT a run of the full 5-stage pipeline:
 *  - DNS pre-filter would drop every owned domain (they're registered
 *    by definition — we own them).
 *  - RDAP confirmation would re-confirm our own registrar, adding no
 *    new information.
 *  - Stages 1 (generation) and 2-3 (DNS/RDAP) are simply not
 *    applicable to inventory you already hold.
 *  - Stage 4 (scoring) and Stage 5 (TM gate) ARE still run because
 *    keyword/comps data and trademark registrations may have changed
 *    since acquisition.
 *
 * The result of a rescore is a per-domain snapshot (calibrated 0-100
 * score + suggested list price + TM gate verdict). The application
 * layer (PortfolioManager) persists the score/list price fields onto
 * `portfolio_entries` and then refreshes verdicts.
 *
 * ADR-0010 errata (2026-06-07): the rescore now also writes a
 * `scoring_runs` row for each domain, so the backtest point-in-time
 * join (ADR-0008) sees rescore-time predictions. The required
 * `candidate_id` is satisfied by upserting a synthetic candidate
 * (source = 'portfolio_rescore', status = Scored). No new table, no
 * migration: `candidates.source` is a free TEXT column already.
 */
export interface RescoreOutcome {
  domain: string;
  /** Raw weighted score 0-1, before projection to 0-100. */
  weightedScore: number;
  /** 0-100 calibrated score (round(weightedScore * 100)). */
  calibratedScore: number;
  suggestedListPrice: number;
  expectedValue: number;
  confidence: number;
  /** True when the TM gate cleared the domain (Clear verdict). */
  trademarkClear: boolean;
  trademarkVerdict: GateVerdict;
  verifiedSources: string[];
  matchedMark?: string | undefined;
  /** Set when scoring or TM gate failed for this entry. */
  error?: string | undefined;
}

export interface RescoreSummary {
  results: RescoreOutcome[];
  totalDurationMs: number;
}

/**
 * Prefix used for synthetic rescore `run_id` values. Backtest joins
 * key on `scoring_runs.run_id`; a rescore-only row carries this
 * prefix so a future "distinguish pipeline runs from rescores"
 * query is trivial.
 */
export const RESCORE_RUN_ID_PREFIX = 'portfolio-rescore-';

export class PortfolioRescoreService {
  constructor(
    private readonly engine: ScoringEngine,
    private readonly gate: TrademarkGate,
    private readonly candidateRepo: CandidateRepository,
    private readonly scoringRepo: ScoringRepository,
  ) {}

  async rescore(entries: PortfolioEntry[]): Promise<RescoreSummary> {
    const start = Date.now();
    const results: RescoreOutcome[] = [];

    for (const entry of entries) {
      results.push(await this.rescoreOne(entry));
    }

    return { results, totalDurationMs: Date.now() - start };
  }

  private async rescoreOne(entry: PortfolioEntry): Promise<RescoreOutcome> {
    try {
      const score = await this.engine.score({
        domain: entry.domain,
        tld: entry.tld,
        isCloseout: false,
      });

      const gate = await this.gate.check(entry.domain);

      // ADR-0010 errata: persist a scoring_runs row keyed on a
      // synthetic candidate so the backtest point-in-time join sees
      // this prediction. The candidate is created with source =
      // 'portfolio_rescore' and status = 'scored'.
      const candidateId = this.ensureRescoreCandidate(entry);
      const runId = `${RESCORE_RUN_ID_PREFIX}${entry.domain}-${randomUUID()}`;
      this.scoringRepo.insert(candidateId, runId, score);

      return {
        domain: entry.domain,
        weightedScore: score.weightedScore,
        calibratedScore: Math.round(score.weightedScore * 100),
        suggestedListPrice: score.suggestedListPrice,
        expectedValue: score.expectedValue,
        confidence: score.confidence,
        trademarkClear: gate.verdict === GateVerdict.Clear,
        trademarkVerdict: gate.verdict,
        verifiedSources: gate.verifiedSources,
        matchedMark: gate.matchedMark,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        domain: entry.domain,
        weightedScore: 0,
        calibratedScore: 0,
        suggestedListPrice: 0,
        expectedValue: 0,
        confidence: 0,
        trademarkClear: false,
        trademarkVerdict: GateVerdict.Unverified,
        verifiedSources: [],
        error: message,
      };
    }
  }

  /**
   * Return the id of an existing candidate for `entry.domain`, or
   * upsert a synthetic one with `source = portfolio_rescore` and
   * `status = scored`. The candidate row is the FK target required
   * by `scoring_runs.candidate_id`; without it the rescore would
   * have no way to write its prediction snapshot.
   */
  private ensureRescoreCandidate(entry: PortfolioEntry): number {
    const existing = this.candidateRepo.findByDomain(entry.domain);
    if (existing !== null && existing.id !== undefined) {
      return existing.id;
    }
    const inserted = this.candidateRepo.upsert({
      domain: entry.domain,
      tld: entry.tld,
      source: CandidateSource.PortfolioRescore,
      status: CandidateStatus.Scored,
      isPremium: false,
      pipelineRunId: RESCORE_RUN_ID_PREFIX + entry.domain,
    });
    if (inserted.id === undefined) {
      throw new Error(`Failed to upsert rescore candidate for ${entry.domain}`);
    }
    return inserted.id;
  }
}

