// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi } from 'vitest';
import { CompositeKeywordProvider } from '../composite-keyword-provider.js';
import type { KeywordMetrics, KeywordProvider } from '../keyword-provider.js';

function provider(metrics: KeywordMetrics): KeywordProvider {
  return { getMetrics: vi.fn().mockResolvedValue(metrics) };
}

describe('CompositeKeywordProvider', () => {
  it('uses the curated metrics when the term is covered', async () => {
    const curated = provider({
      term: 'saas',
      monthlySearchVolume: 10000,
      cpc: 5.5,
      competition: 0.3,
      covered: true,
      source: 'manual',
    });
    const fallback = provider({
      term: 'saas',
      monthlySearchVolume: 10,
      cpc: 0.1,
      competition: 0,
    });
    const composite = new CompositeKeywordProvider(curated, fallback);

    const result = await composite.getMetrics('saas');

    expect(result.monthlySearchVolume).toBe(10000);
    expect(result.source).toBe('manual');
    expect(fallback.getMetrics).not.toHaveBeenCalled();
  });

  it('falls back only when the curated provider declares a miss', async () => {
    const curated = provider({
      term: 'unknown',
      monthlySearchVolume: 0,
      cpc: 0,
      competition: 0,
      covered: false,
      source: 'manual',
    });
    const fallback = provider({
      term: 'unknown',
      monthlySearchVolume: 120,
      cpc: 1.2,
      competition: 0.4,
    });
    const composite = new CompositeKeywordProvider(curated, fallback);

    const result = await composite.getMetrics('unknown');

    expect(result.monthlySearchVolume).toBe(120);
    expect(result.source).toBe('fallback');
  });

  it('falls back when the curated provider throws', async () => {
    const curated: KeywordProvider = {
      getMetrics: vi.fn().mockRejectedValue(new Error('file missing')),
    };
    const fallback = provider({
      term: 'term',
      monthlySearchVolume: 50,
      cpc: 0.5,
      competition: 0.2,
      source: 'google-suggest',
    });
    const composite = new CompositeKeywordProvider(curated, fallback);

    const result = await composite.getMetrics('term');

    expect(result.monthlySearchVolume).toBe(50);
    expect(result.source).toBe('google-suggest');
  });

  it('does not turn an explicit zero-demand term into a fallback', async () => {
    const curated = provider({
      term: 'obscure',
      monthlySearchVolume: 0,
      cpc: 0,
      competition: 0,
      covered: true,
      source: 'manual',
    });
    const fallback = provider({
      term: 'obscure',
      monthlySearchVolume: 90,
      cpc: 1,
      competition: 0.1,
    });
    const composite = new CompositeKeywordProvider(curated, fallback);

    const result = await composite.getMetrics('obscure');

    expect(result.monthlySearchVolume).toBe(0);
    expect(result.covered).toBe(true);
  });
});
