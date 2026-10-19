// SPDX-License-Identifier: AGPL-3.0-only
import { legalFooterHtml } from './legal-footer.js';

export const BASE_CSS_HREF = '/public/static/assets/public-score.css';
export const COMPARE_CSS_HREF = '/public/static/assets/public-compare.css';
export const ERROR_CSS_HREF = '/public/static/assets/public-error.css';
export const SITE_NAME = 'DOMINUS';
export const TWITTER_SITE = '@dominusapp';

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
