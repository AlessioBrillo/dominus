// SPDX-License-Identifier: AGPL-3.0-only
export { escapeHtml } from './escape.js';
export { setLegalFooterContext, getLegalFooterContext, legalFooterHtml } from './legal-footer.js';
export type { LegalFooterContext } from './legal-footer.js';
export { renderScorePage } from './score-page.js';
export { renderDomainPage } from './domain-page.js';
export { renderForSalePage } from './for-sale-page.js';
export { renderComparePage } from './compare-page.js';
export { renderErrorPage } from './error-page.js';
export {
  productJsonLd,
  forSaleOfferJsonLd,
  reviewJsonLd,
  breadcrumbJsonLd,
  compareItemListJsonLd,
  organizationJsonLd,
  metaTags,
} from './jsonld.js';
export type { JsonLdScoreData } from './jsonld.js';
