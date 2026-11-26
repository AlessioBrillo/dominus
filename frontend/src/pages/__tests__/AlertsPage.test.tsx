// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/api/client', () => ({
  api: { get: vi.fn() },
}));

const acknowledgeOne = vi.fn();
const acknowledgeAll = vi.fn();

vi.mock('@/hooks/useAlerts', () => ({
  useAcknowledgeAlert: () => ({ mutateAsync: acknowledgeOne, isPending: false }),
  useAcknowledgeAllAlerts: () => ({ mutateAsync: acknowledgeAll, isPending: false }),
}));

import { AlertsPage } from '../AlertsPage';
import { api } from '@/api/client';
import { createWrapper } from '@/hooks/__tests__/test-utils';

const alert = {
  id: 7,
  domain: 'renew-me.com',
  alertType: 'renewal',
  severity: 'warning',
  message: 'Renews in 7 days',
  createdAt: '2026-11-26T09:00:00Z',
};

describe('AlertsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the empty state when nothing needs a decision', async () => {
    vi.mocked(api.get).mockResolvedValueOnce({ alerts: [] });
    render(<AlertsPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByText('Nothing needs a decision')).toBeInTheDocument();
    });
  });

  it('renders an actionable alert and dismisses it', async () => {
    vi.mocked(api.get).mockResolvedValue({ alerts: [alert] });
    acknowledgeOne.mockResolvedValue(undefined);

    render(<AlertsPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByText('renew-me.com')).toBeInTheDocument();
    });
    expect(screen.getByText('Renews in 7 days')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(acknowledgeOne).toHaveBeenCalledWith(7);
  });

  it('dismisses every alert at once', async () => {
    vi.mocked(api.get).mockResolvedValue({ alerts: [alert] });
    acknowledgeAll.mockResolvedValue(1);

    render(<AlertsPage />, { wrapper: createWrapper() });
    await waitFor(() => {
      expect(screen.getByText('renew-me.com')).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole('button', { name: 'Dismiss all' }));
    expect(acknowledgeAll).toHaveBeenCalledTimes(1);
  });
});
