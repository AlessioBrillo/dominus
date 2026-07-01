export const BASE_CSS_HREF = '/public/static/assets/public-score.css';
export const COMPARE_CSS_HREF = '/public/static/assets/public-compare.css';
export const ERROR_CSS_HREF = '/public/static/assets/public-error.css';

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
<title>${title}</title>
${headExtras}
<link rel="stylesheet" href="${cssHref}">
</head>
<body>${bodyContent}</body>
</html>`;
}
