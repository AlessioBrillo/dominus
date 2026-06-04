import { describe, it, expect } from 'vitest';
import { computeIntrinsicScore } from '../intrinsic-signal.js';
import type { ScoringInput } from '../../../types/score.js';

function makeInput(domain: string, tld: string, isCloseout = false): ScoringInput {
  return { domain, tld, isCloseout };
}

describe('IntrinsicSignal', () => {
  it('short .com pronounceable domain scores high (≥ 0.5)', () => {
    const result = computeIntrinsicScore(makeInput('nova.com', '.com'), 1);
    expect(result.score).toBeGreaterThanOrEqual(0.5);
  });

  it('long hyphen-heavy domain scores low (< 0.3)', () => {
    const result = computeIntrinsicScore(
      makeInput('buy-cheap-domains-online-now.com', '.com'),
      1,
    );
    expect(result.score).toBeLessThan(0.3);
  });

  it('domain with 3+ hyphens never reaches 0.4', () => {
    const result = computeIntrinsicScore(
      makeInput('top-ten-best-deals.com', '.com'),
      1,
    );
    expect(result.score).toBeLessThan(0.4);
  });

  it('short digit-heavy domain is penalised', () => {
    const result = computeIntrinsicScore(makeInput('a1b2c3.com', '.com'), 1);
    const clean = computeIntrinsicScore(makeInput('abcdef.com', '.com'), 1);
    expect(result.score).toBeLessThan(clean.score);
  });

  it('.io TLD scores lower than .com for same SLD', () => {
    const com = computeIntrinsicScore(makeInput('nova.com', '.com'), 1);
    const io = computeIntrinsicScore(makeInput('nova.io', '.io'), 1);
    expect(com.score).toBeGreaterThan(io.score);
  });

  it('score is always between 0 and 1', () => {
    const inputs: ScoringInput[] = [
      makeInput('a.com', '.com'),
      makeInput('thisisaveryverylongdomainname.com', '.com'),
      makeInput('x-y-z-1-2-3.net', '.net'),
    ];
    for (const input of inputs) {
      const result = computeIntrinsicScore(input, 1);
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(1);
    }
  });

  it('weight is passed through to the output', () => {
    const result = computeIntrinsicScore(makeInput('nova.com', '.com'), 0.42);
    expect(result.weight).toBe(0.42);
  });
});
