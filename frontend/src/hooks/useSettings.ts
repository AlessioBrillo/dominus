import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';
import { queryKeys } from './query-keys';
import type { HealthResponse, ProviderStatus } from '@/types/domain';

export function useHealth() {
  return useQuery({
    queryKey: queryKeys.settings.health(),
    queryFn: () => api.get<HealthResponse>('/health'),
    staleTime: 30_000,
    retry: 1,
  });
}

export function useProviders() {
  return useQuery({
    queryKey: queryKeys.settings.providers(),
    queryFn: () => api.get<{ providers: ProviderStatus[] }>('/providers/status'),
    staleTime: 60_000,
    retry: 1,
    select: (data: { providers: ProviderStatus[] }) => data.providers,
  });
}

export type { HealthResponse, ProviderStatus };
