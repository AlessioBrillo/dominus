import { useQuery } from '@tanstack/react-query';
import { fetchDashboardStats } from '@/api/dashboard';
import { queryKeys } from './query-keys';
import type { DashboardResult } from '@/api/dashboard';

export function useDashboardStats() {
  return useQuery({
    queryKey: queryKeys.dashboard.stats(),
    queryFn: ({ signal }) => fetchDashboardStats(signal),
    staleTime: 15_000,
    retry: 1,
  });
}

export type { DashboardResult };
