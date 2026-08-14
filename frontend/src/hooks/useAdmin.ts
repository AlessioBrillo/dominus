// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  fetchAdminOverview,
  fetchAdminTenants,
  fetchAdminTenantUsage,
  suspendTenant as suspendTenantRequest,
  unsuspendTenant as unsuspendTenantRequest,
  setPlanOverride as setPlanOverrideRequest,
  type AdminPlan,
} from '@/api/admin';
import { queryKeys } from './query-keys';

export function useAdminOverview() {
  return useQuery({
    queryKey: queryKeys.admin.overview(),
    queryFn: fetchAdminOverview,
    staleTime: 30_000,
  });
}

export function useAdminTenants() {
  return useQuery({
    queryKey: queryKeys.admin.tenants(),
    queryFn: fetchAdminTenants,
    staleTime: 30_000,
  });
}

export function useAdminTenantUsage(tenantId: string, days: number) {
  return useQuery({
    queryKey: queryKeys.admin.tenantUsage(tenantId, days),
    queryFn: ({ signal }) => fetchAdminTenantUsage(tenantId, days, signal),
    enabled: days > 0,
    staleTime: 15_000,
  });
}

function useInvalidateTenants() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.admin.tenants() });
    void queryClient.invalidateQueries({ queryKey: queryKeys.admin.overview() });
  };
}

export function useSuspendTenant() {
  const invalidate = useInvalidateTenants();
  return useMutation({
    mutationFn: (params: { tenantId: string; reason: string | null }) =>
      suspendTenantRequest(params.tenantId, params.reason),
    onSuccess: () => {
      toast.success('Tenant suspended');
      invalidate();
    },
    onError: () => toast.error('Failed to suspend tenant'),
  });
}

export function useUnsuspendTenant() {
  const invalidate = useInvalidateTenants();
  return useMutation({
    mutationFn: (tenantId: string) => unsuspendTenantRequest(tenantId),
    onSuccess: () => {
      toast.success('Tenant restored');
      invalidate();
    },
    onError: () => toast.error('Failed to restore tenant'),
  });
}

export function useSetPlanOverride() {
  const invalidate = useInvalidateTenants();
  return useMutation({
    mutationFn: (params: { tenantId: string; plan: AdminPlan | null }) =>
      setPlanOverrideRequest(params.tenantId, params.plan),
    onSuccess: () => {
      toast.success('Plan override applied');
      invalidate();
    },
    onError: () => toast.error('Failed to apply plan override'),
  });
}
