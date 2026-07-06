import { SITE_NAME, SITE_URL } from './page-template.js';
import { escapeHtml } from './escape.js';

export interface JsonLdScoreData {
  domain: string;
  expectedValue: number;
  confidence: number;
  suggestedBuyMax: number;
  weightedScore: number;
  recommended: boolean;
  scoredAt: string;
}

function tag(json: Record<string, unknown>): string {
  return `<script type="application/ld+json">${JSON.stringify(json)}</script>`;
}

export function productJsonLd(score: JsonLdScoreData): string {
  const product: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: score.domain,
    description: `Domain investment score and appraisal for ${score.domain}`,
    offers: {
      '@type': 'Offer',
      price: score.suggestedBuyMax,
      priceCurrency: 'EUR',
      availability: 'https://schema.org/InStock',
    },
    aggregateRating: {
      '@type': 'AggregateRating',
      ratingValue: Math.round(score.confidence * 100),
      bestRating: 100,
      worstRating: 0,
      ratingCount: 1,
    },
  };
  return tag(product);
}

export function reviewJsonLd(score: JsonLdScoreData): string {
  const review: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: score.domain,
    description: 'Domain investment score and analysis',
    offers: {
      '@type': 'Offer',
      price: score.suggestedBuyMax,
      priceCurrency: 'EUR',
    },
    review: {
      '@type': 'Review',
      reviewRating: {
        '@type': 'Rating',
        ratingValue: Math.round(score.confidence * 100),
        bestRating: 100,
        worstRating: 0,
      },
      author: { '@type': 'Organization', name: SITE_NAME },
      datePublished: score.scoredAt
        ? score.scoredAt.split('T')[0]
        : new Date().toISOString().split('T')[0],
      reviewBody: `${score.domain} scored with ${(score.confidence * 100).toFixed(0)}% confidence. Expected value: €${score.expectedValue.toFixed(0)}.`,
    },
  };
  return tag(review);
}

export function breadcrumbJsonLd(
  items: Array<{ position: number; name: string; path: string }>,
): string {
  const breadcrumb: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((i) => ({
      '@type': 'ListItem',
      position: i.position,
      name: i.name,
      item: `${SITE_URL}${i.path}`,
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
  const itemList: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: `Domain Comparison: ${domain1} vs ${domain2}`,
    description: `Side-by-side domain investment score comparison between ${domain1} and ${domain2}.`,
    numberOfItems: 2,
    itemListElement: [
      {
        '@type': 'ListItem',
        position: 1,
        item: {
          '@type': 'Product',
          name: domain1,
          offers: { '@type': 'Offer', price: s1.expectedValue, priceCurrency: 'EUR' },
          aggregateRating: {
            '@type': 'AggregateRating',
            ratingValue: Math.round(s1.confidence * 100),
            bestRating: 100,
            worstRating: 0,
            ratingCount: 1,
          },
        },
      },
      {
        '@type': 'ListItem',
        position: 2,
        item: {
          '@type': 'Product',
          name: domain2,
          offers: { '@type': 'Offer', price: s2.expectedValue, priceCurrency: 'EUR' },
          aggregateRating: {
            '@type': 'AggregateRating',
            ratingValue: Math.round(s2.confidence * 100),
            bestRating: 100,
            worstRating: 0,
            ratingCount: 1,
          },
        },
      },
    ],
  };
  return tag(itemList);
}

export function organizationJsonLd(): string {
  const org: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: SITE_NAME,
    url: SITE_URL,
    sameAs: ['https://github.com/AlessioBrillo/dominus'],
  };
  return tag(org);
}

export function metaTags(opts: {
  title: string;
  description: string;
  canonical: string;
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
    `<meta property="og:url" content="${SITE_URL}${escapeHtml(opts.canonical)}">`,
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
