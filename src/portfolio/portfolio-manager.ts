// SPDX-License-Identifier: AGPL-3.0-only
import type {
  PortfolioEntry,
  AddPortfolioEntryInput,
  RenewalClockData,
} from '../types/portfolio.js';
import { Verdict } from '../types/portfolio.js';
import type { PortfolioRepository } from '../db/repositories/portfolio-repository.js';
import { computeDropVerdict, DEFAULT_DROP_VERDICT_CONFIG } from './drop-verdict-engine.js';
import type { DropVerdictConfig } from './drop-verdict-engine.js';
import { computeRenewalClock } from './renewal-clock.js';
import type { PortfolioRescoreService, RescoreSummary } from './portfolio-rescore-service.js';
import type { PipelineUsageEnforcer } from '../services/pipeline-usage-enforcer.js';
import type { CarryCostSignal } from '../services/portfolio-sustainability-service.js';

export interface PortfolioSummary {
  entry: PortfolioEntry;
  renewalClock: RenewalClockData;
}

export interface PortfolioAddOptions {
  /**
   * Skip the domains_tracked meter when true. Reserved for mandated
   * bookkeeping flows (purchase completion, won-auction acquisition) where
   * the domain is a financial transaction already — blocking the insert on
   * plan allowance would break P&L integrity after money was spent
   * (ADR-0038). Voluntary API/CLI adds always meter.
   */
  skipUsageMeter?: boolean;
}

export class PortfolioManager {
  #rescoreService: PortfolioRescoreService | null = null;
  #carryCostSignal: CarryCostSignal | null = null;
  readonly #dropConfig: DropVerdictConfig;
  readonly #usageEnforcer: PipelineUsageEnforcer | undefined;

  constructor(
    private readonly repo: PortfolioRepository,
    scoreThreshold: number = 25,
    renewalHorizonDays: number = 60,
    dropConfig: Partial<DropVerdictConfig> = {},
    /**
     * Optional domains_tracked guard. When enforcement is disabled it is a
     * no-op; when enabled, every add() atomically consumes one tracked
     * domain unit against the tenant plan (ADR-0038).
     */
    usageEnforcer?: PipelineUsageEnforcer,
  ) {
    this.#dropConfig = {
      ...DEFAULT_DROP_VERDICT_CONFIG,
      scoreThreshold,
      renewalHorizonDays,
      ...dropConfig,
    };
    this.#usageEnforcer = usageEnforcer;
  }

  /**
   * Inject the rescore service. The split is intentional: the manager's
   * default scope is the local portfolio (verdicts, CRUD), which has no
   * need for the scoring engine. The rescore service is wired in by the
   * composition root (cli.ts / index.ts) only on the call path that
   * actually needs it, keeping the manager testable without fakes.
   */
  setRescoreService(service: PortfolioRescoreService): void {
    this.#rescoreService = service;
  }

  getRescoreService(): PortfolioRescoreService | null {
    return this.#rescoreService;
  }

  /**
   * Inject the carry-cost signal (ADR-0083, M5). Like the rescore service,
   * it is wired only where revenue data exists, and its absence changes
   * nothing: verdicts keep coming from the drop engine alone.
   */
  setCarryCostSignal(signal: CarryCostSignal): void {
    this.#carryCostSignal = signal;
  }

  async add(
    input: AddPortfolioEntryInput,
    options: PortfolioAddOptions = {},
  ): Promise<PortfolioEntry> {
    const metered = this.#usageEnforcer?.enabled && !options.skipUsageMeter;
    if (metered) {
      await this.#usageEnforcer!.checkAndRecordTracked(1);
    }
    try {
      return await this.repo.insert(input);
    } catch (err) {
      // Refund the metered unit when the insert failed after the meter ran
      // (duplicate, invalid domain, FK violation) so failed adds never burn
      // allowance (ADR-0038, failure policy). A refund failure must never
      // mask the original insert error.
      if (metered) {
        await this.#usageEnforcer!.refundTracked(1).catch(() => {});
      }
      throw err;
    }
  }

  async updateCosts(domain: string, acquisitionCost?: number, renewalCost?: number): Promise<void> {
    await this.repo.updateCosts(domain, acquisitionCost, renewalCost);
  }

  async updateVerdict(domain: string, verdict: Verdict, reason?: string): Promise<void> {
    await this.repo.updateVerdict(domain, verdict, reason);
  }

  async updateNotes(domain: string, notes: string): Promise<void> {
    await this.repo.updateNotes(domain, notes);
  }

  async remove(domain: string): Promise<void> {
    await this.repo.delete(domain);
  }

  async list(): Promise<PortfolioSummary[]> {
    const entries = await this.repo.findAll();
    return entries.map((entry) => ({
      entry,
      renewalClock: computeRenewalClock(entry),
    }));
  }

  async refreshVerdicts(): Promise<void> {
    const entries = await this.repo.findAll();
    for (const entry of entries) {
      const result = computeDropVerdict(entry, this.#dropConfig);

      // Carry-cost signal (M5): a domain whose ad revenue does not cover
      // its renewal is a Reprice candidate — never an automatic drop,
      // which keeps its human gate. Only Keep verdicts are refined;
      // Drop/Reprice from the engine stand as they are.
      let verdict = result.verdict;
      let reason = result.reason;
      if (verdict === Verdict.Keep && this.#carryCostSignal !== null) {
        const signal = await this.#carryCostSignal.getSignal(entry.domain).catch(() => null);
        if (signal !== null && signal.verdict === 'loss') {
          verdict = Verdict.Reprice;
          reason =
            `Carry cost negative (net €${signal.netAnnualEur.toFixed(2)}/yr: ` +
            `annualised revenue €${signal.annualRevenueEur.toFixed(2)} vs renewal ` +
            `€${signal.renewalCostEur.toFixed(2)}) — reprice or drop at the next renewal`;
        }
      }

      if (verdict !== entry.verdict) {
        const reasonWithNpv =
          result.npv !== undefined ? `${reason} (NPV: €${result.npv.toFixed(2)})` : reason;
        await this.repo.updateVerdict(entry.domain, verdict, reasonWithNpv);
      }
    }
  }

  async updateScore(domain: string, score: number, listPrice: number): Promise<void> {
    await this.repo.updateScore(domain, score, listPrice);
  }

  /**
   * Re-score every portfolio entry against the current engine and
   * trademark gate, persist the new score + list price, then refresh
   * verdicts. This is the operation that makes the drop verdicts
   * evidence-based (closes the bug where `currentScore` defaulted to
   * 0 and every entry within the renewal horizon was marked Drop).
   *
   * Returns the per-domain RescoreSummary from the service so callers
   * (CLI, API) can show the operator exactly what changed.
   */
  async rescoreAll(): Promise<RescoreSummary> {
    if (this.#rescoreService === null) {
      throw new Error('PortfolioRescoreService not configured: call setRescoreService() first');
    }

    const entries = await this.repo.findAll();
    const summary = await this.#rescoreService.rescore(entries);

    for (const r of summary.results) {
      await this.repo.updateScore(r.domain, r.calibratedScore, r.suggestedListPrice);
    }

    await this.refreshVerdicts();
    return summary;
  }
}
