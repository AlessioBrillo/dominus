import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchPnlReport, fetchAccuracyReport, refreshAccuracy } from '@/api/analytics';
import { queryKeys } from './query-keys';
import type { PnlReport, AccuracyReport } from '@/types/domain';

export function usePnlReport() {
  return useQuery({
    queryKey: queryKeys.analytics.pnl(),
    queryFn: fetchPnlReport,
    staleTime: 30_000,
  });
}

export function useAccuracyReport() {
  return useQuery({
    queryKey: queryKeys.analytics.accuracy(),
    queryFn: fetchAccuracyReport,
    staleTime: 60_000,
  });
}

export function useRefreshAccuracy() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: refreshAccuracy,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.analytics.accuracy() });
    },
  });
}

export type { PnlReport, AccuracyReport };
