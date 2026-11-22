// SPDX-License-Identifier: AGPL-3.0-only
import { escapeHtml } from './escape.js';
import { pageHtml, BASE_CSS_HREF, SITE_NAME } from './page-template.js';
import { scoreDatasetJsonLd, breadcrumbJsonLd, organizationJsonLd, metaTags } from './jsonld.js';
import type { JsonLdScoreData } from './jsonld.js';

interface DomainScore {
  expectedValue: number;
  confidence: number;
  suggestedBuyMax?: number | undefined;
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
  siteUrl?: string,
): string {
  const site = siteUrl ?? 'https://dominus.app';
  const verdict = score.recommended ? 'Recommended' : 'Not Recommended';
  const tmStatus =
    trademark?.verdict === 'clear'
      ? 'Clear'
      : trademark?.verdict === 'blocked'
        ? 'Blocked'
        : trademark?.verdict === 'unverified'
          ? 'Unverified'
          : null;

  const title = `${escapeHtml(domain)} — Domain Estimate & Score | ${SITE_NAME}`;
  const description = `Automated estimate for ${escapeHtml(domain)}: expected value €${score.expectedValue.toFixed(0)}, confidence ${(score.confidence * 100).toFixed(0)}%, weighted score ${score.weightedScore.toFixed(2)}. An estimate, not an appraisal.`;
  const canon = `/public/domain/${escapeHtml(domain)}`;
  const ogTitle = `${escapeHtml(domain)} — Domain Investment Score`;
  const ogDescription = `Expected Value: €${score.expectedValue.toFixed(0)} | Confidence: ${(score.confidence * 100).toFixed(0)}% | Weighted Score: ${score.weightedScore.toFixed(2)}`;

  const jsld = scoreDatasetJsonLd(toJsonLd(score, domain));
  const bc = breadcrumbJsonLd(
    [
      { position: 1, name: 'Home', path: '/' },
      { position: 2, name: `Domain: ${domain}`, path: canon },
    ],
    site,
  );
  const org = organizationJsonLd(site);

  const headExtras = [
    metaTags({ title, description, canonical: canon, siteUrl: site, ogTitle, ogDescription }),
    `<link rel="alternate" type="application/json" href="/public/domain/${escapeHtml(domain)}">`,
    jsld,
    bc,
    org,
  ].join('\n');

  const tmHtml = tmStatus
    ? `<div><span class="badge ${trademark!.verdict}">Trademark: ${tmStatus}</span></div>`
    : '';

  const buyMaxStat =
    score.suggestedBuyMax !== undefined
      ? `<div class="stat"><div class="stat-label">Suggested Buy Max</div><div class="stat-value">€${score.suggestedBuyMax.toFixed(0)}</div></div>`
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
    buyMaxStat,
    `<div class="stat"><div class="stat-label">Suggested List Price</div><div class="stat-value">€${score.suggestedListPrice.toFixed(0)}</div></div>`,
    '</div>',
    '<p class="footer">Automated heuristic estimate by <a href="' +
      escapeHtml(site) +
      '">DOMINUS</a>. It is not an appraisal, not an offer to sell the domain and not investment advice.</p>',
    '</div>',
  ].join('\n');

  return pageHtml(title, headExtras, BASE_CSS_HREF, bodyContent);
}
