export const BASE_CSS_HREF = '/public/static/assets/public-score.css';
export const COMPARE_CSS_HREF = '/public/static/assets/public-compare.css';
export const ERROR_CSS_HREF = '/public/static/assets/public-error.css';
export const SITE_NAME = 'DOMINUS';
export const SITE_URL = 'https://dominus.app';
export const TWITTER_SITE = '@dominusapp';

export function pageHtml(
  title: string,
  headExtras: string,
  cssHref: string,
  bodyContent: string,
): string {
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
<body>${bodyContent}</body>
</html>`;
}
