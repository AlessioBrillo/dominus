import { escapeHtml } from './escape.js';
import { pageHtml, BASE_CSS_HREF, SITE_NAME } from './page-template.js';
import { productJsonLd, breadcrumbJsonLd, organizationJsonLd, metaTags } from './jsonld.js';
import type { JsonLdScoreData } from './jsonld.js';

interface DomainScore {
  expectedValue: number;
  confidence: number;
  suggestedBuyMax: number;
  suggestedListPrice: number;
  weightedScore: number;
  recommended: boolean;
  scoredAt: string;
}

function toJsonLd(s: DomainScore, domain: string): JsonLdScoreData {
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

  const jsld = productJsonLd(toJsonLd(score, domain));
  const bc = breadcrumbJsonLd([
    { position: 1, name: 'Home', path: '/' },
    { position: 2, name: `Domain: ${domain}`, path: canon },
  ]);
  const org = organizationJsonLd();

  const headExtras = [
    metaTags({ title, description, canonical: canon, ogTitle, ogDescription }),
    `<meta name="twitter:site" content="@dominusapp">`,
    `<link rel="alternate" type="application/json" href="/public/domain/${escapeHtml(domain)}">`,
    jsld,
    bc,
    org,
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
