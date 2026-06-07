import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UsptoCasesProvider } from '../uspto-provider.js';
import { EuipoProvider } from '../euipo-provider.js';
import { ProviderError } from '../../../types/errors.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ---------------------------------------------------------------------------
// UsptoCasesProvider
// ---------------------------------------------------------------------------

describe('UsptoCasesProvider', () => {
  const config = { searchUrl: 'https://tmsearch.uspto.gov/tmsearch' };
  let provider: UsptoCasesProvider;

  beforeEach(() => {
    provider = new UsptoCasesProvider(config);
    vi.clearAllMocks();
  });

  it('returns an empty array when no hits match', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ hits: { total: { value: 0 }, hits: [] } }),
    });
    const results = await provider.search('xqzbrk');
    expect(results).toEqual([]);
  });

  it('parses active trademark matches from Elasticsearch response', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          hits: {
            total: { value: 2 },
            hits: [
              {
                _source: {
                  WM: 'NIKE',
                  ST: '6-REGISTERED',
                  ON: 'NIKE, INC.',
                  SN: '72072310',
                  RN: '0978952',
                },
              },
              {
                _source: {
                  WM: 'NIKE AIR',
                  ST: '6-REGISTERED',
                  ON: 'NIKE, INC.',
                  SN: '75000001',
                  RN: '2000001',
                },
              },
            ],
          },
        }),
    });

    const results = await provider.search('nike');
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      markName: 'NIKE',
      owner: 'NIKE, INC.',
      status: '6-REGISTERED',
      source: 'USPTO',
      registrationNumber: '0978952',
    });
  });

  it('filters out abandoned/cancelled trademarks (7- and 8- status codes)', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          hits: {
            hits: [
              { _source: { WM: 'OLDMARK', ST: '7-ABANDONED', ON: 'Acme', SN: '12345' } },
              { _source: { WM: 'EXPMARK', ST: '8-CANCELLED', ON: 'Acme', SN: '12346' } },
              { _source: { WM: 'LIVEMARK', ST: '4-PUBLISHED', ON: 'Acme', SN: '12347' } },
            ],
          },
        }),
    });

    const results = await provider.search('mark');
    expect(results).toHaveLength(1);
    expect(results[0]!.markName).toBe('LIVEMARK');
  });

  it('returns empty array when response is unexpected shape', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ unexpected: 'shape' }),
    });
    const results = await provider.search('test');
    expect(results).toEqual([]);
  });

  it('throws ProviderError on network failure', async () => {
    mockFetch.mockRejectedValue(new Error('network error'));
    await expect(provider.search('nike')).rejects.toBeInstanceOf(ProviderError);
  });

  it('throws ProviderError on non-OK HTTP status', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 403 });
    await expect(provider.search('nike')).rejects.toBeInstanceOf(ProviderError);
  });

  it('throws ProviderError on malformed JSON response', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.reject(new SyntaxError('Unexpected token')),
    });
    await expect(provider.search('test')).rejects.toBeInstanceOf(ProviderError);
  });
});

// ---------------------------------------------------------------------------
// EuipoProvider — Trademark Search 1.1.0 (RSQL + X-IBM-Client-Id)
// ---------------------------------------------------------------------------

describe('EuipoProvider', () => {
  const config = {
    clientId: 'test-id',
    clientSecret: 'test-secret',
    authUrl: 'https://euipo.europa.eu/oauth2/token',
    apiUrl: 'https://api.euipo.europa.eu/trademark-search/trademarks',
  };

  const tokenResponse = { access_token: 'mock-token', expires_in: 3600 };
  const pagedResponse = (items: unknown[]): Record<string, unknown> => ({
    content: items,
    totalElements: items.length,
    number: 0,
    size: 50,
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws ProviderError on search when credentials are absent', async () => {
    const noId = new EuipoProvider({ ...config, clientId: undefined });
    await expect(noId.search('test')).rejects.toBeInstanceOf(ProviderError);

    const noSecret = new EuipoProvider({ ...config, clientSecret: undefined });
    await expect(noSecret.search('test')).rejects.toBeInstanceOf(ProviderError);
  });

  it('fetches a token and returns trademark matches from paged response', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(tokenResponse),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve(
            pagedResponse([
              {
                trademarkName: 'APPLE',
                applicantName: 'Apple Inc.',
                status: 'REGISTERED',
                applicationNumber: '018123456',
              },
            ]),
          ),
      });

    const provider = new EuipoProvider(config);
    const results = await provider.search('apple');

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      markName: 'APPLE',
      owner: 'Apple Inc.',
      status: 'REGISTERED',
      source: 'EUIPO',
      registrationNumber: '018123456',
    });
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[0]![0]).toBe(config.authUrl);
  });

  it('builds an RSQL wildcard query and sends X-IBM-Client-Id on every search', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(tokenResponse),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(pagedResponse([])),
      });

    const provider = new EuipoProvider(config);
    await provider.search('Nike');

    const searchCall = mockFetch.mock.calls[1]!;
    const searchUrl = new URL(searchCall[0] as string);
    expect(searchUrl.searchParams.get('query')).toBe('trademarkName==*nike*');
    expect(searchUrl.searchParams.get('page')).toBe('0');
    expect(searchUrl.searchParams.get('size')).toBe('50');

    const init = searchCall[1] as { headers: Record<string, string> };
    expect(init.headers.Authorization).toBe('Bearer mock-token');
    expect(init.headers['X-IBM-Client-Id']).toBe('test-id');
  });

  it('sanitises RSQL metacharacters from the search term', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(tokenResponse),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(pagedResponse([])),
      });

    const provider = new EuipoProvider(config);
    await provider.search('  Ni*ke\'s "Best"  ');

    const searchCall = mockFetch.mock.calls[1]!;
    const searchUrl = new URL(searchCall[0] as string);
    // Whitespace, asterisk, single and double quotes are stripped; the
    // term becomes the bare lowercased alphanumeric core.
    expect(searchUrl.searchParams.get('query')).toBe('trademarkName==*nikesbest*');
  });

  it('accepts the legacy `trademarks` response shape (backward compat)', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(tokenResponse),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            trademarks: [
              {
                trademarkName: 'LEGACY',
                applicantName: 'Legacy Owner',
                status: 'REGISTERED',
                applicationNumber: '018999999',
              },
            ],
            total: 1,
          }),
      });

    const provider = new EuipoProvider(config);
    const results = await provider.search('legacy');
    expect(results).toHaveLength(1);
    expect(results[0]!.markName).toBe('LEGACY');
  });

  it('reuses cached token on second call within TTL', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(tokenResponse),
      })
      .mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(pagedResponse([])),
      });

    const provider = new EuipoProvider(config);
    await provider.search('test1');
    await provider.search('test2');

    expect(mockFetch).toHaveBeenCalledTimes(3);
    const tokenCalls = mockFetch.mock.calls.filter(
      (call: unknown[]) => call[0] === config.authUrl,
    );
    expect(tokenCalls).toHaveLength(1);
  });

  it('filters out refused/withdrawn/expired/cancelled/surrendered trademarks', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(tokenResponse),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve(
            pagedResponse([
              { trademarkName: 'REFUSED', status: 'REFUSED', applicantName: 'X' },
              { trademarkName: 'WITHDRAWN', status: 'WITHDRAWN', applicantName: 'X' },
              { trademarkName: 'EXPIRED', status: 'EXPIRED', applicantName: 'X' },
              { trademarkName: 'CANCELLED', status: 'CANCELLED', applicantName: 'X' },
              { trademarkName: 'SURRENDERED', status: 'SURRENDERED', applicantName: 'X' },
              { trademarkName: 'REGISTERED', status: 'REGISTERED', applicantName: 'Y' },
              { trademarkName: 'PUBLISHED', status: 'APPLICATION_PUBLISHED', applicantName: 'Z' },
            ]),
          ),
      });

    const provider = new EuipoProvider(config);
    const results = await provider.search('test');
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.markName)).toEqual(['REGISTERED', 'PUBLISHED']);
  });

  it('throws ProviderError on network failure during token fetch', async () => {
    mockFetch.mockRejectedValue(new Error('network error'));
    const provider = new EuipoProvider(config);
    await expect(provider.search('test')).rejects.toBeInstanceOf(ProviderError);
  });

  it('throws ProviderError on non-OK token response', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 401 });
    const provider = new EuipoProvider(config);
    await expect(provider.search('test')).rejects.toBeInstanceOf(ProviderError);
  });

  it('throws ProviderError on network failure during trademark search', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(tokenResponse),
      })
      .mockRejectedValueOnce(new Error('search network error'));

    const provider = new EuipoProvider(config);
    await expect(provider.search('test')).rejects.toBeInstanceOf(ProviderError);
  });

  it('throws ProviderError and clears token on 401 search response', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(tokenResponse),
      })
      .mockResolvedValueOnce({ ok: false, status: 401 })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(tokenResponse),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(pagedResponse([])),
      });

    const provider = new EuipoProvider(config);
    await expect(provider.search('test')).rejects.toBeInstanceOf(ProviderError);

    // Second search should re-fetch the token (cache was cleared)
    await provider.search('test2');
    const tokenCalls = mockFetch.mock.calls.filter(
      (call: unknown[]) => call[0] === config.authUrl,
    );
    expect(tokenCalls).toHaveLength(2);
  });

  it('mentions X-IBM-Client-Id and Trademark Search 1.1.0 in the 401 error message', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(tokenResponse),
      })
      .mockResolvedValueOnce({ ok: false, status: 401 });

    const provider = new EuipoProvider(config);
    const error = await provider.search('test').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).message).toMatch(/X-IBM-Client-Id/);
    expect((error as ProviderError).message).toMatch(/Trademark Search 1\.1\.0/);
  });

  it('returns empty array when trademark list is absent in response', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(tokenResponse),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ unexpected: 'shape' }),
      });

    const provider = new EuipoProvider(config);
    const results = await provider.search('test');
    expect(results).toEqual([]);
  });
});
