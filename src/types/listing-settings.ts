// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Per-tenant listing policy (ADR-0083, M4).
 *
 * Two knobs the tenant controls directly, both usable today without any
 * vendor API access — the marketplace adapters themselves stay out until
 * their APIs are verified (ADR-0082):
 *
 *  1. The listing price: 'scoring' keeps the conservative price the
 *     scoring engine computes (Principle 5); 'fixed' uses the tenant's
 *     own base price for every new automatic listing.
 *  2. Offer handling: auto-decline below a floor and counter below a
 *     counter price. Both default to off — an offer is never answered
 *     automatically unless the tenant configured the rule.
 */
export type ListingPricePolicy = 'scoring' | 'fixed';

export interface TenantListingSettings {
  pricePolicy: ListingPricePolicy;
  /** Base price used by new automatic listings when policy is 'fixed'. */
  basePriceEur: number | null;
  /** Offers below this amount are declined automatically. Null = off. */
  offerAutoDeclineBelowEur: number | null;
  /** Offers below this amount (and above the floor) are countered. Null = off. */
  offerCounterEur: number | null;
}

/** Defaults: keep the scoring price and never answer offers automatically. */
export const DEFAULT_TENANT_LISTING_SETTINGS: TenantListingSettings = {
  pricePolicy: 'scoring',
  basePriceEur: null,
  offerAutoDeclineBelowEur: null,
  offerCounterEur: null,
};

/** Partial update: only the provided fields change. */
export interface TenantListingSettingsUpdate {
  pricePolicy?: ListingPricePolicy;
  basePriceEur?: number | null;
  offerAutoDeclineBelowEur?: number | null;
  offerCounterEur?: number | null;
}

export interface TenantListingSettingsRow {
  tenant_id: string;
  price_policy: string;
  base_price_eur: number | null;
  offer_auto_decline_below_eur: number | null;
  offer_counter_eur: number | null;
  updated_at: string;
}

export function tenantListingSettingsFromRow(row: TenantListingSettingsRow): TenantListingSettings {
  return {
    pricePolicy: row.price_policy === 'fixed' ? 'fixed' : 'scoring',
    basePriceEur: row.base_price_eur,
    offerAutoDeclineBelowEur: row.offer_auto_decline_below_eur,
    offerCounterEur: row.offer_counter_eur,
  };
}

/** How an incoming offer was answered by the tenant's rules. */
export type OfferRuleOutcome =
  | { action: 'keep_pending' }
  | { action: 'declined'; reason: string }
  | { action: 'countered'; counterEur: number; reason: string };
