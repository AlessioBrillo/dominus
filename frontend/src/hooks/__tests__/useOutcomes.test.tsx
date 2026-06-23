import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

vi.mock('@/api/outcomes', () => ({
  fetchOutcomes: vi.fn(),
}));

import { useOutcomesList } from '../useOutcomes';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mockOutcomesData = {
  outcomes: [
    {
      id: 1,
      domain: 'sold.com',
      type: 'sold',
      occurredAt: '2026-06-01T00:00:00Z',
      salePriceEur: 1500,
    },
    { id: 2, domain: 'drop.net', type: 'dropped', occurredAt: '2026-05-01T00:00:00Z' },
  ],
};

// We need to mock the api call that useOutcomesList makes
vi.mock('@/api/client', () => ({
  api: {
    get: vi.fn(),
  },
}));

import { api } from '@/api/client';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe('useOutcomesList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns outcomes', async () => {
    vi.mocked(api.get).mockResolvedValueOnce(mockOutcomesData);
    const { result } = renderHook(() => useOutcomesList(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual(mockOutcomesData.outcomes);
    expect(result.current.data).toHaveLength(2);
  });

  it('handles empty outcomes', async () => {
    vi.mocked(api.get).mockResolvedValueOnce({ outcomes: [] });
    const { result } = renderHook(() => useOutcomesList(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual([]);
  });

  it('handles error', async () => {
    vi.mocked(api.get).mockRejectedValueOnce(new Error('API error'));
    const { result } = renderHook(() => useOutcomesList(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});
