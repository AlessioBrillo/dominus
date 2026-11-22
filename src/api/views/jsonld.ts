// SPDX-License-Identifier: AGPL-3.0-only
import { SITE_NAME } from './page-template.js';
import { escapeHtml } from './escape.js';

export interface JsonLdScoreData {
  domain: string;
  expectedValue: number;
  confidence: number;
  suggestedBuyMax?: number | undefined;
  weightedScore: number;
  recommended: boolean;
  scoredAt: string;
}

function tag(json: Record<string, unknown>): string {
  return `<script type="application/ld+json">${JSON.stringify(json)}</script>`;
}

/**
 * Structured data for a score page.
 *
 * It describes a *dataset*, not a product. An earlier version emitted a
 * `Product` with an `Offer` priced at the suggested buy ceiling and an
 * `AggregateRating` built from the engine's own confidence. That was wrong
 * twice: the buy ceiling is not a price anybody offered, and a confidence
 * score is not a rating from a reviewer. Search engines and readers both
 * treated an automated estimate as a market fact. The estimate is still
 * published, with its date and its meaning.
 */
export function scoreDatasetJsonLd(score: JsonLdScoreData): string {
  const measured: Array<Record<string, unknown>> = [
    {
      '@type': 'PropertyValue',
      name: 'Expected value',
      value: score.expectedValue,
      unitText: 'EUR',
    },
    {
      '@type': 'PropertyValue',
      name: 'Weighted score',
      value: score.weightedScore,
    },
    {
      '@type': 'PropertyValue',
      name: 'Confidence',
      value: Math.round(score.confidence * 100),
      unitText: 'percent',
    },
  ];
  if (score.suggestedBuyMax !== undefined) {
    measured.push({
      '@type': 'PropertyValue',
      name: 'Suggested maximum purchase price',
      value: score.suggestedBuyMax,
      unitText: 'EUR',
    });
  }

  const dataset: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'Dataset',
    name: `DOMINUS automated estimate for ${score.domain}`,
    description: `Automated heuristic estimate for ${score.domain}, produced on ${score.scoredAt.split('T')[0]}. It is an estimate, not an appraisal, not an offer to sell the domain and not investment advice.`,
    creator: { '@type': 'Organization', name: SITE_NAME },
    datePublished: score.scoredAt,
    isAccessibleForFree: true,
    variableMeasured: measured,
  };
  return tag(dataset);
}

export function forSaleOfferJsonLd(site: {
  domain: string;
  headline: string;
  askingPriceEur: number | null;
}): string {
  // A for-sale page is the one place where a price is a real offer: the
  // seller is asking it. The page is published only for a domain in the
  // seller's portfolio, and the offer names the seller's asking price, not
  // the engine's estimate.
  const product: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: site.domain,
    description: site.headline,
    category: 'Domain name',
    ...(site.askingPriceEur !== null
      ? {
          offers: {
            '@type': 'Offer',
            price: site.askingPriceEur,
            priceCurrency: 'EUR',
            availability: 'https://schema.org/InStock',
            url: `/public/for-sale/${site.domain}`,
          },
        }
      : {}),
  };
  return tag(product);
}

export function breadcrumbJsonLd(
  items: Array<{ position: number; name: string; path: string }>,
  siteUrl: string,
): string {
  const breadcrumb: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((i) => ({
      '@type': 'ListItem',
      position: i.position,
      name: i.name,
      item: `${siteUrl}${i.path}`,
    })),
  };
  return tag(breadcrumb);
}

export function compareItemListJsonLd(
  domain1: string,
  s1: JsonLdScoreData,
  domain2: string,
  s2: JsonLdScoreData,
): string {
  const item = (domain: string, s: JsonLdScoreData): Record<string, unknown> => ({
    '@type': 'Dataset',
    name: `DOMINUS automated estimate for ${domain}`,
    description: `Automated heuristic estimate for ${domain}. Not an appraisal, not an offer and not investment advice.`,
    datePublished: s.scoredAt,
    variableMeasured: [
      { '@type': 'PropertyValue', name: 'Expected value', value: s.expectedValue, unitText: 'EUR' },
      {
        '@type': 'PropertyValue',
        name: 'Confidence',
        value: Math.round(s.confidence * 100),
        unitText: 'percent',
      },
    ],
  });

  const itemList: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: `Domain Comparison: ${domain1} vs ${domain2}`,
    description: `Side-by-side automated estimates for ${domain1} and ${domain2}.`,
    numberOfItems: 2,
    itemListElement: [
      { '@type': 'ListItem', position: 1, item: item(domain1, s1) },
      { '@type': 'ListItem', position: 2, item: item(domain2, s2) },
    ],
  };
  return tag(itemList);
}

export function organizationJsonLd(siteUrl: string): string {
  const org: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: SITE_NAME,
    url: siteUrl,
    sameAs: ['https://github.com/AlessioBrillo/dominus'],
  };
  return tag(org);
}

export function metaTags(opts: {
  title: string;
  description: string;
  canonical: string;
  siteUrl: string;
  ogTitle?: string;
  ogDescription?: string;
  ogImage?: string;
}): string {
  const ot = opts.ogTitle ?? opts.title;
  const od = opts.ogDescription ?? opts.description;
  return [
    `<meta name="description" content="${escapeHtml(opts.description)}">`,
    `<link rel="canonical" href="${escapeHtml(opts.canonical)}">`,
    `<meta property="og:title" content="${escapeHtml(ot)}">`,
    `<meta property="og:description" content="${escapeHtml(od)}">`,
    '<meta property="og:type" content="website">',
    `<meta property="og:site_name" content="${SITE_NAME}">`,
    `<meta property="og:url" content="${escapeHtml(opts.siteUrl)}${escapeHtml(opts.canonical)}">`,
    '<meta property="og:locale" content="en_US">',
    ...(opts.ogImage
      ? [
          `<meta property="og:image" content="${opts.ogImage}">`,
          '<meta property="og:image:width" content="1200">',
          '<meta property="og:image:height" content="630">',
        ]
      : []),
    '<meta name="twitter:card" content="summary_large_image">',
    `<meta name="twitter:title" content="${escapeHtml(ot)}">`,
    `<meta name="twitter:description" content="${escapeHtml(od)}">`,
  ].join('\n');
}
