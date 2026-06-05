import type { PortfolioEntry } from '../types/portfolio.js';
import { Verdict } from '../types/portfolio.js';
import { ScoringEngine } from '../scoring/scoring-engine.js';
import { TrademarkGate, GateVerdict } from '../trademark/trademark-gate.js';
import type { KeywordProvider } from '../providers/keyword/keyword-provider.js';
import type { CompsProvider } from '../providers/comps/comps-provider.js';
import type { TrademarkProvider } from '../providers/trademark/trademark-provider.js';
import type { TrademarkMatch } from '../providers/trademark/trademark-provider.js';
import { vi } from 'vitest';

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

export class PortfolioRescoreService {
  constructor(
    private readonly engine: ScoringEngine,
    private readonly gate: TrademarkGate,
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
}

/** Test helper: stand up a service backed by fakes. The keyword and
 *  comps providers return zero, so the test must inject scores via
 *  the engine. Each test wraps the engine and gate as needed. */
export interface FakeRescoreDeps {
  keyword: KeywordProvider;
  comps: CompsProvider;
  uspto: TrademarkProvider;
  euipo: TrademarkProvider;
}

export function makeFakeRescoreDeps(): FakeRescoreDeps {
  return {
    keyword: { getMetrics: vi.fn().mockResolvedValue({ term: '', monthlySearchVolume: 0, cpc: 0, competition: 0 }) },
    comps: { getSales: vi.fn().mockResolvedValue([]) },
    uspto: { search: vi.fn().mockResolvedValue([]) },
    euipo: { search: vi.fn().mockResolvedValue([]) },
  };
}

export function makeServiceFromFakes(deps: FakeRescoreDeps): {
  service: PortfolioRescoreService;
  engine: ScoringEngine;
  gate: TrademarkGate;
} {
  const engine = new ScoringEngine(deps.keyword, deps.comps);
  const gate = new TrademarkGate(deps.uspto, deps.euipo);
  return { service: new PortfolioRescoreService(engine, gate), engine, gate };
}

/** Test helper: build a PortfolioEntry with sensible defaults. */
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

/** Test helper: return a TrademarkMatch-shaped object. */
export function makeMatch(markName: string, owner: string): TrademarkMatch {
  return { markName, owner, status: 'live', source: 'USPTO' };
}
