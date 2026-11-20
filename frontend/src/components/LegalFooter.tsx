// SPDX-License-Identifier: AGPL-3.0-only
import { Link } from 'react-router-dom';
import { useLegalContent } from '@/hooks/useLegalContent';

/**
 * The legal footer of the signed-in application.
 *
 * The public pages render their own footer on the server, so the identity is
 * present even before React runs. The application shell renders this one so
 * that the documents stay one click away from every screen, which is what
 * art. 7 D.Lgs. 70/2003 asks for: the identity must be easily and directly
 * accessible, not hidden behind a settings page.
 */
export function LegalFooter() {
  const { data } = useLegalContent();
  const identity = data?.identity;
  const showIdentity = data?.mode === 'cloud' && identity?.entityName;

  return (
    <footer
      aria-label="Legal"
      className="mt-10 border-t border-border pt-4 text-xs text-text-muted"
      data-legal-footer
    >
      <p>DOMINUS &middot; estimates, not appraisals.</p>
      {showIdentity && (
        <p className="mt-1">
          {identity.entityName}
          {identity.entityKind === 'sole_trader' && ' · sole trader'}
          {identity.entityKind === 'company' && ' · company'}
          {identity.vatId && ` · VAT ID ${identity.vatId}`}
          {identity.reaNumber && ` · REA ${identity.reaNumber}`}
          {identity.registeredAddress && ` · ${identity.registeredAddress}`}
        </p>
      )}
      <nav className="mt-2 flex flex-wrap gap-3">
        <Link to="/legal-notice" className="hover:text-text-primary">
          Legal notice
        </Link>
        <Link to="/terms" className="hover:text-text-primary">
          Terms
        </Link>
        <Link to="/privacy" className="hover:text-text-primary">
          Privacy
        </Link>
        <a href="/.well-known/security.txt" className="hover:text-text-primary">
          Security
        </a>
      </nav>
    </footer>
  );
}
