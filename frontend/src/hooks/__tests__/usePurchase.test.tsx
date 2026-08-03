// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('@/api/purchase', () => ({
  preflightPurchase: vi.fn(),
  executePurchase: vi.fn(),
}));

import { toast } from 'sonner';
import { usePreflight, useExecutePurchase } from '../usePurchase';
import { preflightPurchase, executePurchase } from '@/api/purchase';

const mockedPreflight = vi.mocked(preflightPurchase);
const mockedExecute = vi.mocked(executePurchase);

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

describe('usePreflight', () => {
  it('runs the preflight check for a domain', async () => {
    mockedPreflight.mockResolvedValueOnce({
      check: {
        domain: 'a.com',
        available: true,
        registerPriceEur: null,
        renewalPriceEur: null,
        expectedValue: null,
        confidence: null,
        suggestedBuyMax: null,
        trademarkClear: true,
        operatorApprovalRequired: false,
      },
    });
    const { result } = renderHook(() => usePreflight('a.com'), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(preflightPurchase).toHaveBeenCalledWith('a.com');
  });

  it('stays idle when the domain is missing', async () => {
    const { result } = renderHook(() => usePreflight(null), { wrapper: createWrapper() });

    expect(result.current.isPending).toBe(true);
    expect(preflightPurchase).not.toHaveBeenCalled();
  });

  it('stays idle for an empty domain', async () => {
    const { result } = renderHook(() => usePreflight(''), { wrapper: createWrapper() });

    expect(result.current.isPending).toBe(true);
    expect(preflightPurchase).not.toHaveBeenCalled();
  });
});

describe('useExecutePurchase', () => {
  it('notifies success with the purchased domain', async () => {
    mockedExecute.mockResolvedValueOnce({
      success: true,
      purchase: {
        domain: 'a.com',
        registrar: 'x',
        priceEur: 10,
        renewalPriceEur: 12,
        purchasedAt: '2026-01-01',
      },
    });
    const { result } = renderHook(() => useExecutePurchase(), { wrapper: createWrapper() });

    act(() => result.current.mutate({ domain: 'a.com' }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(executePurchase).toHaveBeenCalledWith('a.com', undefined, undefined);
    expect(toast.success).toHaveBeenCalledWith('a.com purchased successfully');
  });

  it('notifies an error message when the purchase reports a failure', async () => {
    mockedExecute.mockResolvedValueOnce({ success: false, error: 'declined' });
    const { result } = renderHook(() => useExecutePurchase(), { wrapper: createWrapper() });

    act(() => result.current.mutate({ domain: 'a.com' }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(toast.error).toHaveBeenCalledWith('declined');
  });

  it('falls back to a generic message', async () => {
    mockedExecute.mockResolvedValueOnce({ success: false });
    const { result } = renderHook(() => useExecutePurchase(), { wrapper: createWrapper() });

    act(() => result.current.mutate({ domain: 'a.com' }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(toast.error).toHaveBeenCalledWith('Purchase failed');
  });

  it('notifies a request error on rejection', async () => {
    mockedExecute.mockRejectedValueOnce(new Error('down'));
    const { result } = renderHook(() => useExecutePurchase(), { wrapper: createWrapper() });

    act(() => result.current.mutate({ domain: 'a.com' }));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(toast.error).toHaveBeenCalledWith('Purchase request failed');
  });
});
