// SPDX-License-Identifier: AGPL-3.0-only
import type { OfferRuleOutcome, TenantListingSettings } from '../types/listing-settings.js';

/**
 * Evaluate the tenant's offer rules against an incoming offer
 * (ADR-0083, M4). Pure function: the ListingManager applies the outcome.
 *
 * Order matters: the decline floor is checked first, so a counter rule
 * set below the floor can never resurrect an offer the tenant wants
 * rejected. Both rules are conservative by construction — with unset
 * (null) values every offer stays pending for a human.
 */
export function evaluateOfferRules(
  settings: TenantListingSettings,
  amountEur: number,
): OfferRuleOutcome {
  const { offerAutoDeclineBelowEur: floor, offerCounterEur: counter } = settings;

  if (floor !== null && amountEur < floor) {
    return {
      action: 'declined',
      reason: `below the auto-decline floor of €${floor.toFixed(0)}`,
    };
  }

  if (counter !== null && amountEur < counter) {
    return {
      action: 'countered',
      counterEur: counter,
      reason: `below the counter price of €${counter.toFixed(0)}`,
    };
  }

  return { action: 'keep_pending' };
}
