import { escapeHtml } from './escape.js';
import { pageHtml, ERROR_CSS_HREF, SITE_NAME } from './page-template.js';

export function renderErrorPage(message: string): string {
  const bodyContent = [
    '<div class="card">',
    `<h1>${escapeHtml(message)}</h1>`,
    '<p>The score you are looking for does not exist.</p>',
    '</div>',
  ].join('\n');

  const headExtras = ['<meta name="robots" content="noindex,nofollow">'].join('\n');

  return pageHtml(SITE_NAME, headExtras, ERROR_CSS_HREF, bodyContent);
}
