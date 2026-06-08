import { describe, it, expect } from 'vitest';
import { computeExpiryScore } from '../expiry-signal.js';

describe('ExpirySignal', () => {
  it('returns 0 for non-closeout domains', () => {
    const result = computeExpiryScore(
      { domain: 'nova.com', tld: '.com', sld: 'nova', isCloseout: false },
      1,
    );
    expect(result.score).toBe(0);
  });

  it('closeout with age + backlinks scores > 0', () => {
    const result = computeExpiryScore(
      {
        domain: 'old.com',
        tld: '.com',
        sld: 'old',
        isCloseout: true,
        domainAge: 10,
        backlinks: 200,
      },
      1,
    );
    expect(result.score).toBeGreaterThan(0);
  });

  it('closeout without data scores 0', () => {
    const result = computeExpiryScore(
      { domain: 'old.com', tld: '.com', sld: 'old', isCloseout: true },
      1,
    );
    expect(result.score).toBe(0);
  });

  it('score with only domainAge', () => {
    const result = computeExpiryScore(
      { domain: 'aged.com', tld: '.com', sld: 'aged', isCloseout: true, domainAge: 10 },
      1,
    );
    expect(result.score).toBeGreaterThan(0);
    expect(result.score).toBeLessThanOrEqual(1);
  });

  it('score with only backlinks (no age)', () => {
    const result = computeExpiryScore(
      { domain: 'linked.com', tld: '.com', sld: 'linked', isCloseout: true, backlinks: 500 },
      1,
    );
    expect(result.score).toBeGreaterThan(0);
    expect(result.score).toBeLessThanOrEqual(1);
  });

  it('waybackSnapshots contributes to score', () => {
    const result = computeExpiryScore(
      {
        domain: 'archived.com',
        tld: '.com',
        sld: 'archived',
        isCloseout: true,
        waybackSnapshots: 100,
      },
      1,
    );
    expect(result.score).toBeGreaterThan(0);
  });

  it('score is clamped between 0 and 1', () => {
    const result = computeExpiryScore(
      {
        domain: 'old.com',
        tld: '.com',
        sld: 'old',
        isCloseout: true,
        domainAge: 100,
        backlinks: 100000,
      },
      1,
    );
    expect(result.score).toBeLessThanOrEqual(1);
    expect(result.score).toBeGreaterThanOrEqual(0);
  });

  it('extreme values cap at 1.0', () => {
    const result = computeExpiryScore(
      {
        domain: 'extreme.com',
        tld: '.com',
        sld: 'extreme',
        isCloseout: true,
        domainAge: 50,
        backlinks: 5000,
        waybackSnapshots: 2000,
      },
      1,
    );
    expect(result.score).toBe(1);
  });
});
