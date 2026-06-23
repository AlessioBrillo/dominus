import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

vi.mock('@/api/analytics', () => ({
  fetchPnlReport: vi.fn(),
  fetchAccuracyReport: vi.fn(),
  refreshAccuracy: vi.fn(),
}));

import { usePnlReport, useAccuracyReport, useRefreshAccuracy } from '../useAnalytics';
import { fetchPnlReport, fetchAccuracyReport, refreshAccuracy } from '@/api/analytics';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mockPnlReport = {
  generatedAt: '2026-06-23T00:00:00Z',
  summary: {
    totalInvestmentEur: 100,
    totalReturnsEur: 300,
    netPnlEur: 200,
    roiPct: 200,
    holdingCostsEur: 10,
    soldCount: 1,
    totalCount: 2,
  },
  perDomain: [],
  monthlyTrend: [],
};

const mockAccuracyReport = {
  generatedAt: '2026-06-23T00:00:00Z',
  sampleSize: 5,
  overall: { mape: 25, medianApe: 20, mae: 30, rmse: 40, bias: 5, biasPct: 10, sampleSize: 5 },
  confusionMatrix: {
    truePositives: 3,
    falsePositives: 1,
    trueNegatives: 1,
    falseNegatives: 0,
    precision: 0.75,
    recall: 1,
    f1: 0.857,
  },
  calibration: {},
  warnings: [],
};

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe('usePnlReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns P&L report', async () => {
    vi.mocked(fetchPnlReport).mockResolvedValueOnce(mockPnlReport);
    const { result } = renderHook(() => usePnlReport(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual(mockPnlReport);
  });

  it('handles fetch error', async () => {
    vi.mocked(fetchPnlReport).mockRejectedValueOnce(new Error('API error'));
    const { result } = renderHook(() => usePnlReport(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

describe('useAccuracyReport', () => {
  it('returns accuracy report', async () => {
    vi.mocked(fetchAccuracyReport).mockResolvedValueOnce(mockAccuracyReport);
    const { result } = renderHook(() => useAccuracyReport(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual(mockAccuracyReport);
    expect(result.current.data?.sampleSize).toBe(5);
  });
});

describe('useRefreshAccuracy', () => {
  it('triggers refresh mutation', async () => {
    vi.mocked(refreshAccuracy).mockResolvedValueOnce({ scanned: 5, included: 5 });
    const { result } = renderHook(() => useRefreshAccuracy(), { wrapper: createWrapper() });

    result.current.mutate();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(refreshAccuracy).toHaveBeenCalledOnce();
  });
});
