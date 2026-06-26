import { escapeHtml } from './escape.js';
import { pageHtml, ERROR_CSS } from './page-template.js';

export function renderErrorPage(message: string): string {
  const bodyContent = [
    '<div class="card">',
    `<h1>${escapeHtml(message)}</h1>`,
    '<p>The score you are looking for does not exist.</p>',
    '</div>',
  ].join('\n');

  return pageHtml('DOMINUS', '', ERROR_CSS, bodyContent);
}
