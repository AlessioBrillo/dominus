// SPDX-License-Identifier: AGPL-3.0-only
import { legalFooterHtml } from './legal-footer.js';
import { escapeHtml } from './escape.js';

/**
 * The single conversion link from a public, unauthenticated estimate into
 * the product. Every public view receives a site URL already; this helper
 * keeps the wording and the destination consistent across them.
 */
export function trackCtaHtml(siteUrl: string, domain?: string): string {
  const base = siteUrl.replace(/\/$/, '');
  const query = domain === undefined ? '' : `?domain=${encodeURIComponent(domain)}`;
  const href = escapeHtml(`${base}/signup${query}`);
  return `<p class="cta-row"><a class="cta" href="${href}">Track this domain in DOMINUS</a></p>`;
}

export const BASE_CSS_HREF = '/public/static/assets/public-score.css';
export const COMPARE_CSS_HREF = '/public/static/assets/public-compare.css';
export const ERROR_CSS_HREF = '/public/static/assets/public-error.css';
export const SITE_NAME = 'DOMINUS';

/**
 * Last-resort origin for isolated render calls that carry no request context
 * (unit tests, offline previews). Production always passes the configured
 * PUBLIC_APP_URL in through siteUrlForReq, so this value never reaches a
 * public page. It is deliberately unresolvable: a parked or borrowed domain
 * would silently publish the wrong canonical/JSON-LD origin.
 */
export const DEFAULT_SITE_URL = 'https://example.invalid';

export function pageHtml(
  title: string,
  headExtras: string,
  cssHref: string,
  bodyContent: string,
): string {
  // The legal footer is appended to every public page: art. 7 D.Lgs. 70/2003
  // requires the operator's identity to be immediately reachable, not hidden
  // behind a link from the terms page.
  const footer = legalFooterHtml();
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="index,follow">
${headExtras}
<title>${title}</title>
<link rel="stylesheet" href="${cssHref}">
</head>
<body>${bodyContent}${footer}</body>
</html>`;
}
