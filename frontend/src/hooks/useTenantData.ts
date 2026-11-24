// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { eraseTenant, exportTenantData, type TenantExport } from '@/api/tenant-data';
import { useAuth } from './useAuth';

function downloadJson(data: TenantExport): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `dominus-export-${data.tenantId}-${data.generatedAt.slice(0, 10)}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/** Art. 15: the reader downloads their own workspace, not a support ticket. */
export function useExportTenantData() {
  return useMutation({
    mutationFn: exportTenantData,
    onSuccess: (data) => {
      downloadJson(data);
      toast.success(`Exported ${data.totalRows} rows`);
    },
    onError: () => toast.error('Could not export your data'),
  });
}

/** Art. 17: erasure cancels the subscription and signs the browser out. */
export function useEraseTenant() {
  const queryClient = useQueryClient();
  const { logout } = useAuth();
  return useMutation({
    mutationFn: (confirm: string) => eraseTenant(confirm),
    onSuccess: (report) => {
      queryClient.clear();
      toast.success(
        report.subscriptionCancelled === false
          ? 'Workspace erased. Contact support about the outstanding invoice.'
          : 'Workspace erased',
      );
      logout();
    },
    onError: () => toast.error('Could not erase the workspace'),
  });
}
