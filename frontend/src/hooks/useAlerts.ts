// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { acknowledgeAlert, acknowledgeAllAlerts } from '@/api/alerts';
import { queryKeys } from './query-keys';

/** Dismissing an alert changes the dashboard's active-alert count and list. */
function useRefreshDashboard() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: queryKeys.dashboard.all });
}

export function useAcknowledgeAlert() {
  const refresh = useRefreshDashboard();
  return useMutation({
    mutationFn: (id: number) => acknowledgeAlert(id),
    onSuccess: refresh,
    onError: () => toast.error('Could not dismiss the alert'),
  });
}

export function useAcknowledgeAllAlerts() {
  const refresh = useRefreshDashboard();
  return useMutation({
    mutationFn: () => acknowledgeAllAlerts(),
    onSuccess: refresh,
    onError: () => toast.error('Could not dismiss the alerts'),
  });
}
