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
    'fails closed to free for an old status %s',
    (status) => {
      expect(effectivePlanFor(sub(status))).toBe('free');
    },
  );

  describe('dunning grace (v1.8.0)', () => {
    const now = Date.parse('2026-11-25T12:00:00.000Z');

    it('keeps the paid plan for a recent past_due subscription', () => {
      const failed = { ...sub('past_due'), updatedAt: '2026-11-25T10:00:00.000Z' };
      expect(effectivePlanFor(failed, null, now)).toBe('pro');
    });

    it('drops to free once the seven-day grace has elapsed', () => {
      const failed = { ...sub('past_due'), updatedAt: '2026-11-17T10:00:00.000Z' };
      expect(effectivePlanFor(failed, null, now)).toBe('free');
    });

    it('does not extend grace to canceled or incomplete subscriptions', () => {
      for (const status of ['canceled', 'incomplete'] as const) {
        const recent = { ...sub(status), updatedAt: '2026-11-25T10:00:00.000Z' };
        expect(effectivePlanFor(recent, null, now)).toBe('free');
      }
    });
  });

  it('fails closed to free for a missing subscription', () => {
    expect(effectivePlanFor(null)).toBe('free');
  });

  describe('plan override (ADR-0057)', () => {
    it('an override wins over an active subscription', () => {
      expect(effectivePlanFor(sub('active'), 'enterprise')).toBe('enterprise');
    });

    it('an override wins even when the subscription lapsed', () => {
      expect(effectivePlanFor(sub('past_due'), 'pro')).toBe('pro');
    });

    it('an override wins when there is no subscription at all', () => {
      expect(effectivePlanFor(null, 'team')).toBe('team');
    });

    it('a null override leaves the subscription-derived plan untouched', () => {
      expect(effectivePlanFor(sub('active'), null)).toBe('pro');
      expect(effectivePlanFor(sub('canceled'), null)).toBe('free');
    });

    it('no override argument leaves the subscription-derived plan untouched', () => {
      expect(effectivePlanFor(sub('active'))).toBe('pro');
      expect(effectivePlanFor(null)).toBe('free');
    });
  });
});
