import { api } from './client.js';

export interface SubscriptionData {
  id: number;
  tenantId: string;
  plan: 'free' | 'pro' | 'enterprise';
  status: 'active' | 'past_due' | 'canceled' | 'incomplete' | 'trialing';
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  trialEnd: string | null;
  canceledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BillingResponse {
  subscription: SubscriptionData;
  plans: PlanCatalogEntry[];
  isStripeConfigured: boolean;
  publishableKey: string | null;
}

export type BillingPlan = 'pro' | 'enterprise';
export type BillingInterval = 'month' | 'year';

export interface PlanCatalogEntry {
  id: BillingPlan;
  name: string;
  monthlyPriceId: string | null;
  yearlyPriceId: string | null;
  available: boolean;
}

export interface PortalResponse {
  url: string;
}

export interface CheckoutResponse {
  url: string;
  plan: BillingPlan;
}

export function fetchSubscription(): Promise<BillingResponse> {
  return api.get<BillingResponse>('/billing');
}

export function createCheckoutSession(
  plan: BillingPlan,
  interval: BillingInterval,
  successUrl: string,
  cancelUrl: string,
): Promise<CheckoutResponse> {
  return api.post<CheckoutResponse>('/billing/checkout', { plan, interval, successUrl, cancelUrl });
}

export function createPortalSession(returnUrl: string): Promise<PortalResponse> {
  return api.post<PortalResponse>('/billing/portal', { returnUrl });
}
