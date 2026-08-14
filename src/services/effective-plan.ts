// SPDX-License-Identifier: AGPL-3.0-only
import type { Subscription, SubscriptionStatus, SubscriptionPlan } from '../types/subscription.js';

/**
 * Subscription statuses that still grant the paid plan's limits. Anything
 * else (past_due, canceled, incomplete, ...) fails closed to the free plan:
 * a tenant whose billing lapses must not keep paid capacity. The webhook
 * writes the Stripe status into tenant_subscriptions, so enforcement tracks
 * reality without waiting for subscription.deleted (ADR-0053).
 */
export const ACTIVE_PLAN_STATUSES: ReadonlySet<SubscriptionStatus> = new Set([
  'active',
  'trialing',
]);

/**
 * Effective plan for enforcement, derived from the subscription row.
 * Null or non-current statuses always resolve to 'free' — the fail-closed
 * choice: it is better to temporarily under-serve a paying tenant whose
 * card bounced than to hand paid capacity to one whose billing lapsed.
 *
 * An explicit operator plan override (ADR-0057) wins over the
 * subscription-derived plan: it is a deliberate manual grant (enterprise
 * trials, SLA compensation) and must not be silently undone by an
 * auto-downgrade. Passing null/undefined keeps subscription-driven
 * enforcement.
 *
 * Shared by every plan-dependent consumer (usage metering, team seats) so
 * enforcement cannot diverge between features (ADR-0053).
 */
export function effectivePlanFor(
  sub: Subscription | null | undefined,
  planOverride?: SubscriptionPlan | null,
): SubscriptionPlan {
  if (planOverride) {
    return planOverride;
  }
  if (sub !== null && sub !== undefined && ACTIVE_PLAN_STATUSES.has(sub.status)) {
    return sub.plan;
  }
  return 'free';
}
