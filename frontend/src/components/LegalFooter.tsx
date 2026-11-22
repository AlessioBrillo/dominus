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
 *
 * It also carries the AGPL §13 source offer. A network service that does not
 * offer the source of the running version is not compliant, and a user who
 * cannot find the offer is in the same position as a user who was not given
 * one.
 */
export function LegalFooter() {
  const { data } = useLegalContent();
  const identity = data?.identity;
  const showIdentity = data?.identityPublished === true && identity?.entityName;
  const showCommunityWarning = data?.mode === 'community' && data.identityPublished !== true;

  return (
    <footer
      aria-label="Legal"
      className="mt-10 border-t border-border pt-4 text-xs text-text-muted"
      data-legal-footer
    >
      <p>DOMINUS &middot; estimates, not appraisals.</p>
      {showCommunityWarning && (
        <p className="mt-1">
          This deployment has not published the identity of its operator. If you run it, configure
          the LEGAL_* variables so that the legal notice can name the data controller.
        </p>
      )}
      {showIdentity && (
        <p className="mt-1">
          {identity.entityName}
          {identity.tradingName && identity.tradingName !== identity.entityName
            ? ` · trading as ${identity.tradingName}`
            : ''}
          {identity.legalForm
            ? ` · ${identity.legalForm}`
            : identity.entityKind === 'sole_trader'
              ? ' · sole trader'
              : identity.entityKind === 'company'
                ? ' · company'
                : ''}
          {identity.shareCapital && ` · share capital ${identity.shareCapital}`}
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
        <a
          href="/.well-known/security.txt"
          className="hover:text-text-primary"
          hidden={!data?.securityContactAvailable}
        >
          Security
        </a>
        {data?.sourceCodeUrl && (
          <a
            href={data.sourceCodeUrl}
            className="hover:text-text-primary"
            rel="noopener noreferrer"
            target="_blank"
          >
            Source code
          </a>
        )}
        <a href="/public/data-sources" className="hover:text-text-primary">
          Data sources
        </a>
        <a href="/public/third-party-notices" className="hover:text-text-primary">
          Third-party notices
        </a>
        <a href="/public/dpa" className="hover:text-text-primary">
          DPA
        </a>
        <a href="/public/license" className="hover:text-text-primary">
          License
        </a>
      </nav>
    </footer>
  );
}
