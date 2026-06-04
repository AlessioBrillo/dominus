import { describe, it, expect } from 'vitest';
import { ManualKeywordProvider } from '../manual-keyword-provider.js';

describe('ManualKeywordProvider', () => {
  it('returns zero metrics for unknown term when no data file', async () => {
    const provider = new ManualKeywordProvider();
    const metrics = await provider.getMetrics('unknownterm');
    expect(metrics.monthlySearchVolume).toBe(0);
    expect(metrics.cpc).toBe(0);
    expect(metrics.term).toBe('unknownterm');
  });

  it('is case-insensitive for lookups', async () => {
    const provider = new ManualKeywordProvider();
    const a = await provider.getMetrics('SaaS');
    const b = await provider.getMetrics('saas');
    expect(a.monthlySearchVolume).toBe(b.monthlySearchVolume);
  });
});
