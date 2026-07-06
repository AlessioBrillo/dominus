import { escapeHtml } from './escape.js';
import { pageHtml, BASE_CSS_HREF, SITE_NAME, SITE_URL, TWITTER_SITE } from './page-template.js';

interface DomainScore {
  expectedValue: number;
  confidence: number;
  suggestedBuyMax: number;
  suggestedListPrice: number;
  weightedScore: number;
  recommended: boolean;
  scoredAt: string;
}

export function renderDomainPage(
  domain: string,
  score: DomainScore,
  trademark?: { verdict: string; verifiedSources: string[]; matchedMark?: string | null } | null,
): string {
  const verdict = score.recommended ? 'Recommended' : 'Not Recommended';
  const tmStatus =
    trademark?.verdict === 'clear'
      ? 'Clear'
      : trademark?.verdict === 'blocked'
        ? 'Blocked'
        : trademark?.verdict === 'unverified'
          ? 'Unverified'
          : null;

  const title = `${escapeHtml(domain)} — Domain Value & Score | ${SITE_NAME}`;
  const description = `Get the investment score for ${escapeHtml(domain)}: expected value €${score.expectedValue.toFixed(0)}, confidence ${(score.confidence * 100).toFixed(0)}%, weighted score ${score.weightedScore.toFixed(2)}. Free domain appraisal tool.`;
  const canon = `/public/domain/${escapeHtml(domain)}`;
  const ogTitle = `${escapeHtml(domain)} — Domain Investment Score`;
  const ogDescription = `Expected Value: €${score.expectedValue.toFixed(0)} | Confidence: ${(score.confidence * 100).toFixed(0)}% | Weighted Score: ${score.weightedScore.toFixed(2)}`;

  const breadcrumb = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: `${SITE_URL}/` },
      {
        '@type': 'ListItem',
        position: 2,
        name: `Domain: ${domain}`,
        item: `${SITE_URL}/public/domain/${domain}`,
      },
    ],
  };

  const productJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: domain,
    description: 'Domain investment score and appraisal',
    offers: { '@type': 'Offer', price: score.suggestedBuyMax, priceCurrency: 'EUR' },
    ...(score.weightedScore > 0
      ? {
          aggregateRating: {
            '@type': 'AggregateRating',
            ratingValue: (score.weightedScore / 10).toFixed(1),
            bestRating: '10',
            worstRating: '0',
            ratingCount: 1,
          },
        }
      : {}),
  };

  const headExtras = [
    `<meta name="description" content="${description}">`,
    `<link rel="canonical" href="${canon}">`,
    `<meta property="og:title" content="${ogTitle}">`,
    `<meta property="og:description" content="${ogDescription}">`,
    '<meta property="og:type" content="website">',
    `<meta property="og:site_name" content="${SITE_NAME}">`,
    `<meta property="og:url" content="${SITE_URL}${canon}">`,
    '<meta property="og:locale" content="en_US">',
    '<meta name="twitter:card" content="summary_large_image">',
    `<meta name="twitter:site" content="${TWITTER_SITE}">`,
    `<meta name="twitter:title" content="${ogTitle}">`,
    `<meta name="twitter:description" content="${ogDescription}">`,
    `<link rel="alternate" type="application/json" href="/public/domain/${escapeHtml(domain)}">`,
    `<script type="application/ld+json">${JSON.stringify(productJsonLd)}</script>`,
    `<script type="application/ld+json">${JSON.stringify(breadcrumb)}</script>`,
  ].join('\n');

  const tmHtml = tmStatus
    ? `<div><span class="badge ${trademark!.verdict}">Trademark: ${tmStatus}</span></div>`
    : '';

  const bodyContent = [
    '<div class="card">',
    `<h1>${escapeHtml(domain)}</h1>`,
    '<p class="subtitle">Domain Investment Score</p>',
    tmHtml,
    '<div class="grid">',
    `<div class="stat"><div class="stat-label">Expected Value</div><div class="stat-value ${score.expectedValue >= 100 ? 'positive' : ''}">€${score.expectedValue.toFixed(0)}</div></div>`,
    `<div class="stat"><div class="stat-label">Confidence</div><div class="stat-value">${(score.confidence * 100).toFixed(0)}%</div></div>`,
    `<div class="stat"><div class="stat-label">Weighted Score</div><div class="stat-value ${score.weightedScore >= 50 ? 'positive' : 'negative'}">${score.weightedScore.toFixed(2)}</div></div>`,
    `<div class="stat"><div class="stat-label">Verdict</div><div class="stat-value ${score.recommended ? 'positive' : 'negative'}">${verdict}</div></div>`,
    '</div>',
    '<div class="grid">',
    `<div class="stat"><div class="stat-label">Suggested Buy Max</div><div class="stat-value">€${score.suggestedBuyMax.toFixed(0)}</div></div>`,
    `<div class="stat"><div class="stat-label">Suggested List Price</div><div class="stat-value">€${score.suggestedListPrice.toFixed(0)}</div></div>`,
    '</div>',
    '<p class="footer">Free domain appraisal by <a href="https://dominus.app">DOMINUS</a></p>',
    '</div>',
  ].join('\n');

  return pageHtml(title, headExtras, BASE_CSS_HREF, bodyContent);
}
