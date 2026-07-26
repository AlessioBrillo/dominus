import type { FunnelConfig, FunnelEntry, FunnelResult } from '../types/acquisition-funnel.js';
import type { FunnelRepository } from '../db/repositories/funnel-repository.js';
import type { CandidateRepository } from '../db/repositories/candidate-repository.js';
import type { ScoringRepository } from '../db/repositories/scoring-repository.js';
import type { PipelineRunsRepository } from '../db/repositories/pipeline-runs-repository.js';
import { getLogger } from '../logger.js';

const DEFAULT_KELLY_FRACTION = 0.5;
const DEFAULT_MAX_CONCENTRATION_PCT = 0.3;

const logger = getLogger();

interface ScoredCandidate {
  candidate: {
    id?: number | undefined;
    domain: string;
    tld: string;
    source: string;
    status: string;
  };
  score: {
    expectedValue: number;
    confidence: number;
    suggestedBuyMax: number;
    suggestedListPrice: number;
  };
  trademarkClear: boolean;
}

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

    const scored: ScoredCandidate[] = [];

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

    const kellyFraction = config.kellyFraction ?? DEFAULT_KELLY_FRACTION;
    const maxConcentration = config.maxConcentrationPct ?? DEFAULT_MAX_CONCENTRATION_PCT;
    const entries: FunnelEntry[] = [];

    if (kellyFraction > 0) {
      this.#allocateWithKelly(
        capped,
        config.budgetEur,
        kellyFraction,
        maxConcentration,
        runId,
        entries,
      );
    } else {
      this.#allocateGreedy(capped, config.budgetEur, runId, entries);
    }

    const totalExpectedReturn = entries.reduce((sum, e) => sum + e.expectedReturnEur, 0);
    const budgetUsed = entries.reduce((sum, e) => sum + e.budgetAllocationEur, 0);
    const budgetRemaining = config.budgetEur - budgetUsed;
    const avgConfidence =
      entries.length > 0 ? entries.reduce((sum, e) => sum + e.confidence, 0) / entries.length : 0;

    await this.#funnelRepo.deleteByRunId(runId);
    await this.#funnelRepo.insertBatch(entries);

    logger.info(
      {
        runId,
        entriesGenerated: entries.length,
        budgetUsed,
        budgetRemaining: budgetRemaining,
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
        budgetRemainingEur: budgetRemaining,
        totalExpectedReturnEur: totalExpectedReturn,
        expectedRoi: budgetUsed > 0 ? (totalExpectedReturn - budgetUsed) / budgetUsed : 0,
        averageConfidence: avgConfidence,
      },
    };
  }

  #allocateGreedy(
    scored: Array<ScoredCandidate>,
    budget: number,
    runId: string,
    entries: FunnelEntry[],
  ): void {
    let remaining = budget;

    for (const s of scored) {
      if (remaining <= 0) break;

      const allocation = Math.min(s.score.suggestedBuyMax, remaining);
      const expectedReturn = s.score.expectedValue - allocation;

      entries.push(this.#buildEntry(s, runId, allocation, expectedReturn));
      remaining -= allocation;
    }
  }

  #allocateWithKelly(
    scored: Array<ScoredCandidate>,
    budget: number,
    kellyFraction: number,
    maxConcentration: number,
    runId: string,
    entries: FunnelEntry[],
  ): void {
    const maxPerDomain = budget * maxConcentration;
    let remaining = budget;

    for (const s of scored) {
      if (remaining <= 0) break;

      const { expectedValue, confidence, suggestedBuyMax } = s.score;
      if (expectedValue <= suggestedBuyMax) continue;
      if (confidence <= 0) continue;

      const netOdds = (expectedValue - suggestedBuyMax) / suggestedBuyMax;
      const kellyPct = (confidence * netOdds - (1 - confidence)) / netOdds;
      const clampedKelly = Math.max(0, Math.min(kellyPct, 1));

      const rawAllocation = suggestedBuyMax * clampedKelly * kellyFraction;
      const allocation = Math.min(rawAllocation, suggestedBuyMax, maxPerDomain, remaining);

      if (allocation <= 0) continue;

      const expectedReturn = expectedValue - allocation;

      entries.push(this.#buildEntry(s, runId, allocation, expectedReturn));
      remaining -= allocation;
    }

    if (remaining > 0 && entries.length > 0) {
      logger.info(
        { budgetRemaining: remaining, entriesAllocated: entries.length },
        'Kelly allocator finished with surplus budget — greedy pass would allocate remaining',
      );
    }
  }

  #buildEntry(
    s: ScoredCandidate,
    runId: string,
    allocation: number,
    expectedReturn: number,
  ): FunnelEntry {
    return {
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
