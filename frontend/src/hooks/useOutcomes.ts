// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { createOutcome, type CreateOutcomeInput } from '@/api/outcomes';
import { queryKeys } from './query-keys';

export function useOutcomesList() {
  return useQuery({
    queryKey: queryKeys.outcomes.list(),
    queryFn: () => import('@/api/outcomes').then((m) => m.listOutcomes()),
    staleTime: 30_000,
  });
}

export function useRecordOutcome() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateOutcomeInput) => createOutcome(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.outcomes.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.analytics.all });
    },
  });
}
