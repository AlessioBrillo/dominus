// SPDX-License-Identifier: AGPL-3.0-only
export type SubscriptionPlan = 'free' | 'pro' | 'team' | 'enterprise';
export type SubscriptionStatus = 'active' | 'past_due' | 'canceled' | 'incomplete' | 'trialing';

export interface TenantCustomPrice {
  tenantId: string;
  priceId: string;
  plan: SubscriptionPlan;
  expectedAmountEur: number;
  seats: number;
  createdAt: string;
}

export interface TenantCustomPriceRow {
  tenant_id: string;
  price_id: string;
  plan: string;
  expected_amount_eur: number;
  seats: number;
  created_at: string;
}

export function customPriceFromRow(row: TenantCustomPriceRow): TenantCustomPrice {
  return {
    tenantId: row.tenant_id,
    priceId: row.price_id,
    plan: row.plan as SubscriptionPlan,
    expectedAmountEur: row.expected_amount_eur,
    seats: row.seats,
    createdAt: row.created_at,
  };
}

export interface Subscription {
  id: number;
  tenantId: string;
  plan: SubscriptionPlan;
  status: SubscriptionStatus;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  trialEnd: string | null;
  canceledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SubscriptionRow {
  id: number;
  tenant_id: string;
  plan: string;
  status: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  trial_end: string | null;
  canceled_at: string | null;
  created_at: string;
  updated_at: string;
}

export function subscriptionFromRow(row: SubscriptionRow): Subscription {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    plan: row.plan as SubscriptionPlan,
    status: row.status as SubscriptionStatus,
    stripeCustomerId: row.stripe_customer_id,
    stripeSubscriptionId: row.stripe_subscription_id,
    currentPeriodStart: row.current_period_start,
    currentPeriodEnd: row.current_period_end,
    trialEnd: row.trial_end,
    canceledAt: row.canceled_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface BillingPortalResponse {
  url: string;
}

export interface SubscriptionResponse {
  subscription: Subscription;
  isStripeConfigured: boolean;
}
