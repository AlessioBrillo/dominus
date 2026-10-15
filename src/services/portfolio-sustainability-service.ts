// SPDX-License-Identifier: AGPL-3.0-only
import type { PortfolioRepository } from '../db/repositories/portfolio-repository.js';
import type { PortfolioEntry } from '../types/portfolio.js';
import type { MonetizationRevenueRepository } from '../db/repositories/monetization-revenue-repository.js';
import {
  computeCarryCostVerdict,
  type CarryCostResult,
  type CarryCostVerdict,
} from '../portfolio/carry-cost-verdict.js';
import { getLogger } from '../logger.js';

const logger = getLogger();

/** Signal the PortfolioManager consumes to feed the drop engine (M5). */
export interface CarryCostSignal {
  getSignal(domain: string): Promise<{
    verdict: CarryCostVerdict;
    netAnnualEur: number;
    annualRevenueEur: number;
    renewalCostEur: number;
  } | null>;
}

export interface PortfolioSustainabilityDeps {
  portfolioRepo: PortfolioRepository;
  revenueRepo: MonetizationRevenueRepository;
}

/**
 * Per-domain sustainability verdicts (ADR-0083, M5).
 *
 * Juxtaposes the recorded ad revenue of each portfolio domain with its
 * carry cost (the annual renewal). The verdicts are conservative: less
 * than a month of revenue data is never judged, and a negative carry
 * cost never drops a domain by itself — it feeds the drop engine as a
 * Reprice signal, so the drop decision keeps its human gate.
 */
export class PortfolioSustainabilityService implements CarryCostSignal {
  readonly #portfolioRepo: PortfolioRepository;
  readonly #revenueRepo: MonetizationRevenueRepository;

  constructor(deps: PortfolioSustainabilityDeps) {
    this.#portfolioRepo = deps.portfolioRepo;
    this.#revenueRepo = deps.revenueRepo;
  }

  /** Carry-cost verdict for one portfolio domain, or null when not tracked. */
  async getDomainVerdict(domain: string): Promise<CarryCostResult | null> {
    const entries = await this.#portfolioRepo.findAll();
    const entry: PortfolioEntry | undefined = entries.find((e) => e.domain === domain);
    if (entry === undefined) return null;
    return this.#verdictFor(entry);
  }

  /** Carry-cost verdicts for the whole portfolio. */
  async getAllVerdicts(): Promise<CarryCostResult[]> {
    const entries = await this.#portfolioRepo.findAll();
    const verdicts: CarryCostResult[] = [];
    for (const entry of entries) {
      verdicts.push(await this.#verdictFor(entry));
    }
    return verdicts;
  }

  /** Compact signal for the drop engine; null for non-portfolio domains. */
  async getSignal(domain: string): Promise<{
    verdict: CarryCostVerdict;
    netAnnualEur: number;
    annualRevenueEur: number;
    renewalCostEur: number;
  } | null> {
    const result = await this.getDomainVerdict(domain);
    if (result === null) return null;
    return {
      verdict: result.verdict,
      netAnnualEur: result.netAnnualEur,
      annualRevenueEur: result.annualRevenueEur,
      renewalCostEur: result.annualCarryCostEur,
    };
  }

  async #verdictFor(entry: PortfolioEntry): Promise<CarryCostResult> {
    const first = await this.#revenueRepo.firstRecordDate(entry.domain);
    const totalEur = await this.#revenueRepo.totalSince(entry.domain);
    const daysMonetized =
      first !== null
        ? Math.max(
            0,
            Math.floor((Date.now() - new Date(`${first}T00:00:00Z`).getTime()) / 86400000),
          )
        : 0;

    const result = computeCarryCostVerdict({
      domain: entry.domain,
      revenueEur: totalEur,
      daysMonetized,
      renewalCostEur: entry.renewalCost,
    });

    if (result.verdict === 'loss') {
      logger.warn(
        { domain: entry.domain, netAnnualEur: result.netAnnualEur },
        'PortfolioSustainabilityService: carry cost negative',
      );
    }

    return result;
  }
}
