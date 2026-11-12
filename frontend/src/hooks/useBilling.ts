// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  fetchSubscription,
  createCheckoutSession,
  createPortalSession,
  changeSubscription,
  cancelSubscription,
  type BillingInterval,
  type BillingPlan,
} from '@/api/billing';
import { queryKeys } from './query-keys';

export function useSubscription() {
  return useQuery({
    queryKey: queryKeys.billing.subscription(),
    queryFn: fetchSubscription,
    staleTime: 30_000,
  });
}

export function useCreateCheckoutSession() {
  return useMutation({
    mutationFn: (params: {
      plan: BillingPlan;
      interval: BillingInterval;
      successUrl: string;
      cancelUrl: string;
    }) => createCheckoutSession(params.plan, params.interval, params.successUrl, params.cancelUrl),
    onError: () => toast.error('Failed to create checkout session'),
  });
}

export function useCreatePortalSession() {
  return useMutation({
    mutationFn: (returnUrl: string) => createPortalSession(returnUrl),
    onError: () => toast.error('Failed to open billing portal'),
  });
}

/**
 * A plan change mutates the existing subscription. The local view is
 * refetched when it succeeds: the plan is granted when the payment
 * provider confirms the change, so the screen may lag by a moment.
 */
export function useChangeSubscription() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: { plan: BillingPlan; interval: BillingInterval }) =>
      changeSubscription(params.plan, params.interval),
    onSuccess: () => {
      toast.success('The plan was changed. The new limits apply as soon as it is confirmed.');
      void queryClient.invalidateQueries({ queryKey: queryKeys.billing.subscription() });
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : 'Failed to change the plan');
    },
  });
}

export function useCancelSubscription() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (mode: 'immediate' | 'period_end') => cancelSubscription(mode),
    onSuccess: () => {
      toast.success('The subscription was cancelled.');
      void queryClient.invalidateQueries({ queryKey: queryKeys.billing.subscription() });
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : 'Failed to cancel the subscription');
    },
  });
}
