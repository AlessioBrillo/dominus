// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('@/api/backtest', () => ({
  fetchBacktestReport: vi.fn(),
  rebuildSnapshot: vi.fn(),
  suggestWeights: vi.fn(),
  runAutoTune: vi.fn(),
}));

import { toast } from 'sonner';
import {
  useBacktestReport,
  useRebuildSnapshot,
  useSuggestWeights,
  useAutoTune,
} from '../useBacktest';
import { fetchBacktestReport, rebuildSnapshot, suggestWeights, runAutoTune } from '@/api/backtest';

const mockedFetch = vi.mocked(fetchBacktestReport);
const mockedRebuild = vi.mocked(rebuildSnapshot);
const mockedSuggest = vi.mocked(suggestWeights);
const mockedTune = vi.mocked(runAutoTune);

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

describe('useBacktestReport', () => {
  it('fetches the backtest report', async () => {
    mockedFetch.mockResolvedValueOnce({
      sampleSize: 5,
      accuracy: {
        generatedAt: '2026-07-01T00:00:00Z',
        sampleSize: 5,
        overall: {
          mape: 0.1,
          medianApe: 0.08,
          mae: 5,
          rmse: 7,
          bias: 0.5,
          biasPct: 0.04,
          sampleSize: 5,
        },
        confusionMatrix: {
          truePositives: 2,
          falsePositives: 1,
          trueNegatives: 1,
          falseNegatives: 1,
          precision: 0.67,
          recall: 0.67,
          f1: 0.67,
        },
        calibration: {},
        warnings: [],
      },
    });
    const { result } = renderHook(() => useBacktestReport(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toMatchObject({ sampleSize: 5 });
  });

  it('surfaces a fetch error', async () => {
    mockedFetch.mockRejectedValue(new Error('report failed'));
    const { result } = renderHook(() => useBacktestReport(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isError).toBe(true), { timeout: 3000 });
  });
});

describe('useRebuildSnapshot', () => {
  it('rebuilds and notifies on success', async () => {
    mockedRebuild.mockResolvedValueOnce({ rebuilt: true, outcomeCount: 1, signalCount: 1 });
    const { result } = renderHook(() => useRebuildSnapshot(), { wrapper: createWrapper() });

    act(() => result.current.mutate());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedRebuild).toHaveBeenCalledOnce();
    expect(toast.success).toHaveBeenCalledWith('Backtest signals rebuilt');
  });

  it('notifies an error on failure', async () => {
    mockedRebuild.mockRejectedValueOnce(new Error('rebuild failed'));
    const { result } = renderHook(() => useRebuildSnapshot(), { wrapper: createWrapper() });

    act(() => result.current.mutate());
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(toast.error).toHaveBeenCalledWith('rebuild failed');
  });
});

describe('useSuggestWeights', () => {
  it('suggests weights with the apply flag and notifies success', async () => {
    mockedSuggest.mockResolvedValueOnce({ current: {}, suggested: {}, delta: {}, sampleSize: 1 });
    const { result } = renderHook(() => useSuggestWeights(), { wrapper: createWrapper() });

    act(() => result.current.mutate(true));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(suggestWeights).toHaveBeenCalledWith(true);
    expect(toast.success).toHaveBeenCalledWith('Weight suggestion generated');
  });

  it('notifies an error on failure', async () => {
    mockedSuggest.mockRejectedValueOnce(new Error('suggest failed'));
    const { result } = renderHook(() => useSuggestWeights(), { wrapper: createWrapper() });

    act(() => result.current.mutate(false));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(toast.error).toHaveBeenCalledWith('suggest failed');
  });
});

describe('useAutoTune', () => {
  it('notifies applied mode', async () => {
    mockedTune.mockResolvedValueOnce({
      applied: true,
      dryRun: false,
      suggestion: { current: {}, suggested: {}, delta: {}, sampleSize: 1 },
    });
    const { result } = renderHook(() => useAutoTune(), { wrapper: createWrapper() });

    act(() => result.current.mutate());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(toast.success).toHaveBeenCalledWith('Weights auto-tuned and applied');
  });

  it('notifies dry-run mode', async () => {
    mockedTune.mockResolvedValueOnce({
      applied: false,
      dryRun: true,
      suggestion: { current: {}, suggested: {}, delta: {}, sampleSize: 1 },
    });
    const { result } = renderHook(() => useAutoTune(), { wrapper: createWrapper() });

    act(() => result.current.mutate());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(toast.info).toHaveBeenCalledWith('Weights suggest generated (dry-run mode)');
  });

  it('notifies an error on failure', async () => {
    mockedTune.mockRejectedValueOnce(new Error('tune failed'));
    const { result } = renderHook(() => useAutoTune(), { wrapper: createWrapper() });

    act(() => result.current.mutate());
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(toast.error).toHaveBeenCalledWith('tune failed');
  });
});
