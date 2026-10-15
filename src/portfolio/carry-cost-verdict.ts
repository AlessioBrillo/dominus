// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Carry-cost verdict (ADR-0083, M5).
 *
 * The sustainability question every held domain must answer: does the ad
 * revenue of the domain cover its carry cost (the renewal it needs to
 * stay online)? The verdict is deliberately conservative — it never
 * judges on less than a month of data, and it annualises from the
 * observed window instead of extrapolating from a good week.
 */

export type CarryCostVerdict = 'sustainable' | 'marginal' | 'loss' | 'insufficient_data';

export interface CarryCostInput {
  domain: string;
  /** Revenue recorded since the domain started monetizing, EUR. */
  revenueEur: number;
  /** Days between the first revenue record and now. 0 = not monetizing. */
  daysMonetized: number;
  /** Renewal cost per year, EUR. */
  renewalCostEur: number;
}

export interface CarryCostResult {
  domain: string;
  verdict: CarryCostVerdict;
  /** Annualised revenue, EUR/year. */
  annualRevenueEur: number;
  /** Annual carry cost (renewal), EUR/year. */
  annualCarryCostEur: number;
  /** annualRevenue − annualCarryCost, EUR/year. */
  netAnnualEur: number;
  reason: string;
}

/** Below this many days of revenue data the verdict refuses to judge. */
export const MIN_MONETIZED_DAYS = 30;

export function computeCarryCostVerdict(input: CarryCostInput): CarryCostResult {
  const { domain, revenueEur, daysMonetized, renewalCostEur } = input;

  const annualise = (amount: number): number => (amount * 365) / Math.max(1, daysMonetized);
  const annualRevenueEur = daysMonetized > 0 ? annualise(revenueEur) : 0;
  const netAnnualEur = annualRevenueEur - renewalCostEur;

  if (daysMonetized < MIN_MONETIZED_DAYS) {
    return {
      domain,
      verdict: 'insufficient_data',
      annualRevenueEur,
      annualCarryCostEur: renewalCostEur,
      netAnnualEur,
      reason:
        daysMonetized > 0
          ? `Only ${String(Math.round(daysMonetized))} day(s) of revenue data — at least ${String(MIN_MONETIZED_DAYS)} are required before judging`
          : 'No revenue recorded yet — the domain is not monetizing',
    };
  }

  if (netAnnualEur >= 0) {
    return {
      domain,
      verdict: 'sustainable',
      annualRevenueEur,
      annualCarryCostEur: renewalCostEur,
      netAnnualEur,
      reason: `Annualised revenue €${annualRevenueEur.toFixed(2)} covers the €${renewalCostEur.toFixed(2)}/yr renewal (net €${netAnnualEur.toFixed(2)}/yr)`,
    };
  }

  if (netAnnualEur >= -renewalCostEur * 0.5) {
    return {
      domain,
      verdict: 'marginal',
      annualRevenueEur,
      annualCarryCostEur: renewalCostEur,
      netAnnualEur,
      reason: `Annualised revenue €${annualRevenueEur.toFixed(2)} covers part of the €${renewalCostEur.toFixed(2)}/yr renewal (net €${netAnnualEur.toFixed(2)}/yr) — consider repricing or parking better`,
    };
  }

  return {
    domain,
    verdict: 'loss',
    annualRevenueEur,
    annualCarryCostEur: renewalCostEur,
    netAnnualEur,
    reason: `Annualised revenue €${annualRevenueEur.toFixed(2)} does not cover the €${renewalCostEur.toFixed(2)}/yr renewal (net €${netAnnualEur.toFixed(2)}/yr) — a drop candidate at the next renewal`,
  };
}
