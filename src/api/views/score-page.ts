import { escapeHtml } from './escape.js';
import { pageHtml, BASE_CSS_HREF, SITE_NAME, SITE_URL } from './page-template.js';
import { reviewJsonLd, breadcrumbJsonLd, organizationJsonLd, metaTags } from './jsonld.js';
import type { JsonLdScoreData } from './jsonld.js';

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

function toJsonLd(s: ScoreData['score'], domain: string): JsonLdScoreData {
  return {
    domain,
    expectedValue: s.expectedValue,
    confidence: s.confidence,
    suggestedBuyMax: s.suggestedBuyMax,
    weightedScore: s.weightedScore,
    recommended: s.recommended,
    scoredAt: s.scoredAt,
  };
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
  const ogImage = `${SITE_URL}/public/s/${data.slug}/og.png`;

  const jsld = reviewJsonLd(toJsonLd(score, domain));
  const bc = breadcrumbJsonLd([
    { position: 1, name: 'Home', path: '/' },
    { position: 2, name: `Score: ${domain}`, path: canonicalUrl },
  ]);
  const org = organizationJsonLd();

  const headExtras = [
    metaTags({ title, description, canonical: canonicalUrl, ogTitle, ogDescription, ogImage }),
    `<meta name="twitter:site" content="@dominusapp">`,
    `<link rel="alternate" type="application/json" href="/public/s/${data.slug}">`,
    jsld,
    bc,
    org,
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
