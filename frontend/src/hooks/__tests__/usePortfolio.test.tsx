import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

vi.mock('@/api/portfolio', () => ({
  fetchPortfolio: vi.fn(),
  rescorePortfolio: vi.fn(),
  refreshVerdicts: vi.fn(),
}));

import { usePortfolioList, useRescorePortfolio, useRefreshVerdicts } from '../usePortfolio';
import { fetchPortfolio, rescorePortfolio, refreshVerdicts } from '@/api/portfolio';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mockPortfolio = [
  {
    id: 1,
    domain: 'example.com',
    tld: 'com',
    acquiredAt: '2026-01-01T00:00:00Z',
    renewalDate: '2027-01-01T00:00:00Z',
    acquisitionCost: 10,
    renewalCost: 12,
    registrar: 'manual',
    currentScore: 0.75,
    suggestedListPrice: 1500,
    verdict: 'keep',
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

describe('usePortfolioList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns portfolio entries', async () => {
    vi.mocked(fetchPortfolio).mockResolvedValueOnce({ portfolio: mockPortfolio });
    const { result } = renderHook(() => usePortfolioList(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual(mockPortfolio);
    expect(result.current.data).toHaveLength(1);
  });

  it('handles empty portfolio', async () => {
    vi.mocked(fetchPortfolio).mockResolvedValueOnce({ portfolio: [] });
    const { result } = renderHook(() => usePortfolioList(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual([]);
  });

  it('handles fetch error', async () => {
    vi.mocked(fetchPortfolio).mockRejectedValueOnce(new Error('Failed to fetch'));
    const { result } = renderHook(() => usePortfolioList(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

describe('useRescorePortfolio', () => {
  it('triggers rescore mutation', async () => {
    const mockResponse = { totalDurationMs: 500, results: [] };
    vi.mocked(rescorePortfolio).mockResolvedValueOnce(mockResponse);

    const { result } = renderHook(() => useRescorePortfolio(), { wrapper: createWrapper() });

    result.current.mutate();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(rescorePortfolio).toHaveBeenCalledOnce();
  });
});

describe('useRefreshVerdicts', () => {
  it('triggers verdict refresh mutation', async () => {
    vi.mocked(refreshVerdicts).mockResolvedValueOnce({ ok: true });

    const { result } = renderHook(() => useRefreshVerdicts(), { wrapper: createWrapper() });

    result.current.mutate();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(refreshVerdicts).toHaveBeenCalledOnce();
  });
});
