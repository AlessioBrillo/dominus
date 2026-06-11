import { randomUUID } from 'node:crypto';
import type { PortfolioEntry } from '../types/portfolio.js';
import type { ScoringEngine } from '../scoring/scoring-engine.js';
import { GateVerdict, type TrademarkGate } from '../trademark/trademark-gate.js';
import type { CandidateRepository } from '../db/repositories/candidate-repository.js';
import type { ScoringRepository } from '../db/repositories/scoring-repository.js';
import { CandidateSource, CandidateStatus } from '../types/candidate.js';
import { parseDomain } from '../utils/domain.js';
import { getLogger } from '../logger.js';

export interface RescoreOutcome {
  domain: string;
  weightedScore: number;
  calibratedScore: number;
  suggestedListPrice: number;
  expectedValue: number;
  confidence: number;
  trademarkClear: boolean;
  trademarkVerdict: GateVerdict;
  verifiedSources: string[];
  matchedMark?: string | undefined;
  error?: string | undefined;
}

export interface RescoreSummary {
  results: RescoreOutcome[];
  totalDurationMs: number;
}

export const RESCORE_RUN_ID_PREFIX = 'portfolio-rescore-';

/** Default retention: rescore entries older than this are pruned. */
export const RESCORE_RETENTION_DAYS = 180;

function toBatches<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

export class PortfolioRescoreService {
  constructor(
    private readonly engine: ScoringEngine,
    private readonly gate: TrademarkGate,
    private readonly candidateRepo: CandidateRepository,
    private readonly scoringRepo: ScoringRepository,
    private readonly concurrency: number = 5,
    private readonly retentionDays: number = RESCORE_RETENTION_DAYS,
  ) {}

  async rescore(entries: PortfolioEntry[]): Promise<RescoreSummary> {
    const start = Date.now();
    const results: RescoreOutcome[] = [];
    const runId = `${RESCORE_RUN_ID_PREFIX}${randomUUID()}`;

    const batches = toBatches(entries, this.concurrency);
    for (const batch of batches) {
      const entryByIndex = new Map<number, PortfolioEntry>();
      const promises = batch.map((entry, idx) => {
        entryByIndex.set(idx, entry);
        return this.rescoreOne(entry, runId);
      });
      const settled = await Promise.allSettled(promises);

      for (let idx = 0; idx < settled.length; idx++) {
        const result = settled[idx]!;
        if (result.status === 'fulfilled') {
          results.push(result.value);
        } else {
          const errMsg =
            result.reason instanceof Error ? result.reason.message : String(result.reason);
          const entry = entryByIndex.get(idx);
          if (entry !== undefined) {
            results.push({
              domain: entry.domain,
              weightedScore: 0,
              calibratedScore: 0,
              suggestedListPrice: 0,
              expectedValue: 0,
              confidence: 0,
              trademarkClear: false,
              trademarkVerdict: GateVerdict.Unverified,
              verifiedSources: [],
              error: errMsg,
            });
          }
        }
      }
    }

    return { results, totalDurationMs: Date.now() - start };
  }

  /**
   * Prune scoring_runs rows older than the configured retention window
   * whose run_id starts with the rescore prefix. Called on scheduler or
   * explicitly via CLI maintenance.
   */
  pruneRetention(): number {
    const cutoff = new Date(Date.now() - this.retentionDays * 24 * 60 * 60 * 1000).toISOString();
    const prefix = `${RESCORE_RUN_ID_PREFIX}%`;
    const pruned = this.scoringRepo.pruneByRunIdPrefix(prefix, cutoff);
    getLogger().info(
      { pruned, retentionDays: this.retentionDays },
      'Pruned stale rescore scoring_runs',
    );
    return pruned;
  }

  private async rescoreOne(entry: PortfolioEntry, runId: string): Promise<RescoreOutcome> {
    try {
      const score = await this.engine.score({
        domain: entry.domain,
        tld: entry.tld,
        sld: parseDomain(entry.domain).sld,
        isCloseout: false,
        renewalCost: entry.renewalCost,
      });

      const gate = await this.gate.check(entry.domain);

      const candidateId = this.ensureRescoreCandidate(entry);
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

  private ensureRescoreCandidate(entry: PortfolioEntry): number {
    this.candidateRepo.upsert({
      domain: entry.domain,
      tld: entry.tld,
      source: CandidateSource.PortfolioRescore,
      status: CandidateStatus.Scored,
      isPremium: false,
      pipelineRunId: RESCORE_RUN_ID_PREFIX + entry.domain,
    });
    const row = this.candidateRepo.findByDomain(entry.domain);
    if (row === null || row.id === undefined) {
      throw new Error(
        `Failed to upsert rescore candidate for ${entry.domain} — upsert succeeded but no row found`,
      );
    }
    return row.id;
  }
}
