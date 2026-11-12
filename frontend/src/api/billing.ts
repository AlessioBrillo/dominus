// SPDX-License-Identifier: AGPL-3.0-only
import { api } from './client.js';

export interface SubscriptionData {
  id: number;
  tenantId: string;
  plan: 'free' | 'pro' | 'team' | 'enterprise';
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

export type BillingPlan = 'pro' | 'team' | 'enterprise';
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

/**
 * Change the plan or cancel the subscription.
 *
 * The plan change mutates the EXISTING subscription (ADR-0103): opening a
 * second Checkout for a customer who already subscribes leaves them with
 * two subscriptions and two invoices.
 */
export function changeSubscription(
  plan: BillingPlan,
  interval: BillingInterval,
): Promise<SubscriptionChangeResponse> {
  return api.post<SubscriptionChangeResponse>('/billing/subscription', {
    action: 'change',
    plan,
    interval,
  });
}

export function cancelSubscription(mode: 'immediate' | 'period_end'): Promise<CancelResponse> {
  return api.post<CancelResponse>('/billing/subscription', { action: 'cancel', mode });
}

export interface SubscriptionChangeResponse {
  subscriptionId: string;
  priceId: string;
  plan: BillingPlan;
}

export interface CancelResponse {
  subscriptionId: string;
  cancelAtPeriodEnd: boolean;
}
