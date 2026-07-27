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
  isStripeConfigured: boolean;
  publishableKey: string | null;
}

export interface PortalResponse {
  url: string;
}

export interface CheckoutResponse {
  url: string;
}

export function fetchSubscription(): Promise<BillingResponse> {
  return api.get<BillingResponse>('/billing');
}

export function createCheckoutSession(
  priceId: string,
  successUrl: string,
  cancelUrl: string,
): Promise<CheckoutResponse> {
  return api.post<CheckoutResponse>('/billing/checkout', { priceId, successUrl, cancelUrl });
}

export function createPortalSession(returnUrl: string): Promise<PortalResponse> {
  return api.post<PortalResponse>('/billing/portal', { returnUrl });
}
