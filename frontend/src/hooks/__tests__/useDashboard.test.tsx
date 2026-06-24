import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { createTestQueryClient } from './test-utils';

vi.mock('@/api/dashboard', () => ({
  fetchDashboardStats: vi.fn(),
}));

import { useDashboardStats } from '../useDashboard';
import { fetchDashboardStats } from '@/api/dashboard';
import type { DashboardResult } from '@/api/dashboard';
import { QueryClientProvider } from '@tanstack/react-query';

const mockStats: DashboardResult = {
  stats: {
    totalDomains: 10,
    keepCount: 5,
    dropCount: 3,
    repriceCount: 2,
    totalListValue: 15000,
    activeAlertCount: 1,
    recentAlerts: [
      {
        id: 1,
        domain: 'example.com',
        alertType: 'expiring',
        severity: 'warning',
        message: 'Expiring soon',
        acknowledgedAt: undefined,
        createdAt: '2026-06-01T00:00:00Z',
      },
    ],
    health: { status: 'ok', uptime: 3600, version: '0.4.0', timestamp: '2026-06-23T00:00:00Z' },
  },
  partialFailure: false,
  failureReasons: [],
};

function renderUseDashboardStats() {
  const queryClient = createTestQueryClient();
  return renderHook(() => useDashboardStats(), {
    wrapper: ({ children }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  });
}

describe('useDashboardStats', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns dashboard stats on success', async () => {
    vi.mocked(fetchDashboardStats).mockResolvedValueOnce(mockStats);
    const { result } = renderUseDashboardStats();

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual(mockStats);
    expect(result.current.data?.stats.totalDomains).toBe(10);
    expect(result.current.data?.stats.activeAlertCount).toBe(1);
  });

  it('handles fetch failure', async () => {
    vi.useFakeTimers();
    vi.mocked(fetchDashboardStats).mockRejectedValueOnce(new Error('Network error'));
    const { result } = renderUseDashboardStats();

    await vi.advanceTimersByTimeAsync(5000);
    vi.useRealTimers();

    expect(result.current.isError).toBe(true);
    expect(result.current.error).toBeDefined();
  });
});
