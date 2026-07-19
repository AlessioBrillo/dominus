import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from './query-keys';
import { fetchRuns, fetchRun, submitRun, deleteRun, pruneRuns } from '@/api/runs';
import type { PipelineRun } from '@/types/domain';
import { toast } from 'sonner';

export function useRunsList() {
  return useQuery({
    queryKey: queryKeys.runs.list(),
    queryFn: () => fetchRuns(),
    staleTime: 15_000,
  });
}

export function useRun(runId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.runs.detail(runId),
    queryFn: () => fetchRun(runId!),
    enabled: !!runId,
    staleTime: 10_000,
  });
}

export function useSubmitRun() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: submitRun,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.runs.all });
      toast.success('Pipeline run submitted');
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
  });
}

export function useDeleteRun() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (runId: string) => deleteRun(runId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.runs.all });
      toast.success('Run deleted');
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
  });
}

export function usePruneRuns() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (dryRun?: boolean) => pruneRuns(dryRun),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.runs.all });
      toast.success(`Pruned ${result.deleted} runs`);
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
  });
}

export type { PipelineRun };
