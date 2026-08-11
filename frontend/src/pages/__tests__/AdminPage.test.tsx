// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { createWrapper } from '@/hooks/__tests__/test-utils';

vi.mock('@/api/admin', () => ({
  fetchAdminOverview: vi.fn(),
  fetchAdminTenants: vi.fn(),
}));

import { AdminPage } from '../AdminPage';
import { fetchAdminOverview, fetchAdminTenants } from '@/api/admin';

const overview = {
  periodStart: '2026-08-01',
  periodEnd: '2026-08-31',
  tenantsCount: 2,
  activeSubscriptions: 1,
  paidPlans: 1,
  candidatesScoredTotal: 35,
  apiCallsTotal: 350,
};

const tenants = [
  {
    tenantId: 'tenant-a',
    plan: 'pro',
    status: 'active',
    apiKeyCount: 2,
    lastActiveAt: '2026-08-06T10:00:00Z',
    usage: [
      { feature: 'candidates_scored', used: 20, limit: 500 },
      { feature: 'api_calls', used: 5, limit: 10000 },
      { feature: 'domains_tracked', used: 0, limit: 250 },
    ],
  },
  {
    tenantId: 'tenant-e',
    plan: 'enterprise',
    status: 'active',
    apiKeyCount: 0,
    lastActiveAt: null,
    usage: [
      { feature: 'candidates_scored', used: 15, limit: null },
      { feature: 'api_calls', used: 345, limit: null },
      { feature: 'domains_tracked', used: 3, limit: null },
    ],
  },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AdminPage', () => {
  it('renders overview cards and the tenants table', async () => {
    vi.mocked(fetchAdminOverview).mockResolvedValueOnce(overview as never);
    vi.mocked(fetchAdminTenants).mockResolvedValueOnce(tenants as never);
    render(<AdminPage />, { wrapper: createWrapper() });

    await waitFor(() => expect(screen.getByText('Tenants')).toBeInTheDocument());
    expect(screen.getAllByText('2').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Active subs')).toBeInTheDocument();
    expect(screen.getByText('Paid plans')).toBeInTheDocument();
    expect(screen.getByText('Candidates scored')).toBeInTheDocument();
    expect(screen.getAllByText('API calls').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('35')).toBeInTheDocument();
    expect(screen.getByText('350')).toBeInTheDocument();

    await waitFor(() => expect(screen.getByText('tenant-a')).toBeInTheDocument());
    expect(screen.getByText('tenant-e')).toBeInTheDocument();
    expect(screen.getByText('20 / 500')).toBeInTheDocument();
    expect(screen.getByText('15')).toBeInTheDocument();
  });

  it('shows skeletons while loading', () => {
    vi.mocked(fetchAdminOverview).mockReturnValueOnce(new Promise(() => {}));
    vi.mocked(fetchAdminTenants).mockReturnValueOnce(new Promise(() => {}));
    render(<AdminPage />, { wrapper: createWrapper() });

    expect(screen.queryByText('Tenants')).not.toBeInTheDocument();
  });

  it('shows an admin-access message when the request fails with 403', async () => {
    vi.mocked(fetchAdminOverview).mockRejectedValueOnce(new Error('Forbidden'));
    vi.mocked(fetchAdminTenants).mockRejectedValueOnce(new Error('Forbidden'));
    render(<AdminPage />, { wrapper: createWrapper() });

    expect(await screen.findByText('Forbidden')).toBeInTheDocument();
    expect(screen.getByText(/This view requires an admin API key/)).toBeInTheDocument();
  });

  it('shows the empty state when there are no tenants', async () => {
    vi.mocked(fetchAdminOverview).mockResolvedValueOnce({
      ...overview,
      tenantsCount: 0,
    } as never);
    vi.mocked(fetchAdminTenants).mockResolvedValueOnce([] as never);
    render(<AdminPage />, { wrapper: createWrapper() });

    await waitFor(() => expect(screen.getByText('No tenants')).toBeInTheDocument());
  });
});
