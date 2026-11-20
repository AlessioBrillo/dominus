// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ login: vi.fn(), logout: vi.fn(), isAuthenticated: false, isLoading: false }),
}));

vi.mock('@/api/legal', () => ({
  getLegalContent: vi.fn(),
}));

import { LandingPage } from '../LandingPage';
import { getLegalContent } from '@/api/legal';

function renderLanding() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <LandingPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(getLegalContent).mockReset();
  vi.mocked(getLegalContent).mockResolvedValue({
    mode: 'cloud',
    status: 'cloud_waitlist',
    version: '2026-11-20',
    updatedAt: '2026-11-20',
    identity: {
      entityName: 'Example Operator',
      entityKind: 'individual',
      registeredAddress: 'Via Roma 1',
      vatId: '',
      reaNumber: '',
      registroImprese: '',
      pec: '',
      contactEmail: 'hello@example.it',
      privacyEmail: 'privacy@example.it',
      supervisoryAuthority: 'Garante per la protezione dei dati personali (Italy)',
      vatRegime: 'none',
    },
    documents: [],
  });
});

describe('LandingPage', () => {
  it('says what the product does', () => {
    renderLanding();
    expect(
      screen.getByText(/A domain is worth what the evidence says it is worth/),
    ).toBeInTheDocument();
  });

  it('names the five checks of the pipeline', () => {
    renderLanding();
    expect(screen.getByText('Candidate generation')).toBeInTheDocument();
    expect(screen.getByText('DNS pre-filter')).toBeInTheDocument();
    expect(screen.getByText('RDAP confirmation')).toBeInTheDocument();
    expect(screen.getByText('Scoring')).toBeInTheDocument();
    expect(screen.getByText('Trademark gate')).toBeInTheDocument();
  });

  it('does not publish prices while the hosted edition is a waitlist', async () => {
    renderLanding();
    const notices = await screen.findAllByText(/The hosted edition is not on sale yet/);
    expect(notices.length).toBeGreaterThan(0);
    expect(screen.queryByRole('heading', { name: 'Pricing' })).not.toBeInTheDocument();
    expect(screen.queryByText(/35\.38/)).not.toBeInTheDocument();
  });

  it('offers the waitlist and the community edition, and keeps the sign-in', async () => {
    renderLanding();
    const waitlistLinks = await screen.findAllByRole('link', { name: /Follow the project/ });
    expect(waitlistLinks.length).toBeGreaterThan(0);
    expect(
      screen.getByRole('link', { name: /Self-host the community edition/ }),
    ).toBeInTheDocument();
    expect(screen.getByPlaceholderText('API Key')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Authenticate' })).toBeInTheDocument();
    expect(screen.queryByText(/New here\? Create a workspace/)).not.toBeInTheDocument();
  });

  it('publishes prices only when the hosted edition is on sale', async () => {
    vi.mocked(getLegalContent).mockResolvedValue({
      mode: 'cloud',
      status: 'cloud_paid',
      version: '2026-11-20',
      updatedAt: '2026-11-20',
      identity: {
        entityName: 'Example Operator SRL',
        entityKind: 'company',
        registeredAddress: 'Via Roma 1',
        vatId: 'IT12345678901',
        reaNumber: 'RM-123456',
        registroImprese: 'Registro Imprese di Roma',
        pec: 'example@pec.it',
        contactEmail: 'hello@example.it',
        privacyEmail: 'privacy@example.it',
        supervisoryAuthority: 'Garante per la protezione dei dati personali (Italy)',
        vatRegime: 'ordinary',
      },
      documents: [],
    });
    renderLanding();
    expect(await screen.findByRole('heading', { name: 'Pricing' })).toBeInTheDocument();
    expect(screen.getByText(/35\.38/)).toBeInTheDocument();
    expect(screen.getByText(/96\.38/)).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /Create a workspace/ }).length).toBeGreaterThan(0);
  });

  it('links the legal documents', () => {
    renderLanding();
    expect(screen.getByRole('link', { name: 'Legal notice' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Terms' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Privacy' })).toBeInTheDocument();
  });
});
