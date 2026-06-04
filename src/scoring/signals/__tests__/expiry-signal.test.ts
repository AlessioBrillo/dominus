import { describe, it, expect } from 'vitest';
import { computeExpiryScore } from '../expiry-signal.js';

describe('ExpirySignal', () => {
  it('returns 0 for non-closeout domains', () => {
    const result = computeExpiryScore({ domain: 'nova.com', tld: '.com', isCloseout: false }, 1);
    expect(result.score).toBe(0);
  });

  it('closeout with age + backlinks scores > 0', () => {
    const result = computeExpiryScore(
      { domain: 'old.com', tld: '.com', isCloseout: true, domainAge: 10, backlinks: 200 },
      1,
    );
    expect(result.score).toBeGreaterThan(0);
  });

  it('closeout without data scores 0', () => {
    const result = computeExpiryScore({ domain: 'old.com', tld: '.com', isCloseout: true }, 1);
    expect(result.score).toBe(0);
  });

  it('score is clamped between 0 and 1', () => {
    const result = computeExpiryScore(
      { domain: 'old.com', tld: '.com', isCloseout: true, domainAge: 100, backlinks: 100000 },
      1,
    );
    expect(result.score).toBeLessThanOrEqual(1);
  });
});
