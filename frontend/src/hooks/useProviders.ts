import { useQuery } from '@tanstack/react-query';
import { queryKeys } from './query-keys';
import { fetchProviderStatuses } from '@/api/providers';
import type { ProviderStatus } from '@/types/domain';

export function useProviderStatuses() {
  return useQuery({
    queryKey: queryKeys.settings.providers(),
    queryFn: fetchProviderStatuses,
    staleTime: 30_000,
  });
}

export type { ProviderStatus };
