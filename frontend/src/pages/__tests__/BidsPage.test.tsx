import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/api/bids', () => ({
  listBids: vi.fn(),
  placeBid: vi.fn(),
  resolveBid: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { BidsPage } from '../BidsPage';
import { listBids } from '@/api/bids';
import { createWrapper } from '@/hooks/__tests__/test-utils';

const mockBids = [
  {
    domain: 'pending-bid.com',
    venue: 'afternic',
    bidAmountEur: 100,
    status: 'pending',
    bidPlacedAt: '2026-06-01T00:00:00Z',
  },
  {
    domain: 'won-bid.com',
    venue: 'sedo',
    bidAmountEur: 200,
    status: 'won',
    bidPlacedAt: '2026-05-01T00:00:00Z',
  },
];

describe('BidsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading state', () => {
    vi.mocked(listBids).mockReturnValueOnce(new Promise(() => {}));
    render(<BidsPage />, { wrapper: createWrapper() });
    expect(screen.getByText('Bids')).toBeInTheDocument();
  });

  it('renders bids list', async () => {
    vi.mocked(listBids).mockResolvedValueOnce({ bids: mockBids });
    render(<BidsPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByText('pending-bid.com')).toBeInTheDocument();
    });

    expect(screen.getByText('won-bid.com')).toBeInTheDocument();
  });

  it('shows empty state', async () => {
    vi.mocked(listBids).mockResolvedValueOnce({ bids: [] });
    render(<BidsPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByText(/No bids found/)).toBeInTheDocument();
    });
  });

  it('renders filter buttons', async () => {
    vi.mocked(listBids).mockResolvedValueOnce({ bids: mockBids });
    render(<BidsPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByText('All')).toBeInTheDocument();
    });
    expect(screen.getByText('Pending')).toBeInTheDocument();
    expect(screen.getByText('Won')).toBeInTheDocument();
    expect(screen.getByText('Lost')).toBeInTheDocument();
  });

  it('renders place bid form', async () => {
    vi.mocked(listBids).mockResolvedValueOnce({ bids: mockBids });
    render(<BidsPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByPlaceholderText('Domain')).toBeInTheDocument();
    });
    expect(screen.getByPlaceholderText('Max Bid (€)')).toBeInTheDocument();
    expect(screen.getByText('Place Bid')).toBeInTheDocument();
  });

  it('filters by pending status', async () => {
    vi.mocked(listBids).mockResolvedValueOnce({ bids: mockBids });
    render(<BidsPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByText('pending-bid.com')).toBeInTheDocument();
    });

    await userEvent.click(screen.getByText('Pending'));

    expect(screen.getByText('pending-bid.com')).toBeInTheDocument();
    expect(screen.queryByText('won-bid.com')).not.toBeInTheDocument();
  });

  it('shows error state', async () => {
    vi.mocked(listBids).mockRejectedValueOnce(new Error('Failed to load bids'));
    render(<BidsPage />, { wrapper: createWrapper() });

    await waitFor(() => {
      expect(screen.getByText(/Failed to load bids/)).toBeInTheDocument();
    });
  });
});
