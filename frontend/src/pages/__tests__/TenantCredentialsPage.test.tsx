// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { createWrapper } from '@/hooks/__tests__/test-utils';

vi.mock('@/api/tenant-credentials', () => ({
  listTenantCredentials: vi.fn(),
  setTenantCredential: vi.fn(),
  deleteTenantCredential: vi.fn(),
}));

import { TenantCredentialsPage } from '../TenantCredentialsPage';
import {
  listTenantCredentials,
  setTenantCredential,
  deleteTenantCredential,
} from '@/api/tenant-credentials';

const credentials = [
  {
    providerType: 'registrar' as const,
    providerName: 'cloudflare',
    accountId: 'acc-123',
    credentialScope: 'dns:edit',
    createdAt: '2026-10-01T10:00:00Z',
    updatedAt: '2026-10-01T10:00:00Z',
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listTenantCredentials).mockResolvedValue({ credentials });
  vi.mocked(setTenantCredential).mockResolvedValue({
    ok: true,
    providerType: 'registrar',
    providerName: 'cloudflare',
    message: 'Credential stored',
  });
  vi.mocked(deleteTenantCredential).mockResolvedValue({ ok: true, deleted: true });
});

describe('TenantCredentialsPage', () => {
  it('renders the title and credentials table', async () => {
    render(<TenantCredentialsPage />, { wrapper: createWrapper() });

    expect(screen.getByText('Provider credentials')).toBeInTheDocument();
    await screen.findByText(/cloudflare/);
  });

  it('shows empty state when no credentials', async () => {
    vi.mocked(listTenantCredentials).mockResolvedValue({ credentials: [] });
    render(<TenantCredentialsPage />, { wrapper: createWrapper() });

    await screen.findByText('No credentials stored yet');
  });
});
