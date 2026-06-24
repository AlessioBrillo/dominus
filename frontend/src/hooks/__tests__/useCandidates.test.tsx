import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
vi.mock('@/api/candidates', () => ({
  fetchCandidates: vi.fn(),
  fetchRuns: vi.fn(),
  runPipeline: vi.fn(),
  deleteCandidate: vi.fn(),
}));

import {
  useCandidatesList,
  useRunsList,
  useRunPipeline,
  useDeleteCandidate,
} from '../useCandidates';
import { fetchCandidates, fetchRuns, runPipeline, deleteCandidate } from '@/api/candidates';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mockCandidates = [
  {
    id: 1,
    domain: 'test.com',
    tld: 'com',
    source: 'manual',
    status: 'new',
    createdAt: '2026-06-01T00:00:00Z',
  },
];

const mockRuns = [
  { runId: 'run-1', startedAt: '2026-06-01T00:00:00Z', stageSummary: {}, resultsSummary: {} },
];

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe('useCandidatesList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns candidates list', async () => {
    vi.mocked(fetchCandidates).mockResolvedValueOnce(mockCandidates);
    const { result } = renderHook(() => useCandidatesList(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual(mockCandidates);
    expect(result.current.data).toHaveLength(1);
  });

  it('returns empty array when no candidates', async () => {
    vi.mocked(fetchCandidates).mockResolvedValueOnce([]);
    const { result } = renderHook(() => useCandidatesList(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual([]);
  });

  it('handles error', async () => {
    vi.mocked(fetchCandidates).mockRejectedValueOnce(new Error('API error'));
    const { result } = renderHook(() => useCandidatesList(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

describe('useRunsList', () => {
  it('returns pipeline runs', async () => {
    vi.mocked(fetchRuns).mockResolvedValueOnce(mockRuns);
    const { result } = renderHook(() => useRunsList(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual(mockRuns);
  });
});

describe('useRunPipeline', () => {
  it('runs pipeline and invalidates queries', async () => {
    const mockResponse = {
      runId: 'run-1',
      recommended: [],
      stageSummary: {},
      totalDurationMs: 100,
    };
    vi.mocked(runPipeline).mockResolvedValueOnce(mockResponse);

    const { result } = renderHook(() => useRunPipeline(), { wrapper: createWrapper() });

    result.current.mutate();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(runPipeline).toHaveBeenCalledWith({});
  });
});

describe('useDeleteCandidate', () => {
  it('deletes a candidate', async () => {
    vi.mocked(deleteCandidate).mockResolvedValueOnce(undefined);

    const { result } = renderHook(() => useDeleteCandidate(), { wrapper: createWrapper() });

    result.current.mutate('test.com');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(deleteCandidate).toHaveBeenCalledWith('test.com');
  });
});
