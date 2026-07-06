import { escapeHtml } from './escape.js';
import { pageHtml, BASE_CSS_HREF, SITE_NAME, SITE_URL, TWITTER_SITE } from './page-template.js';

interface ScoreData {
  slug: string;
  domain: string;
  score: {
    expectedValue: number;
    confidence: number;
    suggestedBuyMax: number;
    suggestedListPrice: number;
    weightedScore: number;
    recommended: boolean;
    scoredAt: string;
  };
  trademark: { verdict: string; verifiedSources: string[]; matchedMark?: string | null } | null;
  viewCount: number;
  createdAt: string;
}

export function renderScorePage(data: ScoreData): string {
  const { score, trademark, domain } = data;
  const verdict = score.recommended ? 'Recommended' : 'Not Recommended';
  const tmStatus =
    trademark?.verdict === 'clear'
      ? 'Clear'
      : trademark?.verdict === 'blocked'
        ? 'Blocked'
        : 'Unverified';
  const canonicalUrl = `/public/s/${data.slug}`;

  const title = `${escapeHtml(domain)} — Domain Score | ${SITE_NAME}`;
  const description = `${escapeHtml(domain)} scored: expected value €${score.expectedValue.toFixed(0)}, confidence ${(score.confidence * 100).toFixed(0)}%, weighted score ${score.weightedScore.toFixed(2)}`;
  const ogTitle = `${escapeHtml(domain)} — Domain Score`;
  const ogDescription = `Expected Value: €${score.expectedValue.toFixed(0)} | Confidence: ${(score.confidence * 100).toFixed(0)}% | Weighted Score: ${score.weightedScore.toFixed(2)}`;

  const breadcrumb = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: `${SITE_URL}/` },
      {
        '@type': 'ListItem',
        position: 2,
        name: `Score: ${domain}`,
        item: `${SITE_URL}/public/s/${data.slug}`,
      },
    ],
  };

  const reviewJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: domain,
    description: 'Domain investment score and analysis',
    offers: { '@type': 'Offer', price: score.suggestedBuyMax, priceCurrency: 'EUR' },
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
      reviewBody: `${domain} scored with ${(score.confidence * 100).toFixed(0)}% confidence. Expected value: €${score.expectedValue.toFixed(0)}.`,
    },
  };

  const headExtras = [
    `<meta name="description" content="${description}">`,
    `<link rel="canonical" href="${canonicalUrl}">`,
    `<meta property="og:title" content="${ogTitle}">`,
    `<meta property="og:description" content="${ogDescription}">`,
    '<meta property="og:type" content="website">',
    `<meta property="og:site_name" content="${SITE_NAME}">`,
    `<meta property="og:url" content="${SITE_URL}${canonicalUrl}">`,
    '<meta property="og:locale" content="en_US">',
    `<meta property="og:image" content="${SITE_URL}/public/s/${data.slug}/og.png">`,
    '<meta property="og:image:width" content="1200">',
    '<meta property="og:image:height" content="630">',
    '<meta name="twitter:card" content="summary_large_image">',
    `<meta name="twitter:site" content="${TWITTER_SITE}">`,
    `<meta name="twitter:title" content="${ogTitle}">`,
    `<meta name="twitter:description" content="EV: €${score.expectedValue.toFixed(0)} | Confidence: ${(score.confidence * 100).toFixed(0)}%">`,
    `<link rel="alternate" type="application/json" href="/public/s/${data.slug}">`,
    `<script type="application/ld+json">${JSON.stringify(reviewJsonLd)}</script>`,
    `<script type="application/ld+json">${JSON.stringify(breadcrumb)}</script>`,
  ].join('\n');

  const bodyContent = [
    '<div class="card">',
    `<h1>${escapeHtml(domain)}</h1>`,
    '<p class="subtitle">Domain Investment Score</p>',
    '<div class="grid">',
    `<div class="stat"><div class="stat-label">Expected Value</div><div class="stat-value ${score.expectedValue >= 100 ? 'positive' : ''}">€${score.expectedValue.toFixed(0)}</div></div>`,
    `<div class="stat"><div class="stat-label">Confidence</div><div class="stat-value">${(score.confidence * 100).toFixed(0)}%</div></div>`,
    `<div class="stat"><div class="stat-label">Weighted Score</div><div class="stat-value ${score.weightedScore >= 50 ? 'positive' : 'negative'}">${score.weightedScore.toFixed(2)}</div></div>`,
    `<div class="stat"><div class="stat-label">Verdict</div><div class="stat-value ${score.recommended ? 'positive' : 'negative'}">${verdict}</div></div>`,
    '</div>',
    trademark
      ? `<div style="margin-bottom:1rem"><span class="badge ${trademark.verdict}">Trademark: ${tmStatus}</span></div>`
      : '',
    '<div class="grid">',
    `<div class="stat"><div class="stat-label">Suggested Buy Max</div><div class="stat-value">€${score.suggestedBuyMax.toFixed(0)}</div></div>`,
    `<div class="stat"><div class="stat-label">Suggested List Price</div><div class="stat-value">€${score.suggestedListPrice.toFixed(0)}</div></div>`,
    '</div>',
    '<p class="footer">Scored with <a href="https://dominus.app">DOMINUS</a></p>',
    '</div>',
  ].join('\n');

  return pageHtml(title, headExtras, BASE_CSS_HREF, bodyContent);
}
