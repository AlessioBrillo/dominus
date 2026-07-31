import { useQuery, useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  fetchSubscription,
  createCheckoutSession,
  createPortalSession,
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
