// SPDX-License-Identifier: AGPL-3.0-only
import type { Subscription, SubscriptionStatus, SubscriptionPlan } from '../types/subscription.js';

/**
 * Subscription statuses that still grant the paid plan's limits. Anything
 * else fails closed to the free plan: a tenant whose billing lapses must
 * not keep paid capacity. The webhook writes the Stripe status into
 * tenant_subscriptions, so enforcement tracks reality without waiting for
 * subscription.deleted (ADR-0053).
 */
export const ACTIVE_PLAN_STATUSES: ReadonlySet<SubscriptionStatus> = new Set([
  'active',
  'trialing',
]);

/**
 * A failed card must not turn a 500-domain workspace into a 5-domain
 * workspace the same day. Stripe usually retries successfully within days,
 * so `past_due` keeps the paid limits for a short, explicit grace window
 * counted from the webhook's last status update. After the window the
 * fail-closed path applies.
 */
export const PAST_DUE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/** True while a `past_due` subscription is inside its dunning grace window. */
export function isWithinDunningGrace(sub: Subscription, now = Date.now()): boolean {
  if (sub.status !== 'past_due') return false;
  const updated = Date.parse(sub.updatedAt);
  if (!Number.isFinite(updated)) return false;
  return now - updated >= 0 && now - updated < PAST_DUE_GRACE_MS;
}

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
  now = Date.now(),
): SubscriptionPlan {
  if (planOverride) {
    return planOverride;
  }
  if (sub !== null && sub !== undefined) {
    if (ACTIVE_PLAN_STATUSES.has(sub.status) || isWithinDunningGrace(sub, now)) {
      return sub.plan;
    }
  }
  return 'free';
}
