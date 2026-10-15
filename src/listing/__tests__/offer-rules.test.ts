// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from 'vitest';
import { evaluateOfferRules } from '../offer-rules.js';
import {
  DEFAULT_TENANT_LISTING_SETTINGS,
  type TenantListingSettings,
} from '../../types/listing-settings.js';

function settings(overrides: Partial<TenantListingSettings> = {}): TenantListingSettings {
  return { ...DEFAULT_TENANT_LISTING_SETTINGS, ...overrides };
}

describe('evaluateOfferRules', () => {
  it('keeps every offer pending when no rule is configured', () => {
    expect(evaluateOfferRules(settings(), 5)).toEqual({ action: 'keep_pending' });
    expect(evaluateOfferRules(settings(), 100_000)).toEqual({ action: 'keep_pending' });
  });

  it('declines offers below the floor', () => {
    const outcome = evaluateOfferRules(settings({ offerAutoDeclineBelowEur: 100 }), 50);
    expect(outcome.action).toBe('declined');
    expect(outcome.action === 'declined' && outcome.reason).toContain('100');
  });

  it('keeps offers at exactly the floor pending', () => {
    expect(evaluateOfferRules(settings({ offerAutoDeclineBelowEur: 100 }), 100)).toEqual({
      action: 'keep_pending',
    });
  });

  it('counters offers below the counter price', () => {
    const outcome = evaluateOfferRules(settings({ offerCounterEur: 800 }), 500);
    expect(outcome).toEqual({
      action: 'countered',
      counterEur: 800,
      reason: expect.stringContaining('800'),
    });
  });

  it('the decline floor wins when both rules are set below the floor', () => {
    const outcome = evaluateOfferRules(
      settings({ offerAutoDeclineBelowEur: 500, offerCounterEur: 300 }),
      100,
    );
    expect(outcome.action).toBe('declined');
  });

  it('the counter rule applies above the floor', () => {
    const outcome = evaluateOfferRules(
      settings({ offerAutoDeclineBelowEur: 100, offerCounterEur: 800 }),
      500,
    );
    expect(outcome.action).toBe('countered');
  });

  it('keeps offers at the counter price pending', () => {
    expect(evaluateOfferRules(settings({ offerCounterEur: 800 }), 800)).toEqual({
      action: 'keep_pending',
    });
  });
});
