// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { fetchApiKeys, createApiKey, revokeApiKey } from '@/api/keys';
import { queryKeys } from './query-keys';

export function useApiKeys() {
  return useQuery({
    queryKey: queryKeys.apiKeys.list(),
    queryFn: ({ signal }) => fetchApiKeys(signal),
    staleTime: 30_000,
    // 404 (community edition: keys come from the environment) and 403 (not an
    // admin) are answers, not transient failures.
    retry: false,
  });
}

export function useCreateApiKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; role: 'admin' | 'member' }) =>
      createApiKey(input.name, input.role),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys.all }),
  });
}

export function useRevokeApiKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => revokeApiKey(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys.all }),
    onError: () => toast.error('Failed to revoke the key'),
  });
}
