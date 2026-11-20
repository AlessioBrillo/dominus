// SPDX-License-Identifier: AGPL-3.0-only
import { escapeHtml } from './escape.js';

/**
 * The legal footer of the public pages.
 *
 * Art. 7 of Italian Legislative Decree 70/2003 requires the provider of an
 * electronic service to make its identity "easily and directly accessible".
 * A link buried in a terms page is not that: the standard the law applies is
 * immediate reachability from every page. Every server-rendered public page
 * therefore carries the operator identity and the links to the legal
 * documents at the bottom of the page.
 *
 * The context is injected once at boot (src/index.ts) rather than threaded
 * through every view renderer: the public pages all share one template, and
 * the alternative - a footer parameter on five renderers and their call
 * sites - would make it easy to forget one page.
 */
export interface LegalFooterContext {
  /** 'cloud' when the operator runs the managed service, 'community' otherwise. */
  mode: 'cloud' | 'community';
  /** Registered name of the operator. Empty in community mode. */
  entityName: string;
  /** 'individual', 'sole_trader' or 'company'. */
  entityKind?: 'individual' | 'sole_trader' | 'company';
  /** Registered address. Empty in community mode. */
  registeredAddress?: string;
  /** VAT identification number. Empty in community mode. */
  vatId: string;
  /** Business register number (REA). Empty outside a registered business. */
  reaNumber?: string;
  /** Register office, for example "Registro Imprese di Roma". */
  registroImprese?: string;
  /** Certified electronic address (PEC). Empty outside a registered business. */
  pec?: string;
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
 * The links point at the SPA routes: the legal documents are rendered by the
 * application, so there is exactly one copy of each text.
 */
export function legalFooterHtml(): string {
  if (!context) return '';

  const identityParts: string[] = [];
  // The community edition has no operator identity to publish: the deployer
  // is the controller, and the software cannot know who that is. It still
  // carries the document links, which describe the licence and the data flow.
  if (context.mode === 'cloud') {
    if (context.entityName) identityParts.push(escapeHtml(context.entityName));
    if (context.entityKind === 'sole_trader') identityParts.push('sole trader');
    if (context.entityKind === 'company') identityParts.push('company');
    if (context.vatId) identityParts.push(`VAT ID ${escapeHtml(context.vatId)}`);
    if (context.reaNumber) identityParts.push(`REA ${escapeHtml(context.reaNumber)}`);
    if (context.registroImprese) identityParts.push(escapeHtml(context.registroImprese));
    if (context.pec) identityParts.push(`PEC ${escapeHtml(context.pec)}`);
    if (context.contactEmail) {
      identityParts.push(
        `<a href="mailto:${escapeHtml(context.contactEmail)}">${escapeHtml(context.contactEmail)}</a>`,
      );
    }
  }

  const identity =
    identityParts.length > 0
      ? `<p>${identityParts.join(' &middot; ')}</p>`
      : '<p>DOMINUS &middot; open-source domain investment decision support</p>';
  const address =
    context.mode === 'cloud' && context.registeredAddress
      ? `<p>${escapeHtml(context.registeredAddress)}</p>`
      : '';

  return [
    '<footer class="footer" data-legal-footer>',
    identity,
    address,
    '<p>',
    '<a href="/terms">Terms of Service</a> &middot; ',
    '<a href="/privacy">Privacy Notice</a> &middot; ',
    '<a href="/legal-notice">Legal notice</a>',
    '</p>',
    '</footer>',
  ].join('');
}
