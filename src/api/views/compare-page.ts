import { escapeHtml } from './escape.js';
import { pageHtml, COMPARE_CSS_HREF, SITE_NAME, SITE_URL, TWITTER_SITE } from './page-template.js';

interface CompareScore {
  domain: string;
  score: {
    expectedValue: number;
    confidence: number;
    suggestedBuyMax: number;
    weightedScore: number;
    recommended: boolean;
  };
  trademark: unknown | null;
}

export function renderComparePage(
  domain1: string,
  score1: CompareScore,
  domain2: string,
  score2: CompareScore,
): string {
  const title = `Compare ${escapeHtml(domain1)} vs ${escapeHtml(domain2)} — Domain Scores | ${SITE_NAME}`;
  const description = `Side-by-side comparison of ${escapeHtml(domain1)} (EV: €${score1.score.expectedValue.toFixed(0)}) and ${escapeHtml(domain2)} (EV: €${score2.score.expectedValue.toFixed(0)}). Free domain investment comparison tool.`;
  const canon = `/public/compare/${escapeHtml(domain1)}/${escapeHtml(domain2)}`;
  const ogTitle = `Compare ${escapeHtml(domain1)} vs ${escapeHtml(domain2)}`;
  const ogDescription = `${escapeHtml(domain1)}: €${score1.score.expectedValue.toFixed(0)} EV — ${escapeHtml(domain2)}: €${score2.score.expectedValue.toFixed(0)} EV`;

  const breadcrumb = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: `${SITE_URL}/` },
      {
        '@type': 'ListItem',
        position: 2,
        name: `Compare: ${domain1} vs ${domain2}`,
        item: `${SITE_URL}/public/compare/${domain1}/${domain2}`,
      },
    ],
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
    `<script type="application/ld+json">${JSON.stringify(breadcrumb)}</script>`,
  ].join('\n');

  const col = (d: string, s: CompareScore): string =>
    [
      '<div class="col">',
      `<h2>${escapeHtml(d)}</h2>`,
      `<div class="stat"><div class="stat-label">Expected Value</div><div class="stat-value ${s.score.expectedValue >= 100 ? 'positive' : ''}">€${s.score.expectedValue.toFixed(0)}</div></div>`,
      `<div class="stat"><div class="stat-label">Weighted Score</div><div class="stat-value ${s.score.weightedScore >= 50 ? 'positive' : 'negative'}">${s.score.weightedScore.toFixed(2)}</div></div>`,
      `<div class="stat"><div class="stat-label">Confidence</div><div class="stat-value">${(s.score.confidence * 100).toFixed(0)}%</div></div>`,
      `<div class="stat"><div class="stat-label">Verdict</div><div class="stat-value ${s.score.recommended ? 'positive' : 'negative'}">${s.score.recommended ? 'Buy' : 'Pass'}</div></div>`,
      '</div>',
    ].join('\n');

  const bodyContent = [
    '<h1>Domain Score Comparison</h1>',
    '<div class="row">',
    col(domain1, score1),
    col(domain2, score2),
    '</div>',
    '<p class="footer">Free domain comparison by <a href="https://dominus.app">DOMINUS</a></p>',
  ].join('\n');

  return pageHtml(title, headExtras, COMPARE_CSS_HREF, bodyContent);
}
