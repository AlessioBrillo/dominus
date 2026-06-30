import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GoogleSuggestKeywordProvider } from '../google-suggest-keyword-provider.js';

function mockSuggestResponse(suggestions: string[]): Response {
  const body: [string, string[], string[], Record<string, unknown>] = [
    'test',
    suggestions,
    suggestions.map(() => ''),
    {},
  ];
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('GoogleSuggestKeywordProvider', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('returns high volume metrics for a term with many suggestions', async () => {
    fetchSpy.mockResolvedValue(
      mockSuggestResponse([
        'saas platform',
        'saas software',
        'saas meaning',
        'saas products',
        'saas vs paas',
        'saas companies',
        'saas startups',
        'saas examples',
        'saas definition',
        'saas security',
      ]),
    );

    const provider = new GoogleSuggestKeywordProvider(60_000);
    const metrics = await provider.getMetrics('saas');

    expect(metrics.term).toBe('saas');
    expect(metrics.monthlySearchVolume).toBeGreaterThanOrEqual(5000);
    expect(metrics.cpc).toBeGreaterThan(1);
    expect(metrics.competition).toBeGreaterThan(0.5);
  });

  it('returns low volume metrics for a term with few suggestions', async () => {
    fetchSpy.mockResolvedValue(mockSuggestResponse(['obscure-term-xzy']));

    const provider = new GoogleSuggestKeywordProvider(60_000);
    const metrics = await provider.getMetrics('obscure-term-xzy');

    expect(metrics.monthlySearchVolume).toBeLessThanOrEqual(300);
    expect(metrics.cpc).toBeLessThan(2);
    expect(metrics.competition).toBeLessThanOrEqual(0.5);
  });

  it('returns zero metrics when API returns no suggestions', async () => {
    fetchSpy.mockResolvedValue(mockSuggestResponse([]));

    const provider = new GoogleSuggestKeywordProvider(60_000);
    const metrics = await provider.getMetrics('xyznonexistent');

    expect(metrics.monthlySearchVolume).toBe(0);
    expect(metrics.cpc).toBe(0);
    expect(metrics.competition).toBe(0);
  });

  it('handles API HTTP errors gracefully', async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 503 }));

    const provider = new GoogleSuggestKeywordProvider(60_000);
    const metrics = await provider.getMetrics('saas');

    expect(metrics.monthlySearchVolume).toBe(0);
    expect(metrics.cpc).toBe(0);
  });

  it('handles network failures gracefully', async () => {
    fetchSpy.mockRejectedValue(new Error('ENOTFOUND'));

    const provider = new GoogleSuggestKeywordProvider(60_000);
    const metrics = await provider.getMetrics('saas');

    expect(metrics.monthlySearchVolume).toBe(0);
    expect(metrics.cpc).toBe(0);
  });

  it('handles malformed API response gracefully', async () => {
    fetchSpy.mockResolvedValue(new Response('not-json', { status: 200 }));

    const provider = new GoogleSuggestKeywordProvider(60_000);
    const metrics = await provider.getMetrics('saas');

    expect(metrics.monthlySearchVolume).toBe(0);
    expect(metrics.cpc).toBe(0);
  });

  it('handles non-array API response gracefully', async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ invalid: true }), { status: 200 }));

    const provider = new GoogleSuggestKeywordProvider(60_000);
    const metrics = await provider.getMetrics('saas');

    expect(metrics.monthlySearchVolume).toBe(0);
    expect(metrics.cpc).toBe(0);
  });

  it('applies hyphen penalty to CPC estimate', async () => {
    fetchSpy.mockResolvedValue(mockSuggestResponse(['my-term', 'my-term-2']));

    const provider = new GoogleSuggestKeywordProvider(60_000);
    const withHyphen = await provider.getMetrics('my-term');

    fetchSpy.mockResolvedValue(mockSuggestResponse(['myterm', 'myterm2']));
    const withoutHyphen = await provider.getMetrics('myterm');

    expect(withHyphen.cpc).toBeLessThan(withoutHyphen.cpc);
  });

  it('applies length bonus — shorter terms get higher CPC', async () => {
    fetchSpy.mockResolvedValue(
      mockSuggestResponse(['ai', 'ai tools', 'ai software', 'ai meaning', 'ai companies']),
    );

    const provider = new GoogleSuggestKeywordProvider(60_000);
    const shortTerm = await provider.getMetrics('ai');

    fetchSpy.mockResolvedValue(
      mockSuggestResponse(['artificial-intelligence-tools', 'artificial-intelligence-software']),
    );
    const longTerm = await provider.getMetrics('artificial-intelligence-tools');

    expect(shortTerm.cpc).toBeGreaterThan(longTerm.cpc);
  });

  it('returns cached results without making HTTP requests', async () => {
    fetchSpy.mockResolvedValue(
      mockSuggestResponse(['saas platform', 'saas software', 'saas meaning']),
    );

    const provider = new GoogleSuggestKeywordProvider(60_000);
    await provider.getMetrics('saas');

    expect(fetchSpy).toHaveBeenCalledTimes(1);

    await provider.getMetrics('saas');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('handles pre-aborted signal gracefully — returns zero metrics', async () => {
    const provider = new GoogleSuggestKeywordProvider(60_000);

    const controller = new AbortController();
    const signal = controller.signal;
    controller.abort();

    const metrics = await provider.getMetrics('saas', signal);
    expect(metrics.monthlySearchVolume).toBe(0);
  });

  it('uses correct Google Suggest URL format', async () => {
    fetchSpy.mockImplementation((url: string | URL) => {
      const urlStr = url.toString();
      expect(urlStr).toContain('suggestqueries.google.com/complete/search');
      expect(urlStr).toContain('client=firefox');
      expect(urlStr).toContain('q=testterm');
      return Promise.resolve(mockSuggestResponse([]));
    });

    const provider = new GoogleSuggestKeywordProvider(60_000);
    await provider.getMetrics('testterm');

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('clears cache on demand', async () => {
    const provider = new GoogleSuggestKeywordProvider(60_000);

    fetchSpy.mockResolvedValue(mockSuggestResponse(['term']));
    await provider.getMetrics('term');
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    fetchSpy.mockResolvedValue(mockSuggestResponse(['term']));
    provider.clearCache();
    await provider.getMetrics('term');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('returns competition between 0 and 1', async () => {
    fetchSpy.mockResolvedValue(mockSuggestResponse(['a', 'b', 'c', 'd', 'e', 'f', 'g']));

    const provider = new GoogleSuggestKeywordProvider(60_000);
    const metrics = await provider.getMetrics('test');

    expect(metrics.competition).toBeGreaterThanOrEqual(0);
    expect(metrics.competition).toBeLessThanOrEqual(1);
  });

  it('returns volume in known tier buckets', async () => {
    const testCases = [
      { suggestions: [], expected: 0 },
      { suggestions: ['a'], expected: 50 },
      { suggestions: ['a', 'b', 'c'], expected: 50 },
      { suggestions: ['a', 'b', 'c', 'd'], expected: 300 },
      { suggestions: ['a', 'b', 'c', 'd', 'e', 'f'], expected: 1500 },
      { suggestions: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], expected: 5000 },
      { suggestions: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'], expected: 10000 },
    ];

    for (const { suggestions, expected } of testCases) {
      fetchSpy.mockResolvedValue(mockSuggestResponse(suggestions));
      const provider = new GoogleSuggestKeywordProvider(60_000);
      const metrics = await provider.getMetrics('term');
      expect(metrics.monthlySearchVolume).toBe(expected);
    }
  });
});
