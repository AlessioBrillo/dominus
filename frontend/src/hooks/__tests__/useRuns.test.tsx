// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('@/api/runs', () => ({
  fetchRuns: vi.fn(),
  fetchRun: vi.fn(),
  submitRun: vi.fn(),
  deleteRun: vi.fn(),
  pruneRuns: vi.fn(),
}));

import { toast } from 'sonner';
import { useRunsList, useRun, useSubmitRun, useDeleteRun, usePruneRuns } from '../useRuns';
import { fetchRuns, fetchRun, submitRun, deleteRun, pruneRuns } from '@/api/runs';

const mockedFetchRuns = vi.mocked(fetchRuns);
const mockedFetchRun = vi.mocked(fetchRun);
const mockedSubmit = vi.mocked(submitRun);
const mockedDelete = vi.mocked(deleteRun);
const mockedPrune = vi.mocked(pruneRuns);

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useRunsList', () => {
  it('fetches the runs', async () => {
    mockedFetchRuns.mockResolvedValueOnce([
      {
        runId: 'r1',
        startedAt: '2026-07-01T00:00:00Z',
        stageSummary: {},
        resultsSummary: {
          candidatesEvaluated: 0,
          recommended: 0,
          trademarkBlocked: 0,
          unscored: 0,
          errors: 0,
        },
      },
    ]);
    const { result } = renderHook(() => useRunsList(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(1);
  });

  it('surfaces a fetch error', async () => {
    mockedFetchRuns.mockRejectedValueOnce(new Error('list failed'));
    const { result } = renderHook(() => useRunsList(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

describe('useRun', () => {
  it('fetches the run detail when an id is present', async () => {
    mockedFetchRun.mockResolvedValueOnce({
      runId: 'r1',
      startedAt: '2026-07-01T00:00:00Z',
      stageSummary: {},
      resultsSummary: {
        candidatesEvaluated: 0,
        recommended: 0,
        trademarkBlocked: 0,
        unscored: 0,
        errors: 0,
      },
    });
    const { result } = renderHook(() => useRun('r1'), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(fetchRun).toHaveBeenCalledWith('r1');
  });

  it('stays idle without a run id', async () => {
    const { result } = renderHook(() => useRun(undefined), { wrapper: createWrapper() });

    expect(result.current.isPending).toBe(true);
    expect(fetchRun).not.toHaveBeenCalled();
  });
});

describe('useSubmitRun', () => {
  it('submits and notifies success', async () => {
    mockedSubmit.mockResolvedValueOnce({ runId: 'r1' });
    const { result } = renderHook(() => useSubmitRun(), { wrapper: createWrapper() });

    act(() => result.current.mutate({ keywords: ['a'] }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(submitRun).toHaveBeenCalledWith({ keywords: ['a'] }, expect.anything());
    expect(toast.success).toHaveBeenCalledWith('Pipeline run submitted');
  });

  it('notifies an error on failure', async () => {
    mockedSubmit.mockRejectedValueOnce(new Error('submit failed'));
    const { result } = renderHook(() => useSubmitRun(), { wrapper: createWrapper() });

    act(() => result.current.mutate({ keywords: ['a'] }));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(toast.error).toHaveBeenCalledWith('submit failed');
  });
});

describe('useDeleteRun', () => {
  it('deletes and notifies success', async () => {
    mockedDelete.mockResolvedValueOnce(undefined);
    const { result } = renderHook(() => useDeleteRun(), { wrapper: createWrapper() });

    act(() => result.current.mutate('r1'));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(deleteRun).toHaveBeenCalledWith('r1');
    expect(toast.success).toHaveBeenCalledWith('Run deleted');
  });

  it('notifies an error on failure', async () => {
    mockedDelete.mockRejectedValueOnce(new Error('delete failed'));
    const { result } = renderHook(() => useDeleteRun(), { wrapper: createWrapper() });

    act(() => result.current.mutate('r1'));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(toast.error).toHaveBeenCalledWith('delete failed');
  });
});

describe('usePruneRuns', () => {
  it('prunes and notifies the count', async () => {
    mockedPrune.mockResolvedValueOnce({ deleted: 3 });
    const { result } = renderHook(() => usePruneRuns(), { wrapper: createWrapper() });

    act(() => result.current.mutate(true));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(pruneRuns).toHaveBeenCalledWith(true);
    expect(toast.success).toHaveBeenCalledWith('Pruned 3 runs');
  });

  it('notifies an error on failure', async () => {
    mockedPrune.mockRejectedValueOnce(new Error('prune failed'));
    const { result } = renderHook(() => usePruneRuns(), { wrapper: createWrapper() });

    act(() => result.current.mutate(true));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(toast.error).toHaveBeenCalledWith('prune failed');
  });
});
