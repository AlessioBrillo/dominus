import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  fetchCandidates,
  fetchRuns,
  runPipeline,
  deleteCandidate,
  type RunPipelineResponse,
} from '@/api/candidates';
import { queryKeys } from './query-keys';
import type { Candidate, PipelineRun } from '@/types/domain';

export function useCandidatesList(runId?: string) {
  return useQuery({
    queryKey: queryKeys.candidates.list(runId),
    queryFn: () => fetchCandidates(runId),
    staleTime: 15_000,
  });
}

export function useRunsList() {
  return useQuery({
    queryKey: queryKeys.runs.list(),
    queryFn: fetchRuns,
    staleTime: 30_000,
  });
}

export function useRunPipeline() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => runPipeline({}),
    onSuccess: (result: RunPipelineResponse) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.candidates.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.runs.all });
      return result;
    },
  });
}

export function useDeleteCandidate() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (domain: string) => deleteCandidate(domain),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.candidates.all });
    },
  });
}

export type { Candidate, PipelineRun };
