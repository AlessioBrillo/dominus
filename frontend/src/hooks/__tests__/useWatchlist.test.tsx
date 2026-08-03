// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('@/api/watchlist', () => ({
  fetchWatchlist: vi.fn(),
  addToWatchlist: vi.fn(),
  removeFromWatchlist: vi.fn(),
  pollWatchlist: vi.fn(),
}));

import { toast } from 'sonner';
import {
  useWatchlistList,
  useAddToWatchlist,
  useRemoveFromWatchlist,
  usePollWatchlist,
} from '../useWatchlist';
import {
  fetchWatchlist,
  addToWatchlist,
  removeFromWatchlist,
  pollWatchlist,
} from '@/api/watchlist';

const mockedFetch = vi.mocked(fetchWatchlist);
const mockedAdd = vi.mocked(addToWatchlist);
const mockedRemove = vi.mocked(removeFromWatchlist);
const mockedPoll = vi.mocked(pollWatchlist);

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

describe('useWatchlistList', () => {
  it('fetches the watchlist entries', async () => {
    mockedFetch.mockResolvedValueOnce([{ domain: 'a.com', addedAt: '2026-07-01T00:00:00Z' }]);
    const { result } = renderHook(() => useWatchlistList(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(1);
  });

  it('surfaces a fetch error', async () => {
    mockedFetch.mockRejectedValueOnce(new Error('list failed'));
    const { result } = renderHook(() => useWatchlistList(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

describe('useAddToWatchlist', () => {
  it('adds a domain and notifies success', async () => {
    mockedAdd.mockResolvedValueOnce({ domain: 'a.com', addedAt: '2026-07-01T00:00:00Z' });
    const { result } = renderHook(() => useAddToWatchlist(), { wrapper: createWrapper() });

    act(() => result.current.mutate({ domain: 'a.com', notes: 'n' }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(addToWatchlist).toHaveBeenCalledWith('a.com', 'n');
    expect(toast.success).toHaveBeenCalledWith('Domain added to watchlist');
  });

  it('notifies an error on failure', async () => {
    mockedAdd.mockRejectedValueOnce(new Error('add failed'));
    const { result } = renderHook(() => useAddToWatchlist(), { wrapper: createWrapper() });

    act(() => result.current.mutate({ domain: 'a.com' }));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(toast.error).toHaveBeenCalledWith('add failed');
  });
});

describe('useRemoveFromWatchlist', () => {
  it('removes a domain and notifies success', async () => {
    mockedRemove.mockResolvedValueOnce(undefined);
    const { result } = renderHook(() => useRemoveFromWatchlist(), { wrapper: createWrapper() });

    act(() => result.current.mutate('a.com'));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(removeFromWatchlist).toHaveBeenCalledWith('a.com');
    expect(toast.success).toHaveBeenCalledWith('Removed from watchlist');
  });

  it('notifies an error on failure', async () => {
    mockedRemove.mockRejectedValueOnce(new Error('remove failed'));
    const { result } = renderHook(() => useRemoveFromWatchlist(), { wrapper: createWrapper() });

    act(() => result.current.mutate('a.com'));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(toast.error).toHaveBeenCalledWith('remove failed');
  });
});

describe('usePollWatchlist', () => {
  it('polls and notifies the counts', async () => {
    mockedPoll.mockResolvedValueOnce({ checked: 10, changed: 2 });
    const { result } = renderHook(() => usePollWatchlist(), { wrapper: createWrapper() });

    act(() => result.current.mutate());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(pollWatchlist).toHaveBeenCalledOnce();
    expect(toast.success).toHaveBeenCalledWith('Polled 10 domains, 2 changed');
  });

  it('notifies an error on failure', async () => {
    mockedPoll.mockRejectedValueOnce(new Error('poll failed'));
    const { result } = renderHook(() => usePollWatchlist(), { wrapper: createWrapper() });

    act(() => result.current.mutate());
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(toast.error).toHaveBeenCalledWith('poll failed');
  });
});
