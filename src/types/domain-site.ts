// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Domain site types (ADR-0083, M2).
 *
 * A "domain site" is the public landing page DOMINUS publishes for an
 * acquired domain: the discoverability surface that tells a potential
 * buyer the domain is for sale, at what asking price, and how to make an
 * offer. It is populated by the `site` step of the post-acquisition
 * pipeline and rendered by the public namespace at
 * `/public/for-sale/<domain>`.
 */

export interface DomainSite {
  domain: string;
  headline: string;
  summary: string;
  askingPriceEur: number | null;
  scoreJson: string;
  contact: string | null;
  publishedAt: string;
  updatedAt: string;
}

export interface NewDomainSite {
  domain: string;
  headline: string;
  summary: string;
  askingPriceEur: number | null;
  scoreJson: string;
  contact: string | null;
}

export interface DomainSiteRow {
  domain: string;
  headline: string;
  summary: string;
  asking_price_eur: number | null;
  score_json: string;
  contact: string | null;
  published_at: string;
  updated_at: string;
}

export function domainSiteFromRow(row: DomainSiteRow): DomainSite {
  return {
    domain: row.domain,
    headline: row.headline,
    summary: row.summary,
    askingPriceEur: row.asking_price_eur,
    scoreJson: row.score_json,
    contact: row.contact,
    publishedAt: row.published_at,
    updatedAt: row.updated_at,
  };
}

/** Public snapshot of the score shown on a for-sale page. Never includes
 *  private portfolio data (acquisition cost, renewal dates). */
export interface DomainSiteScore {
  expectedValue: number;
  confidence: number;
  suggestedListPrice: number;
  weightedScore: number;
}
