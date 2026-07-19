import { describe, it, expect } from 'vitest';
import { computeNpv } from '../npv-calculator.js';
import type { NpvInput } from '../npv-calculator.js';

function makeInput(overrides: Partial<NpvInput> = {}): NpvInput {
  return {
    expectedValue: 1000,
    confidence: 0.5,
    acquisitionCost: 12,
    renewalCost: 10,
    ...overrides,
  };
}

describe('NpvCalculator', () => {
  it('returns positive NPV when expected return exceeds holding costs', () => {
    const result = computeNpv(makeInput({ expectedValue: 2000, confidence: 0.8 }), 0.05, 5);
    expect(result.npv).toBeGreaterThan(0);
    expect(result.annualRenewalCost).toBe(10);
  });

  it('returns negative NPV when holding costs exceed expected return', () => {
    const result = computeNpv(makeInput({ expectedValue: 20, confidence: 0.1 }), 0.05, 5);
    expect(result.npv).toBeLessThan(0);
  });

  it('returns purely negative NPV when confidence is zero (no expected return)', () => {
    const result = computeNpv(makeInput({ confidence: 0 }), 0.05, 5);
    expect(result.npv).toBeLessThan(0);
    // NPV = -acquisitionCost - sum_{t=1}^{5} renewalCost / 1.05^t
    // = -12 - 10 * (1/1.05 + 1/1.05^2 + ... + 1/1.05^5)
    // = -12 - 10 * 4.3295 = -55.29
    expect(result.npv).toBeLessThan(-50);
    expect(result.npv).toBeGreaterThan(-60);
  });

  it('returns negative acquisition cost as NPV when both confidence and renewal are zero', () => {
    const result = computeNpv(
      makeInput({ expectedValue: 0, confidence: 0, renewalCost: 0 }),
      0.05,
      5,
    );
    expect(result.npv).toBe(-12);
  });

  it('zero acquisition cost allows NPV to be purely based on renewal vs return', () => {
    const result = computeNpv(
      makeInput({ acquisitionCost: 0, expectedValue: 500, confidence: 0.5 }),
      0.05,
      5,
    );
    expect(result.npv).toBeGreaterThan(0);
  });

  it('high renewal cost relative to expected value makes NPV negative', () => {
    const result = computeNpv(makeInput({ expectedValue: 100, renewalCost: 50 }), 0.05, 5);
    expect(result.npv).toBeLessThan(0);
  });

  it('projects annual return as average annual gain minus renewal cost', () => {
    const result = computeNpv(
      makeInput({ expectedValue: 1000, confidence: 0.8, renewalCost: 10 }),
      0.05,
      5,
    );
    expect(result.projectedAnnualReturn).toBeGreaterThan(0);
    expect(result.projectedAnnualReturn).toBeLessThan(800 - 10);
  });

  it('computes breakEvenYears when net annual return is positive', () => {
    const result = computeNpv(
      makeInput({ expectedValue: 1000, confidence: 0.8, acquisitionCost: 100 }),
      0.05,
      5,
    );
    expect(result.breakEvenYears).toBeGreaterThan(0);
    expect(result.breakEvenYears).toBeLessThan(5);
  });

  it('returns horizon+1 breakEvenYears when net annual return is zero or negative', () => {
    const result = computeNpv(makeInput({ expectedValue: 0, confidence: 0 }), 0.05, 5);
    expect(result.breakEvenYears).toBe(6);
  });

  it('applies discount rate reducing future cash flows', () => {
    const lowRate = computeNpv(makeInput({ expectedValue: 1000, confidence: 0.8 }), 0.01, 5);
    const highRate = computeNpv(makeInput({ expectedValue: 1000, confidence: 0.8 }), 0.2, 5);
    expect(lowRate.npv).toBeGreaterThan(highRate.npv);
  });

  it('shorter horizon means less total cost and less total expected return', () => {
    const short = computeNpv(makeInput(), 0.05, 1);
    const long = computeNpv(makeInput(), 0.05, 10);
    expect(short.npv).not.toBe(long.npv);
    expect(short.annualRenewalCost).toBe(long.annualRenewalCost);
  });

  it('returns correct projectedAnnualReturn for one-year horizon', () => {
    const result = computeNpv(
      makeInput({ expectedValue: 1000, confidence: 0.5, renewalCost: 10 }),
      0.05,
      1,
    );
    const expectedReturn = (1000 * 0.5) / 1.05;
    const avgAnnual = expectedReturn / 1 - 10;
    expect(result.projectedAnnualReturn).toBeCloseTo(avgAnnual, 0);
  });

  it('rounds npv to two decimal places', () => {
    const result = computeNpv(
      makeInput({ acquisitionCost: 10, expectedValue: 33, confidence: 0.33, renewalCost: 7 }),
      0.05,
      3,
    );
    const decimalPart = result.npv * 100 - Math.floor(result.npv * 100);
    expect(Math.abs(decimalPart)).toBeLessThan(0.01);
  });
});
