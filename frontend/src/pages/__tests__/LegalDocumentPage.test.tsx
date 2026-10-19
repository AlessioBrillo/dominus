// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { LegalDocumentPage } from '../LegalDocumentPage';
import * as legalApi from '@/api/legal';

const getLegalContent = vi.spyOn(legalApi, 'getLegalContent');

function renderPage(slug: 'terms' | 'privacy' | 'legal-notice') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <LegalDocumentPage slug={slug} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  getLegalContent.mockReset();
  getLegalContent.mockResolvedValue({
    mode: 'cloud',
    identity: {
      entityName: 'Example Operator SRL',
      entityKind: 'company',
      registeredAddress: 'Via Roma 1, 00100 Roma (RM), Italy',
      vatId: 'IT12345678901',
      reaNumber: 'RM-123456',
      pec: 'example@pec.it',
      contactEmail: 'hello@example.it',
      privacyEmail: 'privacy@example.it',
      supervisoryAuthority: 'Garante per la protezione dei dati personali (Italy)',
    },
    documents: [
      {
        slug: 'legal-notice',
        title: 'Legal notice',
        scope: 'This notice identifies the operator.',
        sections: [
          {
            heading: '1. Service provider',
            paragraphs: ['Example Operator SRL, VAT ID IT12345678901'],
          },
        ],
      },
      {
        slug: 'terms',
        title: 'Terms of Service',
        scope: 'These Terms govern DOMINUS Cloud.',
        sections: [
          { heading: '9. Right of withdrawal', paragraphs: ['You have 14 days to withdraw.'] },
          { heading: '8. Prices', bullets: ['Prices exclude VAT.', 'Reverse charge applies.'] },
        ],
      },
      {
        slug: 'privacy',
        title: 'Privacy Notice',
        scope: 'This notice describes the processing.',
        sections: [{ heading: '3. Sub-processors', bullets: ['Hetzner Online GmbH (Germany)'] }],
      },
    ],
  });
});

describe('LegalDocumentPage', () => {
  it('renders the document that matches the slug', async () => {
    renderPage('legal-notice');

    expect(await screen.findByRole('heading', { name: 'Legal notice' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '1. Service provider' })).toBeInTheDocument();
    expect(screen.getByText(/Example Operator SRL, VAT ID IT12345678901/)).toBeInTheDocument();
  });

  it('renders paragraphs and bullets', async () => {
    renderPage('terms');

    expect(await screen.findByRole('heading', { name: 'Terms of Service' })).toBeInTheDocument();
    expect(screen.getByText(/14 days to withdraw/)).toBeInTheDocument();
    expect(screen.getByText('Reverse charge applies.')).toBeInTheDocument();
  });

  it('links to the other legal documents', async () => {
    renderPage('privacy');

    expect(await screen.findByRole('heading', { name: 'Privacy Notice' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Terms of Service' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Legal notice' })).toBeInTheDocument();
  });

  it('explains that the documents are unavailable when the server does not serve them', async () => {
    getLegalContent.mockRejectedValue(new Error('boom'));
    renderPage('terms');

    expect(
      await screen.findByRole('heading', { name: 'Document unavailable' }),
    ).toBeInTheDocument();
  });
});
