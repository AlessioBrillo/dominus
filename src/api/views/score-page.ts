import { escapeHtml } from './escape.js';
import { pageHtml, BASE_CSS } from './page-template.js';

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

  const title = `${escapeHtml(domain)} — Domain Score | DOMINUS`;
  const description = `${escapeHtml(domain)} scored: expected value €${score.expectedValue.toFixed(0)}, confidence ${(score.confidence * 100).toFixed(0)}%, weighted score ${score.weightedScore.toFixed(2)}`;
  const ogTitle = `${escapeHtml(domain)} — Domain Score`;
  const ogDescription = `Expected Value: €${score.expectedValue.toFixed(0)} | Confidence: ${(score.confidence * 100).toFixed(0)}% | Weighted Score: ${score.weightedScore.toFixed(2)}`;

  const headExtras = [
    `<meta name="description" content="${description}">`,
    `<link rel="canonical" href="${canonicalUrl}">`,
    `<meta property="og:title" content="${ogTitle}">`,
    `<meta property="og:description" content="${ogDescription}">`,
    '<meta property="og:type" content="website">',
    '<meta name="twitter:card" content="summary_large_image">',
    `<meta name="twitter:title" content="${ogTitle}">`,
    `<meta name="twitter:description" content="EV: €${score.expectedValue.toFixed(0)} | Confidence: ${(score.confidence * 100).toFixed(0)}%">`,
    `<script type="application/ld+json">${JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'Product',
      name: domain,
      description: 'Domain investment score and analysis',
      offers: { '@type': 'Offer', price: score.suggestedBuyMax, priceCurrency: 'EUR' },
    })}</script>`,
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

  return pageHtml(title, headExtras, BASE_CSS, bodyContent);
}
