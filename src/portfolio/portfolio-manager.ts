import type {
  PortfolioEntry,
  AddPortfolioEntryInput,
  RenewalClockData,
} from '../types/portfolio.js';
import type { PortfolioRepository } from '../db/repositories/portfolio-repository.js';
import { computeDropVerdict, DEFAULT_DROP_VERDICT_CONFIG } from './drop-verdict-engine.js';
import type { DropVerdictConfig } from './drop-verdict-engine.js';
import { computeRenewalClock } from './renewal-clock.js';
import type { PortfolioRescoreService, RescoreSummary } from './portfolio-rescore-service.js';

export interface PortfolioSummary {
  entry: PortfolioEntry;
  renewalClock: RenewalClockData;
}

export class PortfolioManager {
  #rescoreService: PortfolioRescoreService | null = null;
  readonly #dropConfig: DropVerdictConfig;

  constructor(
    private readonly repo: PortfolioRepository,
    scoreThreshold: number = 25,
    renewalHorizonDays: number = 60,
    dropConfig: Partial<DropVerdictConfig> = {},
  ) {
    this.#dropConfig = {
      ...DEFAULT_DROP_VERDICT_CONFIG,
      scoreThreshold,
      renewalHorizonDays,
      ...dropConfig,
    };
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

  add(input: AddPortfolioEntryInput): PortfolioEntry {
    return this.repo.insert(input);
  }

  updateCosts(domain: string, acquisitionCost?: number, renewalCost?: number): void {
    this.repo.updateCosts(domain, acquisitionCost, renewalCost);
  }

  remove(domain: string): void {
    this.repo.delete(domain);
  }

  list(): PortfolioSummary[] {
    return this.repo.findAll().map((entry) => ({
      entry,
      renewalClock: computeRenewalClock(entry),
    }));
  }

  refreshVerdicts(): void {
    for (const entry of this.repo.findAll()) {
      const result = computeDropVerdict(entry, this.#dropConfig);
      if (result.verdict !== entry.verdict) {
        const reasonWithNpv =
          result.npv !== undefined
            ? `${result.reason} (NPV: €${result.npv.toFixed(2)})`
            : result.reason;
        this.repo.updateVerdict(entry.domain, result.verdict, reasonWithNpv);
      }
    }
  }

  updateScore(domain: string, score: number, listPrice: number): void {
    this.repo.updateScore(domain, score, listPrice);
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

    const entries = this.repo.findAll();
    const summary = await this.#rescoreService.rescore(entries);

    for (const r of summary.results) {
      this.repo.updateScore(r.domain, r.calibratedScore, r.suggestedListPrice);
    }

    this.refreshVerdicts();
    return summary;
  }
}
