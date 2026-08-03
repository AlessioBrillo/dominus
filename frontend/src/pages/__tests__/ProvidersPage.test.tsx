// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { createWrapper } from '@/hooks/__tests__/test-utils';

vi.mock('@/api/providers', () => ({
  fetchProviderStatuses: vi.fn(),
}));

import { ProvidersPage } from '../ProvidersPage';
import { fetchProviderStatuses } from '@/api/providers';

const providers = [
  { name: 'RDAP', configured: true, note: 'Public bootstrap' },
  { name: 'USPTO', configured: false, note: 'No API key' },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ProvidersPage', () => {
  it('renders page title and summary cards', async () => {
    vi.mocked(fetchProviderStatuses).mockResolvedValueOnce(providers);
    render(<ProvidersPage />, { wrapper: createWrapper() });

    await waitFor(() => expect(screen.getByText('Providers')).toBeInTheDocument());
    expect(screen.getByText('Configured')).toBeInTheDocument();
    expect(screen.getByText('Unconfigured')).toBeInTheDocument();
    expect((await screen.findAllByText('1')).length).toBe(2);
  });

  it('shows skeletons while loading', () => {
    vi.mocked(fetchProviderStatuses).mockReturnValueOnce(new Promise(() => {}));
    render(<ProvidersPage />, { wrapper: createWrapper() });

    expect(screen.getByText('Providers')).toBeInTheDocument();
    expect(screen.queryByText('No provider data')).not.toBeInTheDocument();
  });

  it('shows an error card when the request fails', async () => {
    vi.mocked(fetchProviderStatuses).mockRejectedValueOnce(new Error('providers down'));
    render(<ProvidersPage />, { wrapper: createWrapper() });

    expect(await screen.findByText('providers down')).toBeInTheDocument();
  });

  it('shows the empty state when no providers', async () => {
    vi.mocked(fetchProviderStatuses).mockResolvedValueOnce([]);
    render(<ProvidersPage />, { wrapper: createWrapper() });

    await waitFor(() => expect(screen.getByText('No provider data')).toBeInTheDocument());
  });

  it('renders a provider table with status icons and notes', async () => {
    vi.mocked(fetchProviderStatuses).mockResolvedValueOnce(providers);
    render(<ProvidersPage />, { wrapper: createWrapper() });

    await waitFor(() => expect(screen.getByText('RDAP')).toBeInTheDocument());
    expect(screen.getByText('USPTO')).toBeInTheDocument();
    expect(screen.getByText('Public bootstrap')).toBeInTheDocument();
    expect(screen.getByText('No API key')).toBeInTheDocument();
    expect(screen.getAllByText('1')).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: /refresh/i }));
    expect(fetchProviderStatuses).toHaveBeenCalledTimes(2);
  });
});
