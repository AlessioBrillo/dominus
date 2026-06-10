import { randomUUID } from 'node:crypto';
import type { PortfolioEntry } from '../types/portfolio.js';
import type { ScoringEngine } from '../scoring/scoring-engine.js';
import { GateVerdict, type TrademarkGate } from '../trademark/trademark-gate.js';
import type { CandidateRepository } from '../db/repositories/candidate-repository.js';
import type { ScoringRepository } from '../db/repositories/scoring-repository.js';
import { CandidateSource, CandidateStatus } from '../types/candidate.js';
import { parseDomain } from '../utils/domain.js';

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
  ) {}

  async rescore(entries: PortfolioEntry[]): Promise<RescoreSummary> {
    const start = Date.now();
    const results: RescoreOutcome[] = [];

    const batches = toBatches(entries, this.concurrency);
    for (const batch of batches) {
      const batchResults = await Promise.allSettled(batch.map((entry) => this.rescoreOne(entry)));

      for (const settled of batchResults) {
        if (settled.status === 'fulfilled') {
          results.push(settled.value);
        } else {
          const errMsg =
            settled.reason instanceof Error ? settled.reason.message : String(settled.reason);
          const idx = batchResults.indexOf(settled);
          const entry = batch[idx];
          if (entry) {
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

  private async rescoreOne(entry: PortfolioEntry): Promise<RescoreOutcome> {
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
