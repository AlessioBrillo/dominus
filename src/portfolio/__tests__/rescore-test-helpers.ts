import { vi } from 'vitest';
import { CandidateRepository } from '../../db/repositories/candidate-repository.js';
import { ScoringRepository } from '../../db/repositories/scoring-repository.js';
import type { DatabaseProvider } from '../../db/provider/interface.js';
import type { KeywordProvider } from '../../providers/keyword/keyword-provider.js';
import type { CompsProvider } from '../../providers/comps/comps-provider.js';
import type {
  TrademarkProvider,
  TrademarkMatch,
} from '../../providers/trademark/trademark-provider.js';
import { ScoringEngine } from '../../scoring/scoring-engine.js';
import { TrademarkGate } from '../../trademark/trademark-gate.js';
import type { PortfolioEntry } from '../../types/portfolio.js';
import { Verdict } from '../../types/portfolio.js';
import { PortfolioRescoreService } from '../portfolio-rescore-service.js';

export interface FakeRescoreDeps {
  keyword: KeywordProvider;
  comps: CompsProvider;
  uspto: TrademarkProvider;
  euipo: TrademarkProvider;
  candidateRepo: CandidateRepository;
  scoringRepo: ScoringRepository;
}

export function makeFakeRescoreDeps(db: DatabaseProvider): FakeRescoreDeps {
  const candidateRepo = new CandidateRepository(db);
  const scoringRepo = new ScoringRepository(db);
  return {
    keyword: {
      getMetrics: vi
        .fn()
        .mockResolvedValue({ term: '', monthlySearchVolume: 0, cpc: 0, competition: 0 }),
    },
    comps: { getSales: vi.fn().mockResolvedValue([]) },
    uspto: { search: vi.fn().mockResolvedValue([]) },
    euipo: { search: vi.fn().mockResolvedValue([]) },
    candidateRepo,
    scoringRepo,
  };
}

export function makeServiceFromFakes(deps: FakeRescoreDeps): {
  service: PortfolioRescoreService;
  engine: ScoringEngine;
  gate: TrademarkGate;
} {
  const engine = new ScoringEngine(deps.keyword, deps.comps);
  const gate = new TrademarkGate(deps.uspto, deps.euipo);
  return {
    service: new PortfolioRescoreService(engine, gate, deps.candidateRepo, deps.scoringRepo),
    engine,
    gate,
  };
}

export function makePortfolioEntry(overrides: Partial<PortfolioEntry> = {}): PortfolioEntry {
  return {
    domain: 'example.com',
    tld: '.com',
    acquiredAt: '2025-01-01T00:00:00.000Z',
    renewalDate: '2026-01-01T00:00:00.000Z',
    acquisitionCost: 12,
    renewalCost: 12,
    registrar: 'namecheap',
    verdict: Verdict.Keep,
    ...overrides,
  };
}

export function makeMatch(markName: string, owner: string): TrademarkMatch {
  return { markName, owner, status: 'live', source: 'USPTO' };
}
