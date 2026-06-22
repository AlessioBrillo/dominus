export interface NpvInput {
  expectedValue: number;
  confidence: number;
  acquisitionCost: number;
  renewalCost: number;
}

export interface NpvResult {
  npv: number;
  projectedAnnualReturn: number;
  breakEvenYears: number;
  annualRenewalCost: number;
}

/**
 * Compute the Net Present Value of holding a domain for `horizonYears`
 * at a given `discountRate`.
 *
 * NPV = -acquisitionCost
 *       + sum_{t=1}^{horizon} (expectedValue * confidence) / (1 + r)^t
 *       - sum_{t=1}^{horizon} renewalCost / (1 + r)^t
 *
 * A positive NPV means the expected return exceeds the cost of holding,
 * accounting for the time value of money.
 *
 * When `expectedValue` or `confidence` is zero, NPV is purely negative
 * (cost of renewals) — a strong drop signal.
 */
export function computeNpv(
  input: NpvInput,
  discountRate: number = 0.05,
  horizonYears: number = 5,
): NpvResult {
  const { expectedValue, confidence, acquisitionCost, renewalCost } = input;

  const annualRenewalCost = renewalCost;
  let npv = -acquisitionCost;
  let projectedAnnualReturn = 0;

  for (let t = 1; t <= horizonYears; t++) {
    const discountFactor = 1 / Math.pow(1 + discountRate, t);
    const expectedGain = expectedValue * confidence * discountFactor;
    const renewalCostDiscounted = renewalCost * discountFactor;
    npv += expectedGain - renewalCostDiscounted;
    projectedAnnualReturn += expectedGain;
  }
  projectedAnnualReturn = projectedAnnualReturn / horizonYears - renewalCost;

  const netAnnualReturn = expectedValue * confidence - renewalCost;
  const breakEvenYears =
    expectedValue * confidence > 0 && renewalCost > 0 && netAnnualReturn > 0
      ? acquisitionCost / netAnnualReturn
      : horizonYears + 1;

  return {
    npv: Math.round(npv * 100) / 100,
    projectedAnnualReturn: Math.round(projectedAnnualReturn * 100) / 100,
    breakEvenYears: Math.round(breakEvenYears * 10) / 10,
    annualRenewalCost,
  };
}
