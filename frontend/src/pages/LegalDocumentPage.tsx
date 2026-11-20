// SPDX-License-Identifier: AGPL-3.0-only
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { useLegalDocument } from '@/hooks/useLegalContent';
import type { LegalDocumentSlug } from '@/api/legal';

const NAV: { slug: LegalDocumentSlug; label: string; to: string }[] = [
  { slug: 'legal-notice', label: 'Legal notice', to: '/legal-notice' },
  { slug: 'terms', label: 'Terms of Service', to: '/terms' },
  { slug: 'privacy', label: 'Privacy Notice', to: '/privacy' },
];

/**
 * Renders one legal document.
 *
 * The document body comes from the server as structured data
 * (headings, paragraphs, bullets), so the same text is rendered here and by
 * the server-rendered public pages. The text is English only: there is no
 * translated version, and the documents say the English text is binding.
 */
export function LegalDocumentPage({ slug }: { slug: LegalDocumentSlug }) {
  const { document, version, updatedAt, isLoading, isError } = useLegalDocument(slug);
  const lastUpdated = updatedAt ? new Date(updatedAt).toLocaleDateString() : 'unknown';

  if (isLoading) {
    return (
      <div role="status" aria-live="polite" className="p-6 text-sm text-text-muted">
        Loading…
      </div>
    );
  }

  if (isError || !document) {
    return (
      <div className="max-w-2xl mx-auto p-6 space-y-4">
        <h1 className="text-2xl font-bold text-text-primary">Document unavailable</h1>
        <p className="text-text-secondary">
          The legal documents could not be loaded from the server. This deployment may not have them
          configured.
        </p>
        <Button asChild variant="outline">
          <Link to="/">Back to Dashboard</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto p-6 space-y-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-bold text-text-primary">{document.title}</h1>
        <p className="text-text-muted text-sm">
          {document.scope} Version {version} · last updated {lastUpdated}.
        </p>
        <div className="flex flex-wrap gap-2 print:hidden">
          <Button type="button" variant="outline" size="sm" onClick={() => window.print()}>
            Print or save as PDF
          </Button>
        </div>
      </header>

      {document.sections.map((section) => (
        <section key={section.heading} className="space-y-3">
          <h2 className="text-lg font-semibold text-text-primary">{section.heading}</h2>
          {section.paragraphs?.map((paragraph, index) => (
            <p key={index} className="text-text-secondary">
              {paragraph}
            </p>
          ))}
          {section.bullets && (
            <ul className="list-disc pl-5 space-y-1">
              {section.bullets.map((item, index) => (
                <li key={index} className="text-text-secondary">
                  {item}
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}

      <nav
        aria-label="Legal documents"
        className="pt-4 flex flex-wrap gap-3 border-t border-border"
      >
        {NAV.map((item) => (
          <Button key={item.slug} asChild variant={item.slug === slug ? 'default' : 'outline'}>
            <Link to={item.to}>{item.label}</Link>
          </Button>
        ))}
      </nav>
    </div>
  );
}
