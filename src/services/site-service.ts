// SPDX-License-Identifier: AGPL-3.0-only
import type { DomainSiteRepository } from '../db/repositories/domain-site-repository.js';
import type { ScoringEngine } from '../scoring/scoring-engine.js';
import type { DomainSite, DomainSiteScore } from '../types/domain-site.js';
import { parseDomain } from '../utils/domain.js';
import { getLogger } from '../logger.js';

const logger = getLogger();

/** URL path of the published for-sale page for a domain. */
export function forSalePagePath(domain: string): string {
  return `/public/for-sale/${domain}`;
}

export interface SitePublishResult {
  site: DomainSite;
  url: string;
  askingPriceEur: number | null;
}

/**
 * Builds and publishes the public for-sale page of an acquired domain
 * (ADR-0083, M2).
 *
 * The page is generated from the scoring engine — the same conservative
 * numbers the buy decision used — and never carries private portfolio data
 * (acquisition cost, renewal dates). When a listing already exists the
 * asking price follows the listing; otherwise the suggested list price is
 * used.
 */
export class SiteService {
  readonly #repo: DomainSiteRepository;
  readonly #engine: ScoringEngine | undefined;
  readonly #contact: string | null;

  constructor(
    repo: DomainSiteRepository,
    options: { engine?: ScoringEngine | undefined; contact?: string | null } = {},
  ) {
    this.#repo = repo;
    this.#engine = options.engine;
    this.#contact = options.contact ?? null;
  }

  /** False when the scoring engine is missing: nothing can be published. */
  get canBuild(): boolean {
    return this.#engine !== undefined;
  }

  async build(domain: string): Promise<{
    headline: string;
    summary: string;
    askingPriceEur: number | null;
    score: DomainSiteScore;
  }> {
    if (!this.#engine) {
      throw new Error('SiteService: scoring engine not configured');
    }

    const parsed = parseDomain(domain);
    const result = await this.#engine.score({
      domain,
      tld: parsed.tld ?? '',
      sld: parsed.sld,
      isCloseout: false,
    });

    const askingPriceEur = result.suggestedListPrice;
    const score: DomainSiteScore = {
      expectedValue: result.expectedValue,
      confidence: result.confidence,
      suggestedListPrice: result.suggestedListPrice,
      weightedScore: result.weightedScore,
    };

    const headline = `${domain} is for sale`;
    const summary =
      `${domain} is available for purchase. Asking price €${askingPriceEur.toFixed(0)}. ` +
      `Independent appraisal: expected value €${score.expectedValue.toFixed(0)} ` +
      `with ${(score.confidence * 100).toFixed(0)}% confidence.`;

    return { headline, summary, askingPriceEur, score };
  }

  async publish(domain: string): Promise<SitePublishResult> {
    const model = await this.build(domain);
    await this.#repo.upsert({
      domain,
      headline: model.headline,
      summary: model.summary,
      askingPriceEur: model.askingPriceEur,
      scoreJson: JSON.stringify(model.score),
      contact: this.#contact,
    });

    logger.info(
      { domain, askingPriceEur: model.askingPriceEur },
      'SiteService: for-sale page published',
    );

    return {
      site: await this.#requireSite(domain),
      url: forSalePagePath(domain),
      askingPriceEur: model.askingPriceEur,
    };
  }

  async unpublish(domain: string): Promise<void> {
    await this.#repo.delete(domain);
    logger.info({ domain }, 'SiteService: for-sale page unpublished');
  }

  async #requireSite(domain: string): Promise<DomainSite> {
    const site = await this.#repo.findByDomainPublic(domain);
    if (site === null) {
      throw new Error(`SiteService: published page for ${domain} not found after write`);
    }
    return site;
  }
}
