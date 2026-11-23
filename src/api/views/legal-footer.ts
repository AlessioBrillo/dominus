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
 * Section 13 of the AGPL adds a second obligation: a network service must
 * offer its users the source of the version they are using. The offer is a
 * link, and a link in the footer is the only place a user is guaranteed to
 * see it.
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
  /** Commercial name, when it differs from the registered name. */
  tradingName?: string;
  /** 'individual', 'sole_trader' or 'company'. */
  entityKind?: 'individual' | 'sole_trader' | 'company';
  /** Exact legal form ("SRL", "SPA", "ditta individuale"). */
  legalForm?: string;
  /** Share capital, for the entities that have one. */
  shareCapital?: string;
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
  /** Where the corresponding source of the running version is published. */
  sourceCodeUrl?: string;
  /** True when the deployment has published enough identity to name a controller. */
  identityPublished?: boolean;
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
  const publishIdentity = context.mode === 'cloud' || context.identityPublished === true;

  if (publishIdentity) {
    if (context.entityName) identityParts.push(escapeHtml(context.entityName));
    if (context.tradingName && context.tradingName !== context.entityName) {
      identityParts.push(`trading as ${escapeHtml(context.tradingName)}`);
    }
    if (context.legalForm) {
      identityParts.push(escapeHtml(context.legalForm));
    } else if (context.entityKind === 'sole_trader') {
      identityParts.push('sole trader');
    } else if (context.entityKind === 'company') {
      identityParts.push('company');
    }
    if (context.shareCapital)
      identityParts.push(`share capital ${escapeHtml(context.shareCapital)}`);
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
      : context.mode === 'community'
        ? '<p>DOMINUS &middot; this deployment has not published the identity of its operator.</p>'
        : '<p>DOMINUS &middot; open-source domain investment decision support</p>';
  const address =
    publishIdentity && context.registeredAddress
      ? `<p>${escapeHtml(context.registeredAddress)}</p>`
      : '';

  const source = context.sourceCodeUrl
    ? `<a href="${escapeHtml(context.sourceCodeUrl)}" rel="noopener">Source code</a>`
    : '';

  return [
    '<footer class="footer" data-legal-footer>',
    identity,
    address,
    '<p>',
    '<a href="/terms">Terms of Service</a> &middot; ',
    '<a href="/privacy">Privacy Notice</a> &middot; ',
    '<a href="/legal-notice">Legal notice</a>',
    source ? ` &middot; ${source}` : '',
    '</p>',
    '<p>',
    '<a href="/public/data-sources">Data sources</a> &middot; ',
    '<a href="/public/third-party-notices">Third-party notices</a> &middot; ',
    '<a href="/public/dpa">Data processing agreement</a> &middot; ',
    '<a href="/public/license">License</a> &middot; ',
    '<a href="/accessibility">Accessibility</a>',
    '</p>',
    '</footer>',
  ].join('');
}
