// SPDX-License-Identifier: AGPL-3.0-only
import { escapeHtml } from './escape.js';

/**
 * The legal footer of the public pages.
 *
 * Art. 7 of Italian Legislative Decree 70/2003 requires the provider of an
 * electronic service to make its identity "easily and directly accessible".
 * A link buried in a terms page is not that: the standard the law applies is
 * immediate reachability from every page. Every server-rendered public page
 * therefore carries the operator identity and the links to the three legal
 * documents at the bottom of the page.
 *
 * The context is injected once at boot (src/index.ts) rather than threaded
 * through every view renderer: the public pages all share one template, and
 * the alternative — a footer parameter on five renderers and their call
 * sites — would make it easy to forget one page.
 */
export interface LegalFooterContext {
  /** 'cloud' when the operator runs the managed service, 'community' otherwise. */
  mode: 'cloud' | 'community';
  /** Registered name of the operator. Empty in community mode. */
  entityName: string;
  /** VAT identification number. Empty in community mode. */
  vatId: string;
  /** General contact address. Empty in community mode. */
  contactEmail: string;
}

let context: LegalFooterContext | null = null;

/** Inject the footer context at boot. Passing null renders no footer. */
export function setLegalFooterContext(next: LegalFooterContext | null): void {
  context = next;
}

/** The current footer context, for the launch gate and the boot checks. */
export function getLegalFooterContext(): LegalFooterContext | null {
  return context;
}

/**
 * The footer markup.
 *
 * The three links point at the SPA routes: the legal documents are rendered
 * by the application, so there is exactly one copy of each text.
 */
export function legalFooterHtml(): string {
  if (!context) return '';

  const identityParts: string[] = [];
  if (context.entityName) identityParts.push(escapeHtml(context.entityName));
  if (context.vatId) identityParts.push(`VAT ID ${escapeHtml(context.vatId)}`);
  if (context.contactEmail) {
    identityParts.push(
      `<a href="mailto:${escapeHtml(context.contactEmail)}">${escapeHtml(context.contactEmail)}</a>`,
    );
  }

  const identity =
    identityParts.length > 0
      ? `<p>${identityParts.join(' &middot; ')}</p>`
      : '<p>DOMINUS &middot; open-source domain investment decision support</p>';

  return [
    '<footer class="footer" data-legal-footer>',
    identity,
    '<p>',
    '<a href="/terms">Terms of Service</a> &middot; ',
    '<a href="/privacy">Privacy Notice</a> &middot; ',
    '<a href="/legal-notice">Legal notice</a>',
    '</p>',
    '</footer>',
  ].join('');
}
