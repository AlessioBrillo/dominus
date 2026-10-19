// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, afterEach } from 'vitest';
import {
  setLegalFooterContext,
  getLegalFooterContext,
  legalFooterHtml,
} from '../views/legal-footer.js';
import { pageHtml } from '../views/page-template.js';

afterEach(() => {
  setLegalFooterContext(null);
});

describe('legal footer', () => {
  it('renders the operator identity and the three legal links', () => {
    setLegalFooterContext({
      mode: 'cloud',
      entityName: 'Example Operator SRL',
      vatId: 'IT12345678901',
      contactEmail: 'hello@example.it',
    });

    const html = legalFooterHtml();
    expect(html).toContain('Example Operator SRL');
    expect(html).toContain('IT12345678901');
    expect(html).toContain('hello@example.it');
    expect(html).toContain('href="/terms"');
    expect(html).toContain('href="/privacy"');
    expect(html).toContain('href="/legal-notice"');
  });

  it('renders nothing when no context is injected', () => {
    expect(legalFooterHtml()).toBe('');
    expect(getLegalFooterContext()).toBeNull();
  });

  it('escapes the identity it renders', () => {
    setLegalFooterContext({
      mode: 'cloud',
      entityName: '<script>alert(1)</script>',
      vatId: '',
      contactEmail: '',
    });

    expect(legalFooterHtml()).not.toContain('<script>');
    expect(legalFooterHtml()).toContain('&lt;script&gt;');
  });

  it('is appended to every server-rendered page', () => {
    setLegalFooterContext({
      mode: 'cloud',
      entityName: 'Example Operator SRL',
      vatId: 'IT12345678901',
      contactEmail: '',
    });

    const html = pageHtml('Title', '', '/public/static/assets/public-score.css', '<p>body</p>');
    expect(html).toContain('<p>body</p>');
    expect(html).toContain('data-legal-footer');
    expect(html).toContain('href="/legal-notice"');
  });
});
