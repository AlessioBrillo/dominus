import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CdxWaybackProvider } from '../cdx-provider.js';
import { ProviderError } from '../../../types/errors.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function makeCdxResponse(entries: Array<[string, string, string]>): string {
  const header = ['urlkey', 'timestamp', 'original', 'statuscode'];
  const rows = entries.map(([ts, url, code]) => [ts, url, code]);
  return JSON.stringify([header, ...rows]);
}

describe('CdxWaybackProvider', () => {
  let provider: CdxWaybackProvider;

  beforeEach(() => {
    provider = new CdxWaybackProvider('https://web.archive.org/cdx/search/cdx', undefined, 5000);
    vi.clearAllMocks();
  });

  it('returns domain age and snapshots from CDX response', async () => {
    const now = Date.now();
    const fifteenYearsAgo = new Date(now - 15 * 365.25 * 24 * 60 * 60 * 1000);
    const ts = fifteenYearsAgo.toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);

    mockFetch.mockResolvedValue({
      status: 200,
      ok: true,
      text: () =>
        Promise.resolve(
          makeCdxResponse([
            [ts, 'http://example.com/', '200'],
            ['20200101000000', 'http://example.com/page1', '200'],
            ['20220101000000', 'http://example.com/page2', '200'],
          ]),
        ),
    });

    const result = await provider.getExpiryData('example.com');
    expect(result.domain).toBe('example.com');
    expect(result.domainAge).toBeGreaterThan(10);
    expect(result.domainAge).toBeLessThan(20);
    expect(result.waybackSnapshots).toBe(3);
    expect(result.checkedAt).toBeDefined();
  });

  it('returns empty result on 404 (domain not in Wayback)', async () => {
    mockFetch.mockResolvedValue({ status: 404, ok: false, text: () => Promise.resolve('') });

    const result = await provider.getExpiryData('never-crawled.com');
    expect(result.domainAge).toBe(0);
    expect(result.waybackSnapshots).toBe(0);
  });

  it('returns empty result on empty CDX response', async () => {
    mockFetch.mockResolvedValue({
      status: 200,
      ok: true,
      text: () => Promise.resolve(makeCdxResponse([])),
    });

    const result = await provider.getExpiryData('empty.com');
    expect(result.domainAge).toBe(0);
    expect(result.waybackSnapshots).toBe(0);
  });

  it('returns empty result on non-OK non-404 status', async () => {
    mockFetch.mockResolvedValue({ status: 503, ok: false, text: () => Promise.resolve('') });

    const result = await provider.getExpiryData('unavailable.com');
    expect(result.domainAge).toBe(0);
    expect(result.waybackSnapshots).toBe(0);
  });

  it('throws ProviderError on network failure', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNRESET'));

    await expect(provider.getExpiryData('error.com')).rejects.toBeInstanceOf(ProviderError);
  });

  it('throws ProviderError with RATE_LIMITED code on 429', async () => {
    mockFetch.mockResolvedValue({ status: 429, ok: false, text: () => Promise.resolve('') });

    await expect(provider.getExpiryData('rate-limited.com')).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
  });

  it('handles malformed JSON response gracefully', async () => {
    mockFetch.mockResolvedValue({
      status: 200,
      ok: true,
      text: () => Promise.resolve('not json at all'),
    });

    const result = await provider.getExpiryData('malformed.com');
    expect(result.domainAge).toBe(0);
    expect(result.waybackSnapshots).toBe(0);
  });

  it('counts unique URLs as waybackSnapshots count', async () => {
    mockFetch.mockResolvedValue({
      status: 200,
      ok: true,
      text: () =>
        Promise.resolve(
          makeCdxResponse([
            ['20100101000000', 'http://example.com/', '200'],
            ['20150101000000', 'http://example.com/', '200'],
            ['20200101000000', 'http://example.com/', '200'],
            ['20210101000000', 'http://example.com/about', '200'],
            ['20220101000000', 'http://example.com/contact', '200'],
          ]),
        ),
    });

    const result = await provider.getExpiryData('example.com');
    expect(result.waybackSnapshots).toBe(5);
    expect(result.domainAge).toBeGreaterThan(10);
  });

  it('handles paginated CDX responses across multiple fetch calls', async () => {
    mockFetch
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        text: () =>
          Promise.resolve(
            makeCdxResponse(
              Array.from({ length: 5000 }, (_, i) => [
                String(20100000000000 + i),
                `http://example.com/page${i}`,
                '200',
              ]),
            ),
          ),
      })
      .mockResolvedValueOnce({
        status: 200,
        ok: true,
        text: () =>
          Promise.resolve(
            makeCdxResponse([
              ['20250101000000', 'http://example.com/extra', '200'],
            ]),
          ),
      });

    const result = await provider.getExpiryData('example.com');
    expect(result.waybackSnapshots).toBe(5001);
  });
});
