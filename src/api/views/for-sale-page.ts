// SPDX-License-Identifier: AGPL-3.0-only
import { escapeHtml } from './escape.js';
import { pageHtml, BASE_CSS_HREF, SITE_NAME } from './page-template.js';
import { forSaleOfferJsonLd, breadcrumbJsonLd, organizationJsonLd, metaTags } from './jsonld.js';
import type { DomainSite, DomainSiteScore } from '../../types/domain-site.js';

export function renderForSalePage(sitePage: DomainSite, siteUrl?: string): string {
  const origin = siteUrl ?? 'https://dominus.app';
  const score = parseScore(sitePage.scoreJson);

  const title = `${escapeHtml(sitePage.domain)} is for sale | ${SITE_NAME}`;
  const description = `${escapeHtml(sitePage.headline)}. Asking price €${sitePage.askingPriceEur !== null ? sitePage.askingPriceEur.toFixed(0) : 'on request'}.`;
  const canon = `/public/for-sale/${escapeHtml(sitePage.domain)}`;
  const ogTitle = `${escapeHtml(sitePage.domain)} — For Sale`;
  const ogDescription =
    sitePage.askingPriceEur !== null
      ? `Asking price: €${sitePage.askingPriceEur.toFixed(0)}`
      : 'Make an offer';

  const headExtras = [
    metaTags({ title, description, canonical: canon, siteUrl: origin, ogTitle, ogDescription }),
    forSaleOfferJsonLd(sitePage),
    breadcrumbJsonLd(
      [
        { position: 1, name: 'Home', path: '/' },
        { position: 2, name: `For sale: ${sitePage.domain}`, path: canon },
      ],
      origin,
    ),
    organizationJsonLd(origin),
  ].join('\n');

  const priceHtml =
    sitePage.askingPriceEur !== null
      ? `<div class="stat"><div class="stat-label">Asking Price</div><div class="stat-value positive">€${sitePage.askingPriceEur.toFixed(0)}</div></div>`
      : '<div class="stat"><div class="stat-label">Asking Price</div><div class="stat-value">On request</div></div>';

  const scoreHtml = score
    ? [
        '<div class="grid">',
        `<div class="stat"><div class="stat-label">Expected Value</div><div class="stat-value">€${score.expectedValue.toFixed(0)}</div></div>`,
        `<div class="stat"><div class="stat-label">Confidence</div><div class="stat-value">${(score.confidence * 100).toFixed(0)}%</div></div>`,
        `<div class="stat"><div class="stat-label">Appraised List Price</div><div class="stat-value">€${score.suggestedListPrice.toFixed(0)}</div></div>`,
        '</div>',
      ].join('\n')
    : '';

  const contactHtml = sitePage.contact
    ? `<p><a class="cta" href="mailto:${escapeHtml(sitePage.contact)}?subject=${encodeURIComponent(`Offer for ${sitePage.domain}`)}">Make an offer</a></p>`
    : `<p><a href="${escapeHtml(origin)}/public/domain/${escapeHtml(sitePage.domain)}">View the appraisal for ${escapeHtml(sitePage.domain)}</a></p>`;

  const bodyContent = [
    '<div class="card">',
    `<h1>${escapeHtml(sitePage.domain)}</h1>`,
    '<p class="subtitle">This domain is for sale</p>',
    `<p>${escapeHtml(sitePage.summary)}</p>`,
    '<div class="grid">',
    priceHtml,
    '</div>',
    scoreHtml,
    contactHtml,
    `<p class="footer">Listed with <a href="${escapeHtml(origin)}">DOMINUS</a></p>`,
    '</div>',
  ].join('\n');

  return pageHtml(title, headExtras, BASE_CSS_HREF, bodyContent);
}

function parseScore(json: string): DomainSiteScore | null {
  try {
    const parsed = JSON.parse(json) as Partial<DomainSiteScore>;
    if (
      typeof parsed.expectedValue !== 'number' ||
      typeof parsed.confidence !== 'number' ||
      typeof parsed.suggestedListPrice !== 'number'
    ) {
      return null;
    }
    return {
      expectedValue: parsed.expectedValue,
      confidence: parsed.confidence,
      suggestedListPrice: parsed.suggestedListPrice,
      weightedScore: typeof parsed.weightedScore === 'number' ? parsed.weightedScore : 0,
    };
  } catch {
    return null;
  }
}
