// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('@/api/scheduler', () => ({
  fetchSchedulerStatus: vi.fn(),
  runSchedulerJob: vi.fn(),
}));

import { toast } from 'sonner';
import { useSchedulerStatus, useRunSchedulerJob } from '../useScheduler';
import { fetchSchedulerStatus, runSchedulerJob } from '@/api/scheduler';

const mockedFetch = vi.mocked(fetchSchedulerStatus);
const mockedRun = vi.mocked(runSchedulerJob);

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

describe('useSchedulerStatus', () => {
  it('fetches the scheduler jobs', async () => {
    mockedFetch.mockResolvedValueOnce([{ name: 'backup', cron: '* * * * *', enabled: true }]);
    const { result } = renderHook(() => useSchedulerStatus(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(1);
  });

  it('surfaces a fetch error', async () => {
    mockedFetch.mockRejectedValueOnce(new Error('status failed'));
    const { result } = renderHook(() => useSchedulerStatus(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

describe('useRunSchedulerJob', () => {
  it('runs a job and notifies success', async () => {
    mockedRun.mockResolvedValueOnce({ started: true });
    const { result } = renderHook(() => useRunSchedulerJob(), { wrapper: createWrapper() });

    act(() => result.current.mutate('backup'));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(runSchedulerJob).toHaveBeenCalledWith('backup');
    expect(toast.success).toHaveBeenCalledWith('Job "backup" started');
  });

  it('notifies an error on failure', async () => {
    mockedRun.mockRejectedValueOnce(new Error('run failed'));
    const { result } = renderHook(() => useRunSchedulerJob(), { wrapper: createWrapper() });

    act(() => result.current.mutate('backup'));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(toast.error).toHaveBeenCalledWith('run failed');
  });
});
