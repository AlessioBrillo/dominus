// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from 'vitest';
import { effectivePlanFor } from '../effective-plan.js';
import type { Subscription } from '../../types/subscription.js';

function sub(status: Subscription['status']): Subscription {
  return {
    id: 1,
    tenantId: 'tenant-1',
    plan: 'pro',
    status,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    currentPeriodStart: null,
    currentPeriodEnd: null,
    trialEnd: null,
    canceledAt: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
  };
}

describe('effectivePlanFor', () => {
  it('returns the plan for active subscriptions', () => {
    expect(effectivePlanFor(sub('active'))).toBe('pro');
  });

  it('returns the plan for trialing subscriptions', () => {
    expect(effectivePlanFor(sub('trialing'))).toBe('pro');
  });

  it.each(['past_due', 'canceled', 'incomplete'] as const)(
    'fails closed to free for status %s',
    (status) => {
      expect(effectivePlanFor(sub(status))).toBe('free');
    },
  );

  it('fails closed to free for a missing subscription', () => {
    expect(effectivePlanFor(null)).toBe('free');
  });
});
