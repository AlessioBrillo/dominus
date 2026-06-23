import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

vi.mock('@/api/bids', () => ({
  listBids: vi.fn(),
  placeBid: vi.fn(),
  resolveBid: vi.fn(),
}));

import { useBidsList, usePlaceBid, useResolveBid } from '../useBids';
import { listBids, placeBid, resolveBid } from '@/api/bids';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Bid } from '@/types/domain';

const mockBids: Bid[] = [
  {
    domain: 'example.com',
    venue: 'afternic',
    bidAmountEur: 100,
    status: 'pending',
    bidPlacedAt: '2026-06-01T00:00:00Z',
  },
];

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe('useBidsList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns bids', async () => {
    vi.mocked(listBids).mockResolvedValueOnce({ bids: mockBids });
    const { result } = renderHook(() => useBidsList(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual(mockBids);
    expect(result.current.data).toHaveLength(1);
  });

  it('handles empty bids', async () => {
    vi.mocked(listBids).mockResolvedValueOnce({ bids: [] });
    const { result } = renderHook(() => useBidsList(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual([]);
  });

  it('handles error', async () => {
    vi.mocked(listBids).mockRejectedValueOnce(new Error('API error'));
    const { result } = renderHook(() => useBidsList(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

describe('usePlaceBid', () => {
  it('places a bid and invalidates cache', async () => {
    vi.mocked(placeBid).mockResolvedValueOnce({ bid: mockBids[0]! });
    const { result } = renderHook(() => usePlaceBid(), { wrapper: createWrapper() });

    result.current.mutate({ domain: 'example.com', bidAmountEur: 100 });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(placeBid).toHaveBeenCalledWith({ domain: 'example.com', bidAmountEur: 100 });
  });
});

describe('useResolveBid', () => {
  it('resolves a bid', async () => {
    vi.mocked(resolveBid).mockResolvedValueOnce({ bid: { ...mockBids[0]!, status: 'won' } });
    const { result } = renderHook(() => useResolveBid(), { wrapper: createWrapper() });

    result.current.mutate({ domain: 'example.com', status: 'won' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(resolveBid).toHaveBeenCalledWith({ domain: 'example.com', status: 'won' });
  });
});
