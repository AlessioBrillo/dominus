// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  getAutomationAudit,
  getAutomationSettings,
  getAutomationSteps,
  resetAutomation,
  runAutomation,
  updateAutomationSettings,
  type AutomationSettingsUpdate,
  type AutomationStepStatus,
} from '@/api/automation';
import { queryKeys } from './query-keys';

export function useAutomationSettings() {
  return useQuery({
    queryKey: queryKeys.automation.settings(),
    queryFn: getAutomationSettings,
    staleTime: 10_000,
  });
}

export function useAutomationSteps(status?: AutomationStepStatus) {
  return useQuery({
    queryKey: queryKeys.automation.steps(status),
    queryFn: () => getAutomationSteps({ ...(status ? { status } : {}), limit: 100 }),
    staleTime: 10_000,
  });
}

export function useAutomationAudit() {
  return useQuery({
    queryKey: queryKeys.automation.audit(),
    queryFn: () => getAutomationAudit(50),
    staleTime: 15_000,
  });
}

/** Changing the switch invalidates settings; running/resetting touches the journal. */
function useInvalidateAutomation() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: queryKeys.automation.all });
}

export function useUpdateAutomationSettings() {
  const invalidate = useInvalidateAutomation();
  return useMutation({
    mutationFn: (update: AutomationSettingsUpdate) => updateAutomationSettings(update),
    onSuccess: invalidate,
    onError: (err: Error) => toast.error(err.message),
  });
}

export function useRunAutomation() {
  const invalidate = useInvalidateAutomation();
  return useMutation({
    mutationFn: (domain: string) => runAutomation(domain),
    onSuccess: invalidate,
    onError: (err: Error) => toast.error(err.message),
  });
}

export function useResetAutomation() {
  const invalidate = useInvalidateAutomation();
  return useMutation({
    mutationFn: (domain: string) => resetAutomation(domain),
    onSuccess: invalidate,
    onError: (err: Error) => toast.error(err.message),
  });
}
