import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import { queryKeys } from './query-keys';
import type { Outcome } from '@/types/domain';

export function useOutcomesList() {
  return useQuery({
    queryKey: queryKeys.outcomes.list(),
    queryFn: () => api.get<{ outcomes: Outcome[] }>('/outcomes'),
    staleTime: 30_000,
    select: (data: { outcomes: Outcome[] }) => data.outcomes,
  });
}

export type { Outcome };
