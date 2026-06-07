import { describe, it, expect } from 'vitest';
import { computeIntrinsicScore } from '../intrinsic-signal.js';
import type { ScoringInput } from '../../../types/score.js';

function makeInput(domain: string, tld: string, sld: string, isCloseout = false): ScoringInput {
  return { domain, tld, sld, isCloseout };
}

describe('IntrinsicSignal', () => {
  it('short .com pronounceable domain scores high (≥ 0.5)', () => {
    const result = computeIntrinsicScore(makeInput('nova.com', '.com', 'nova'), 1);
    expect(result.score).toBeGreaterThanOrEqual(0.5);
  });

  it('long hyphen-heavy domain scores low (< 0.3)', () => {
    const result = computeIntrinsicScore(
      makeInput('buy-cheap-domains-online-now.com', '.com', 'buy-cheap-domains-online-now'),
      1,
    );
    expect(result.score).toBeLessThan(0.3);
  });

  it('domain with 3+ hyphens never reaches 0.4', () => {
    const result = computeIntrinsicScore(
      makeInput('top-ten-best-deals.com', '.com', 'top-ten-best-deals'),
      1,
    );
    expect(result.score).toBeLessThan(0.4);
  });

  it('short digit-heavy domain is penalised', () => {
    const result = computeIntrinsicScore(makeInput('a1b2c3.com', '.com', 'a1b2c3'), 1);
    const clean = computeIntrinsicScore(makeInput('abcdef.com', '.com', 'abcdef'), 1);
    expect(result.score).toBeLessThan(clean.score);
  });

  it('.io TLD scores lower than .com for same SLD', () => {
    const com = computeIntrinsicScore(makeInput('nova.com', '.com', 'nova'), 1);
    const io = computeIntrinsicScore(makeInput('nova.io', '.io', 'nova'), 1);
    expect(com.score).toBeGreaterThan(io.score);
  });

  it('score is always between 0 and 1', () => {
    const inputs: ScoringInput[] = [
      makeInput('a.com', '.com', 'a'),
      makeInput('thisisaveryverylongdomainname.com', '.com', 'thisisaveryverylongdomainname'),
      makeInput('x-y-z-1-2-3.net', '.net', 'x-y-z-1-2-3'),
    ];
    for (const input of inputs) {
      const result = computeIntrinsicScore(input, 1);
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(1);
    }
  });

  it('weight is passed through to the output', () => {
    const result = computeIntrinsicScore(makeInput('nova.com', '.com', 'nova'), 0.42);
    expect(result.weight).toBe(0.42);
  });

  describe('multi-part ccTLD handling (ADR-0013)', () => {
    it('uses the canonical SLD, not the public-suffix-prefixed SLD', () => {
      // The engine must NOT see the SLD as "nike.co" — that was the latent
      // bug. With sld="nike" supplied, the length-based signal scores the
      // 4-letter SLD, not the 7-letter "nike.co".
      const result = computeIntrinsicScore(makeInput('nike.co.uk', '.co.uk', 'nike'), 1);
      expect(result.details['sld']).toBe('nike');
      expect(result.details['length']).toBe(4);
    });

    it('produces the same intrinsic score for nike.co.uk and nike.com (canonical SLD)', () => {
      // Once the SLD is canonical, the intrinsic signal depends only on
      // SLD + TLD multiplier. The TLD multiplier still differentiates
      // .com from .co.uk (the latter is not in PREMIUM_TLD_BONUS, so it
      // falls back to the 0.3 default).
      const coUk = computeIntrinsicScore(makeInput('nike.co.uk', '.co.uk', 'nike'), 1);
      const com = computeIntrinsicScore(makeInput('nike.com', '.com', 'nike'), 1);
      // .com must score strictly higher because the TLD multiplier is
      // higher. The intrinsic subscore formula is deterministic and
      // produces a stable difference, but we only assert the inequality.
      expect(com.score).toBeGreaterThan(coUk.score);
    });

    it('exposes the canonical sld in details for downstream inspection', () => {
      const result = computeIntrinsicScore(makeInput('foo.com.au', '.com.au', 'foo'), 1);
      expect(result.details['sld']).toBe('foo');
    });
  });
});
