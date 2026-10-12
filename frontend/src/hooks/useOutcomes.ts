// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { createOutcome, listOutcomes, type CreateOutcomeInput } from '@/api/outcomes';
import { queryKeys } from './query-keys';

export function useOutcomesList() {
  return useQuery({
    queryKey: queryKeys.outcomes.list(),
    // Static import, not `import('@/api/outcomes')`: the static import at the
    // top of this file already pulls the module into whatever chunk this hook
    // lands in, so the dynamic form cannot split it and only produces an
    // INEFFECTIVE_DYNAMIC_IMPORT warning.
    queryFn: () => listOutcomes(),
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
