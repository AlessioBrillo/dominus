import { describe, it, expect, vi } from 'vitest';
import { computeCommercialScore } from '../commercial-signal.js';
import type { KeywordProvider } from '../../../providers/keyword/keyword-provider.js';

function mockProvider(volume: number, cpc: number): KeywordProvider {
  return { getMetrics: vi.fn().mockResolvedValue({ term: 'test', monthlySearchVolume: volume, cpc, competition: 0 }) };
}

describe('CommercialSignal', () => {
  it('returns 0 when no keyword data', async () => {
    const result = await computeCommercialScore(
      { domain: 'nova.com', tld: '.com', sld: 'nova', isCloseout: false },
      mockProvider(0, 0),
      1,
    );
    expect(result.score).toBe(0);
  });

  it('high volume + high CPC scores close to 1', async () => {
    const result = await computeCommercialScore(
      { domain: 'loans.com', tld: '.com', sld: 'loans', isCloseout: false },
      mockProvider(1_000_000, 50),
      1,
    );
    expect(result.score).toBeGreaterThan(0.9);
  });

  it('score is clamped between 0 and 1', async () => {
    const result = await computeCommercialScore(
      { domain: 'example.com', tld: '.com', sld: 'example', isCloseout: false },
      mockProvider(5_000_000, 200),
      1,
    );
    expect(result.score).toBeLessThanOrEqual(1);
    expect(result.score).toBeGreaterThanOrEqual(0);
  });
});
