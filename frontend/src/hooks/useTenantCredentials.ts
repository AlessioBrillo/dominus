// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  listTenantCredentials,
  setTenantCredential,
  deleteTenantCredential,
  type TenantCredentialView,
} from '@/api/tenant-credentials';
import type { CredentialProviderType } from '@/api/tenant-credentials';
import { queryKeys } from './query-keys';

/** Metadata (never secrets) for the tenant's configured provider credentials. */
export function useTenantCredentials() {
  return useQuery({
    queryKey: queryKeys.tenantCredentials.all,
    queryFn: listTenantCredentials,
    select: (data: { credentials: TenantCredentialView[] }) => data.credentials,
  });
}

export function useSetTenantCredential() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      providerType,
      providerName,
      input,
    }: {
      providerType: CredentialProviderType;
      providerName: string;
      input: Parameters<typeof setTenantCredential>[2];
    }) => setTenantCredential(providerType, providerName, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tenantCredentials.all });
      toast.success('Credential stored — it will not be shown in plaintext again.');
    },
    onError: (err: Error) => toast.error(err.message),
  });
}

export function useDeleteTenantCredential() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      providerType,
      providerName,
    }: {
      providerType: CredentialProviderType;
      providerName: string;
    }) => deleteTenantCredential(providerType, providerName),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tenantCredentials.all });
      toast.success('Credential removed.');
    },
    onError: (err: Error) => toast.error(err.message),
  });
}
