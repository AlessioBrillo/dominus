// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AcquisitionFunnelService } from '../acquisition-funnel-service.js';
import type { FunnelConfig } from '../../types/acquisition-funnel.js';
import { CandidateSource, CandidateStatus, type DomainCandidate } from '../../types/candidate.js';

const DEFAULT_CONFIG: FunnelConfig = {
  budgetEur: 1000,
  minConfidence: 0.3,
  minBuyMaxEur: 20,
  maxEntries: 0,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createMockRunsRepo(): any {
  return {
    findById: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    findRecent: vi.fn(),
    findAll: vi.fn(),
    prune: vi.fn(),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createMockCandidateRepo(): any {
  return {
    findByRunId: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    findAll: vi.fn(),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createMockScoringRepo(): any {
  return {
    findByRunId: vi.fn(),
    insert: vi.fn(),
    findLatestByCandidate: vi.fn(),
    pruneByRunIdPrefix: vi.fn(),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createMockFunnelRepo(): any {
  return {
    findByRunId: vi.fn(),
    insertBatch: vi.fn(),
    deleteByRunId: vi.fn(),
    updateStatus: vi.fn(),
  };
}

function makeRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runId: 'run-abc-123',
    startedAt: '2025-01-01T00:00:00Z',
    finishedAt: '2025-01-01T00:05:00Z',
    totalDurationMs: 300000,
    stageSummary: {},
    inputs: { keywords: 0, brandableNames: 0, closeoutDomains: 0, closeoutEntries: 0, domains: 5 },
    resultsSummary: {
      candidatesEvaluated: 5,
      recommended: 3,
      trademarkBlocked: 0,
      unscored: 0,
      errors: 0,
    },
    hostVersion: '0.10.0',
    retainedUntil: '2025-06-01T00:00:00Z',
    error: null,
    ...overrides,
  };
}

function makeCandidate(overrides: Partial<DomainCandidate> = {}): DomainCandidate {
  return {
    id: 1,
    domain: 'example.com',
    tld: '.com',
    source: CandidateSource.KeywordCombo,
    status: CandidateStatus.Recommended,
    dnsStatus: undefined,
    rdapStatus: undefined,
    isPremium: false,
    pipelineRunId: 'run-abc-123',
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeScoreRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    candidate_id: 1,
    run_id: 'run-abc-123',
    expected_value: 500,
    confidence: 0.7,
    suggested_buy_max: 250,
    suggested_list_price: 1500,
    intrinsic_score: 0.6,
    commercial_score: 0.5,
    market_score: 0.4,
    expiry_score: 0.3,
    weighted_score: 0.55,
    recommended: 1,
    signal_scores: '{}',
    scored_at: '2025-01-01T00:04:00Z',
    ...overrides,
  };
}

describe('AcquisitionFunnelService', () => {
  let runsRepo: ReturnType<typeof createMockRunsRepo>;
  let candidateRepo: ReturnType<typeof createMockCandidateRepo>;
  let scoringRepo: ReturnType<typeof createMockScoringRepo>;
  let funnelRepo: ReturnType<typeof createMockFunnelRepo>;
  let svc: AcquisitionFunnelService;

  beforeEach(() => {
    runsRepo = createMockRunsRepo();
    candidateRepo = createMockCandidateRepo();
    scoringRepo = createMockScoringRepo();
    funnelRepo = createMockFunnelRepo();
    svc = new AcquisitionFunnelService(
      funnelRepo,
      candidateRepo,
      scoringRepo,
      runsRepo,
      DEFAULT_CONFIG,
    );
  });

  describe('generateFunnel', () => {
    it('throws when run is not found', async () => {
      runsRepo.findById.mockResolvedValue(null);
      await expect(svc.generateFunnel('nonexistent')).rejects.toThrow(
        'Pipeline run nonexistent not found',
      );
    });

    it('returns empty result when no candidates exist', async () => {
      runsRepo.findById.mockResolvedValue(makeRun());
      candidateRepo.findByRunId.mockResolvedValue([]);

      const result = await svc.generateFunnel('run-abc-123');
      expect(result.entries).toHaveLength(0);
      expect(result.breakdown.totalCandidates).toBe(0);
      expect(result.breakdown.budgetRemainingEur).toBe(1000);
    });

    it('returns empty result when no candidates are recommended', async () => {
      runsRepo.findById.mockResolvedValue(makeRun());
      candidateRepo.findByRunId.mockResolvedValue([
        makeCandidate({ status: CandidateStatus.DnsFiltered }),
      ]);

      const result = await svc.generateFunnel('run-abc-123');
      expect(result.entries).toHaveLength(0);
      expect(result.breakdown.passedFilters).toBe(0);
    });

    it('skips candidates without an id', async () => {
      runsRepo.findById.mockResolvedValue(makeRun());
      candidateRepo.findByRunId.mockResolvedValue([
        makeCandidate({ id: undefined as unknown as number }),
      ]);

      const result = await svc.generateFunnel('run-abc-123');
      expect(result.entries).toHaveLength(0);
      expect(scoringRepo.findByRunId).not.toHaveBeenCalled();
    });

    it('skips candidates without a scoring row', async () => {
      runsRepo.findById.mockResolvedValue(makeRun());
      candidateRepo.findByRunId.mockResolvedValue([makeCandidate({ id: 1 })]);
      scoringRepo.findByRunId.mockResolvedValue(null);

      const result = await svc.generateFunnel('run-abc-123');
      expect(result.entries).toHaveLength(0);
    });

    it('filters candidates below minimum confidence', async () => {
      runsRepo.findById.mockResolvedValue(makeRun());
      candidateRepo.findByRunId.mockResolvedValue([makeCandidate({ id: 1, domain: 'lowconf.io' })]);
      scoringRepo.findByRunId.mockResolvedValue(
        makeScoreRow({ confidence: 0.1, expected_value: 100, suggested_buy_max: 50 }),
      );

      const result = await svc.generateFunnel('run-abc-123');
      expect(result.entries).toHaveLength(0);
    });

    it('filters candidates below minimum buy max', async () => {
      runsRepo.findById.mockResolvedValue(makeRun());
      candidateRepo.findByRunId.mockResolvedValue([makeCandidate({ id: 1, domain: 'cheap.io' })]);
      scoringRepo.findByRunId.mockResolvedValue(
        makeScoreRow({ confidence: 0.5, expected_value: 10, suggested_buy_max: 5 }),
      );

      const result = await svc.generateFunnel('run-abc-123');
      expect(result.entries).toHaveLength(0);
    });

    it('allocates budget with greedy strategy', async () => {
      runsRepo.findById.mockResolvedValue(makeRun());
      candidateRepo.findByRunId.mockResolvedValue([
        makeCandidate({
          id: 1,
          domain: 'best.io',
          tld: '.io',
          source: CandidateSource.KeywordCombo,
        }),
        makeCandidate({
          id: 2,
          domain: 'good.io',
          tld: '.io',
          source: CandidateSource.KeywordCombo,
        }),
      ]);
      scoringRepo.findByRunId
        .mockResolvedValueOnce(
          makeScoreRow({
            candidate_id: 1,
            expected_value: 1000,
            confidence: 0.9,
            suggested_buy_max: 800,
          }),
        )
        .mockResolvedValueOnce(
          makeScoreRow({
            candidate_id: 2,
            expected_value: 200,
            confidence: 0.6,
            suggested_buy_max: 100,
          }),
        );

      const result = await svc.generateFunnel('run-abc-123', { kellyFraction: 0 });

      expect(result.entries).toHaveLength(2);
      expect(result.entries[0]!.domain).toBe('best.io');
      expect(result.entries[0]!.budgetAllocationEur).toBe(800);
      expect(result.entries[1]!.domain).toBe('good.io');
      expect(result.entries[1]!.budgetAllocationEur).toBe(100);
      expect(result.breakdown.budgetUsedEur).toBe(900);
      expect(result.breakdown.budgetRemainingEur).toBe(100);
    });

    it('respects budget limit — stops allocation when budget exhausted', async () => {
      runsRepo.findById.mockResolvedValue(makeRun());
      candidateRepo.findByRunId.mockResolvedValue([
        makeCandidate({ id: 1, domain: 'expensive.com' }),
        makeCandidate({ id: 2, domain: 'cheap.com' }),
      ]);
      scoringRepo.findByRunId
        .mockResolvedValueOnce(
          makeScoreRow({
            candidate_id: 1,
            expected_value: 500,
            confidence: 0.8,
            suggested_buy_max: 1200,
          }),
        )
        .mockResolvedValueOnce(
          makeScoreRow({
            candidate_id: 2,
            expected_value: 100,
            confidence: 0.5,
            suggested_buy_max: 50,
          }),
        );

      const result = await svc.generateFunnel('run-abc-123', { kellyFraction: 0 });

      expect(result.entries).toHaveLength(1);
      expect(result.entries[0]!.domain).toBe('expensive.com');
      expect(result.entries[0]!.budgetAllocationEur).toBe(1000);
      expect(result.breakdown.budgetUsedEur).toBe(1000);
      expect(result.breakdown.budgetRemainingEur).toBe(0);
    });

    it('respects maxEntries limit', async () => {
      runsRepo.findById.mockResolvedValue(makeRun());
      candidateRepo.findByRunId.mockResolvedValue([
        makeCandidate({ id: 1, domain: 'a.com' }),
        makeCandidate({ id: 2, domain: 'b.com' }),
        makeCandidate({ id: 3, domain: 'c.com' }),
      ]);
      scoringRepo.findByRunId
        .mockResolvedValueOnce(
          makeScoreRow({
            candidate_id: 1,
            expected_value: 300,
            confidence: 0.8,
            suggested_buy_max: 200,
          }),
        )
        .mockResolvedValueOnce(
          makeScoreRow({
            candidate_id: 2,
            expected_value: 200,
            confidence: 0.7,
            suggested_buy_max: 150,
          }),
        )
        .mockResolvedValueOnce(
          makeScoreRow({
            candidate_id: 3,
            expected_value: 100,
            confidence: 0.6,
            suggested_buy_max: 80,
          }),
        );

      const result = await svc.generateFunnel('run-abc-123', { maxEntries: 2, kellyFraction: 0 });

      expect(result.entries).toHaveLength(2);
    });

    it('computes correct ROI and average confidence', async () => {
      runsRepo.findById.mockResolvedValue(makeRun());
      candidateRepo.findByRunId.mockResolvedValue([
        makeCandidate({ id: 1, domain: 'roi-test.com' }),
      ]);
      scoringRepo.findByRunId.mockResolvedValue(
        makeScoreRow({
          expected_value: 500,
          confidence: 0.8,
          suggested_buy_max: 200,
        }),
      );

      const result = await svc.generateFunnel('run-abc-123', { kellyFraction: 0 });

      expect(result.breakdown.totalExpectedReturnEur).toBe(300);
      expect(result.breakdown.averageConfidence).toBeCloseTo(0.8, 2);
      expect(result.breakdown.expectedRoi).toBeCloseTo(0.5, 2);
    });

    it('returns zero ROI when no budget is used', async () => {
      runsRepo.findById.mockResolvedValue(makeRun());
      candidateRepo.findByRunId.mockResolvedValue([]);

      const result = await svc.generateFunnel('run-abc-123');

      expect(result.breakdown.expectedRoi).toBe(0);
      expect(result.breakdown.budgetUsedEur).toBe(0);
    });

    it('filters scaled entries with trademarkClear=false', async () => {
      runsRepo.findById.mockResolvedValue(makeRun());
      candidateRepo.findByRunId.mockResolvedValue([
        makeCandidate({ id: 1, domain: 'tm-risk.com', status: CandidateStatus.Scored }),
      ]);
      scoringRepo.findByRunId.mockResolvedValue(
        makeScoreRow({ expected_value: 500, confidence: 0.8, suggested_buy_max: 200 }),
      );

      const result = await svc.generateFunnel('run-abc-123');

      expect(result.entries).toHaveLength(1);
      expect(result.entries[0]!.trademarkClear).toBe(false);
    });

    it('persists funnel entries to the repository', async () => {
      runsRepo.findById.mockResolvedValue(makeRun());
      candidateRepo.findByRunId.mockResolvedValue([
        makeCandidate({
          id: 1,
          domain: 'persist-test.com',
          tld: '.com',
          source: CandidateSource.KeywordCombo,
        }),
      ]);
      scoringRepo.findByRunId.mockResolvedValue(
        makeScoreRow({ expected_value: 500, confidence: 0.8, suggested_buy_max: 200 }),
      );

      await svc.generateFunnel('run-abc-123');

      expect(funnelRepo.deleteByRunId).toHaveBeenCalledWith('run-abc-123');
      expect(funnelRepo.insertBatch).toHaveBeenCalledTimes(1);
      const inserted = funnelRepo.insertBatch.mock.calls[0]![0];
      expect(inserted).toHaveLength(1);
      expect(inserted[0]!.domain).toBe('persist-test.com');
    });

    it('uses overrides from the config parameter', async () => {
      runsRepo.findById.mockResolvedValue(makeRun());
      candidateRepo.findByRunId.mockResolvedValue([
        makeCandidate({ id: 1, domain: 'override.com' }),
      ]);
      scoringRepo.findByRunId.mockResolvedValue(
        makeScoreRow({ expected_value: 100, confidence: 0.5, suggested_buy_max: 50 }),
      );

      const result = await svc.generateFunnel('run-abc-123', { minConfidence: 0.6 });

      expect(result.entries).toHaveLength(0);
    });

    it('includes all scored candidates when maxEntries is 0 (unlimited)', async () => {
      runsRepo.findById.mockResolvedValue(makeRun());
      candidateRepo.findByRunId.mockResolvedValue([
        makeCandidate({ id: 1, domain: 'a.com' }),
        makeCandidate({ id: 2, domain: 'b.com' }),
      ]);
      scoringRepo.findByRunId
        .mockResolvedValueOnce(
          makeScoreRow({
            candidate_id: 1,
            expected_value: 100,
            confidence: 0.5,
            suggested_buy_max: 50,
          }),
        )
        .mockResolvedValueOnce(
          makeScoreRow({
            candidate_id: 2,
            expected_value: 80,
            confidence: 0.4,
            suggested_buy_max: 30,
          }),
        );

      const result = await svc.generateFunnel('run-abc-123', { kellyFraction: 0 });

      expect(result.entries).toHaveLength(2);
    });
  });

  describe('getFunnel', () => {
    it('returns null when run does not exist', async () => {
      runsRepo.findById.mockResolvedValue(null);
      const result = await svc.getFunnel('nonexistent');
      expect(result).toBeNull();
    });

    it('returns funnel data from repository', async () => {
      runsRepo.findById.mockResolvedValue(makeRun());
      funnelRepo.findByRunId.mockResolvedValue([
        {
          id: 1,
          runId: 'run-abc-123',
          domain: 'example.com',
          tld: '.com',
          source: 'manual',
          priorityScore: 450,
          budgetAllocationEur: 200,
          expectedReturnEur: 300,
          expectedValue: 500,
          confidence: 0.7,
          suggestedBuyMax: 250,
          suggestedListPrice: 1500,
          trademarkClear: true,
          status: 'pending' as const,
          createdAt: '2025-01-01T00:05:00Z',
        },
      ]);

      const result = await svc.getFunnel('run-abc-123');

      expect(result).not.toBeNull();
      expect(result!.entries).toHaveLength(1);
      expect(result!.entries[0]!.domain).toBe('example.com');
      expect(result!.breakdown.totalExpectedReturnEur).toBe(300);
      expect(result!.breakdown.budgetUsedEur).toBe(200);
      expect(result!.breakdown.averageConfidence).toBeCloseTo(0.7, 2);
    });
  });
});
