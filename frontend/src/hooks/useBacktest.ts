import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from './query-keys';
import { rebuildSnapshot, fetchBacktestReport, suggestWeights, runAutoTune } from '@/api/backtest';
import type { WeightSuggestion, BacktestReportResponse, AutoTuneResponse } from '@/api/backtest';
import { toast } from 'sonner';

export function useBacktestReport() {
  return useQuery({
    queryKey: queryKeys.backtest.report(),
    queryFn: fetchBacktestReport,
    staleTime: 60_000,
    retry: 1,
  });
}

export function useRebuildSnapshot() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: rebuildSnapshot,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.backtest.all });
      toast.success('Backtest signals rebuilt');
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
  });
}

export function useSuggestWeights() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (apply?: boolean) => suggestWeights(apply),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.backtest.all });
      toast.success('Weight suggestion generated');
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
  });
}

export function useAutoTune() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: runAutoTune,
    onSuccess: (result: AutoTuneResponse) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.backtest.all });
      if (result.applied) {
        toast.success('Weights auto-tuned and applied');
      } else {
        toast.info('Weights suggest generated (dry-run mode)');
      }
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
  });
}

export type { WeightSuggestion, BacktestReportResponse, AutoTuneResponse };
