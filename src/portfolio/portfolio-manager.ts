import type { PortfolioEntry, AddPortfolioEntryInput, RenewalClockData } from '../types/portfolio.js';
import type { PortfolioRepository } from '../db/repositories/portfolio-repository.js';
import { computeDropVerdict } from './drop-verdict-engine.js';
import { computeRenewalClock } from './renewal-clock.js';

export interface PortfolioSummary {
  entry: PortfolioEntry;
  renewalClock: RenewalClockData;
}

export class PortfolioManager {
  constructor(
    private readonly repo: PortfolioRepository,
    private readonly scoreThreshold: number = 25,
    private readonly renewalHorizonDays: number = 60,
  ) {}

  add(input: AddPortfolioEntryInput): PortfolioEntry {
    return this.repo.insert(input);
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
      const result = computeDropVerdict(entry, {
        scoreThreshold: this.scoreThreshold,
        renewalHorizonDays: this.renewalHorizonDays,
      });
      if (result.verdict !== entry.verdict) {
        this.repo.updateVerdict(entry.domain, result.verdict, result.reason);
      }
    }
  }

  updateScore(domain: string, score: number, listPrice: number): void {
    this.repo.updateScore(domain, score, listPrice);
  }
}
