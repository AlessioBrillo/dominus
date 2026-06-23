import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

vi.mock('@/api/client', () => ({
  api: { get: vi.fn() },
}));

import { OutcomesPage } from '../OutcomesPage';
import { api } from '@/api/client';
import { createWrapper } from '@/hooks/__tests__/test-utils';

const soldOutcome = {
  id: 1,
  domain: 'sold.com',
  type: 'sold',
  occurredAt: '2026-06-01T00:00:00Z',
  salePriceEur: 1500,
  venue: 'afternic',
};
const expiredOutcome = {
  id: 2,
  domain: 'expired.net',
  type: 'expired',
  occurredAt: '2026-05-01T00:00:00Z',
};

describe('OutcomesPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading state', () => {
    vi.mocked(api.get).mockReturnValueOnce(new Promise(() => {}));
    render(<OutcomesPage />, { wrapper: createWrapper() });
    expect(screen.getByText('Outcomes')).toBeInTheDocument();
  });

  it('renders summary cards and outcomes table', async () => {
    vi.mocked(api.get).mockResolvedValueOnce({ outcomes: [soldOutcome, expiredOutcome] });
    render(<OutcomesPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByText('sold.com')).toBeInTheDocument();
    });

    expect(screen.getByText('expired.net')).toBeInTheDocument();
    expect(screen.getAllByText('€1500').length).toBeGreaterThanOrEqual(1);
  });

  it('shows empty state', async () => {
    vi.mocked(api.get).mockResolvedValueOnce({ outcomes: [] });
    render(<OutcomesPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByText(/No outcomes recorded/)).toBeInTheDocument();
    });
  });

  it('shows error state', async () => {
    vi.mocked(api.get).mockRejectedValueOnce(new Error('Failed to load'));
    render(<OutcomesPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByText(/Failed to load/)).toBeInTheDocument();
    });
  });
});
