import type { FunnelConfig, FunnelEntry, FunnelResult } from '../types/acquisition-funnel.js';
import type { FunnelRepository } from '../db/repositories/funnel-repository.js';
import type { CandidateRepository } from '../db/repositories/candidate-repository.js';
import type { ScoringRepository } from '../db/repositories/scoring-repository.js';
import type { PipelineRunsRepository } from '../db/repositories/pipeline-runs-repository.js';
import { getLogger } from '../logger.js';

const logger = getLogger();

export class AcquisitionFunnelService {
  readonly #funnelRepo: FunnelRepository;
  readonly #candidateRepo: CandidateRepository;
  readonly #scoringRepo: ScoringRepository;
  readonly #runsRepo: PipelineRunsRepository;
  readonly #defaultConfig: FunnelConfig;

  constructor(
    funnelRepo: FunnelRepository,
    candidateRepo: CandidateRepository,
    scoringRepo: ScoringRepository,
    runsRepo: PipelineRunsRepository,
    defaultConfig: FunnelConfig,
  ) {
    this.#funnelRepo = funnelRepo;
    this.#candidateRepo = candidateRepo;
    this.#scoringRepo = scoringRepo;
    this.#runsRepo = runsRepo;
    this.#defaultConfig = defaultConfig;
  }

  async generateFunnel(runId: string, overrides?: Partial<FunnelConfig>): Promise<FunnelResult> {
    const config: FunnelConfig = { ...this.#defaultConfig, ...overrides };

    const run = await this.#runsRepo.findById(runId);
    if (!run) {
      throw new Error(`Pipeline run ${runId} not found`);
    }

    const candidates = await this.#candidateRepo.findByRunId(runId);
    const recommended = candidates.filter(
      (c) => c.status === 'recommended' || c.status === 'scored',
    );

    if (recommended.length === 0) {
      return {
        runId,
        generatedAt: new Date().toISOString(),
        config,
        entries: [],
        breakdown: {
          totalCandidates: candidates.length,
          passedFilters: 0,
          budgetUsedEur: 0,
          budgetRemainingEur: config.budgetEur,
          totalExpectedReturnEur: 0,
          expectedRoi: 0,
          averageConfidence: 0,
        },
      };
    }

    const scored: Array<{
      candidate: (typeof recommended)[number];
      score: {
        expectedValue: number;
        confidence: number;
        suggestedBuyMax: number;
        suggestedListPrice: number;
      };
      trademarkClear: boolean;
    }> = [];

    for (const candidate of recommended) {
      const dbId = candidate.id;
      if (dbId === undefined) continue;

      const scoreRow = await this.#scoringRepo.findByRunId(runId, dbId);
      if (!scoreRow) continue;

      scored.push({
        candidate,
        score: {
          expectedValue: scoreRow.expected_value,
          confidence: scoreRow.confidence,
          suggestedBuyMax: scoreRow.suggested_buy_max,
          suggestedListPrice: scoreRow.suggested_list_price,
        },
        trademarkClear: candidate.status === 'recommended',
      });
    }

    const passing = scored.filter(
      (s) =>
        s.score.confidence >= config.minConfidence &&
        s.score.suggestedBuyMax >= config.minBuyMaxEur,
    );

    passing.sort((a, b) => {
      const pa = a.score.expectedValue * a.score.confidence;
      const pb = b.score.expectedValue * b.score.confidence;
      return pb - pa;
    });

    const capped = config.maxEntries > 0 ? passing.slice(0, config.maxEntries) : passing;

    let remainingBudget = config.budgetEur;
    const entries: FunnelEntry[] = [];

    for (const s of capped) {
      if (remainingBudget <= 0) break;

      const allocation = Math.min(s.score.suggestedBuyMax, remainingBudget);
      const expectedReturn = s.score.expectedValue - allocation;

      entries.push({
        runId,
        domain: s.candidate.domain,
        tld: s.candidate.tld,
        source: s.candidate.source,
        priorityScore: s.score.expectedValue * s.score.confidence,
        budgetAllocationEur: allocation,
        expectedReturnEur: expectedReturn,
        expectedValue: s.score.expectedValue,
        confidence: s.score.confidence,
        suggestedBuyMax: s.score.suggestedBuyMax,
        suggestedListPrice: s.score.suggestedListPrice,
        trademarkClear: s.trademarkClear,
        status: 'pending',
      });

      remainingBudget -= allocation;
    }

    const totalExpectedReturn = entries.reduce((sum, e) => sum + e.expectedReturnEur, 0);
    const budgetUsed = config.budgetEur - remainingBudget;
    const avgConfidence =
      entries.length > 0 ? entries.reduce((sum, e) => sum + e.confidence, 0) / entries.length : 0;

    await this.#funnelRepo.deleteByRunId(runId);
    await this.#funnelRepo.insertBatch(entries);

    logger.info(
      {
        runId,
        entriesGenerated: entries.length,
        budgetUsed,
        budgetRemaining: remainingBudget,
        totalExpectedReturn,
        totalCandidates: candidates.length,
      },
      'Acquisition funnel generated',
    );

    return {
      runId,
      generatedAt: new Date().toISOString(),
      config,
      entries,
      breakdown: {
        totalCandidates: candidates.length,
        passedFilters: entries.length,
        budgetUsedEur: budgetUsed,
        budgetRemainingEur: remainingBudget,
        totalExpectedReturnEur: totalExpectedReturn,
        expectedRoi: budgetUsed > 0 ? (totalExpectedReturn - budgetUsed) / budgetUsed : 0,
        averageConfidence: avgConfidence,
      },
    };
  }

  async getFunnel(runId: string): Promise<FunnelResult | null> {
    const run = await this.#runsRepo.findById(runId);
    if (!run) return null;

    const entries = await this.#funnelRepo.findByRunId(runId);

    const totalExpectedReturn = entries.reduce((sum, e) => sum + e.expectedReturnEur, 0);
    const budgetUsed = entries.reduce((sum, e) => sum + e.budgetAllocationEur, 0);
    const avgConfidence =
      entries.length > 0 ? entries.reduce((sum, e) => sum + e.confidence, 0) / entries.length : 0;

    return {
      runId,
      generatedAt:
        entries.length > 0
          ? (entries[0]?.createdAt ?? new Date().toISOString())
          : new Date().toISOString(),
      config: this.#defaultConfig,
      entries,
      breakdown: {
        totalCandidates: 0,
        passedFilters: entries.length,
        budgetUsedEur: budgetUsed,
        budgetRemainingEur: 0,
        totalExpectedReturnEur: totalExpectedReturn,
        expectedRoi: budgetUsed > 0 ? (totalExpectedReturn - budgetUsed) / budgetUsed : 0,
        averageConfidence: avgConfidence,
      },
    };
  }
}
