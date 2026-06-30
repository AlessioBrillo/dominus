import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useOutcomesList } from '../useOutcomes';
import type { Outcome } from '@/types/domain';

const mockOutcomes: Outcome[] = [
  {
    id: 1,
    domain: 'sold.com',
    type: 'sold',
    occurredAt: '2026-06-01T00:00:00Z',
    salePriceEur: 1500,
  },
  { id: 2, domain: 'drop.net', type: 'dropped', occurredAt: '2026-05-01T00:00:00Z' },
];

vi.mock('@/api/outcomes', () => ({
  listOutcomes: vi.fn(),
}));

import { listOutcomes } from '@/api/outcomes';

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
    vi.mocked(listOutcomes).mockResolvedValueOnce(mockOutcomes);
    const { result } = renderHook(() => useOutcomesList(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual(mockOutcomes);
    expect(result.current.data).toHaveLength(2);
  });

  it('handles empty outcomes', async () => {
    vi.mocked(listOutcomes).mockResolvedValueOnce([]);
    const { result } = renderHook(() => useOutcomesList(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual([]);
  });

  it('handles error', async () => {
    vi.mocked(listOutcomes).mockRejectedValueOnce(new Error('API error'));
    const { result } = renderHook(() => useOutcomesList(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});
