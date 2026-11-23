// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createWrapper } from '@/hooks/__tests__/test-utils';

vi.mock('@/api/auth', () => ({
  registerTenant: vi.fn(),
}));

vi.mock('@/api/legal', () => ({
  getLegalContent: vi.fn(),
}));

import { SignupPage } from '../SignupPage';
import { registerTenant } from '@/api/auth';
import { getLegalContent } from '@/api/legal';

const PAID_LEGAL = {
  mode: 'cloud' as const,
  status: 'cloud_paid' as const,
  version: '2026-11-20',
  contentHash: 'a'.repeat(64),
  documentHashes: { terms: 'a'.repeat(64), privacy: 'a'.repeat(64) },
  waitlistAvailable: false,
  updatedAt: '2026-11-20',
  securityContactAvailable: false,
  sourceCodeUrl: 'https://github.com/AlessioBrillo/dominus',
  identityPublished: true,
  identity: {
    entityName: 'Example Operator SRL',
    tradingName: 'DOMINUS',
    entityKind: 'company' as const,
    legalForm: 'SRL',
    shareCapital: 'EUR 10,000.00 fully paid',
    registeredAddress: 'Via Roma 1',
    vatId: 'IT12345678901',
    reaNumber: 'RM-123456',
    registroImprese: 'Registro Imprese di Roma',
    pec: 'example@pec.it',
    contactEmail: 'hello@example.it',
    privacyEmail: 'privacy@example.it',
    supervisoryAuthority: 'Garante per la protezione dei dati personali (Italy)',
    vatRegime: 'ordinary' as const,
  },
  documents: [],
};

describe('SignupPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getLegalContent).mockResolvedValue(PAID_LEGAL);
  });

  it('registers a tenant and reveals the one-time API key', async () => {
    vi.mocked(registerTenant).mockResolvedValue({
      tenantId: 'tenant-abc',
      key: 'deadbeef',
      prefix: 'deadbeef',
      message: 'Save this key — it will not be shown again.',
    });

    render(<SignupPage />, { wrapper: createWrapper() });

    await userEvent.type(await screen.findByPlaceholderText('Name'), 'Alessio');
    await userEvent.type(await screen.findByPlaceholderText('Email'), 'a@example.com');
    await userEvent.click(screen.getByRole('checkbox', { name: /I accept the Terms/ }));
    await userEvent.click(screen.getByRole('checkbox', { name: /at least 18/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Create workspace' }));

    await waitFor(() => expect(screen.getByText('deadbeef')).toBeInTheDocument());
    expect(registerTenant).toHaveBeenCalledWith({
      name: 'Alessio',
      email: 'a@example.com',
      contractAcceptance: {
        documentVersion: PAID_LEGAL.version,
        documentHashes: PAID_LEGAL.documentHashes,
        termsAccepted: true,
        privacyAccepted: true,
        ageConfirmed: true,
      },
    });
  }, 10000);

  it('asks for the email verification when the deployment requires it', async () => {
    vi.mocked(registerTenant).mockResolvedValue({
      tenantId: 'tenant-abc',
      verificationRequired: true,
      message: 'Check your inbox.',
    });

    render(<SignupPage />, { wrapper: createWrapper() });

    await userEvent.type(await screen.findByPlaceholderText('Name'), 'Alessio');
    await userEvent.type(await screen.findByPlaceholderText('Email'), 'a@example.com');
    await userEvent.click(screen.getByRole('checkbox', { name: /I accept the Terms/ }));
    await userEvent.click(screen.getByRole('checkbox', { name: /at least 18/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Create workspace' }));

    await waitFor(() => expect(screen.getByText(/Check your inbox/)).toBeInTheDocument());
  }, 10000);

  it('requires the email address', async () => {
    render(<SignupPage />, { wrapper: createWrapper() });

    await userEvent.type(await screen.findByPlaceholderText('Name'), 'Alessio');
    await userEvent.click(screen.getByRole('button', { name: 'Create workspace' }));

    await waitFor(() => expect(screen.getByText('Email is required')).toBeInTheDocument());
    expect(registerTenant).not.toHaveBeenCalled();
  });

  it('surfaces validation failures', async () => {
    vi.mocked(registerTenant).mockRejectedValue(new Error('Name is required'));

    render(<SignupPage />, { wrapper: createWrapper() });

    await userEvent.type(await screen.findByPlaceholderText('Name'), 'Alessio');
    await userEvent.type(await screen.findByPlaceholderText('Email'), 'a@example.com');
    await userEvent.click(screen.getByRole('checkbox', { name: /I accept the Terms/ }));
    await userEvent.click(screen.getByRole('checkbox', { name: /at least 18/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Create workspace' }));

    await waitFor(() => expect(screen.getByText('Name is required')).toBeInTheDocument());
  });
});
