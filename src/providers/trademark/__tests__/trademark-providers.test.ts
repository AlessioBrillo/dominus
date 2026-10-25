// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UsptoCasesProvider } from '../uspto-provider.js';
import { EuipoProvider } from '../euipo-provider.js';
import { ProviderError } from '../../../types/errors.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function mockOkResponse(body: unknown): {
  ok: boolean;
  status: number;
  headers: { get: () => string };
  json: () => Promise<unknown>;
  text: () => Promise<string>;
} {
  return {
    ok: true,
    status: 200,
    headers: { get: (): string => 'application/json' },
    json: (): Promise<unknown> => Promise.resolve(body),
    text: (): Promise<string> => Promise.resolve(''),
  };
}

function mockHtmlResponse(
  status: number,
  body?: string,
): {
  ok: boolean;
  status: number;
  headers: { get: () => string };
  json: () => Promise<unknown>;
  text: () => Promise<string>;
} {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (): string => 'text/html' },
    json: () => Promise.reject(new SyntaxError('not JSON')),
    text: () => Promise.resolve(body ?? '<html><body>WAF Blocked</body></html>'),
  };
}

function mockTextResponse(body: string): {
  ok: boolean;
  status: number;
  headers: { get: () => string };
  json: () => Promise<unknown>;
  text: () => Promise<string>;
} {
  return {
    ok: true,
    status: 200,
    headers: { get: (): string => 'text/plain' },
    json: () => Promise.reject(new SyntaxError('not JSON')),
    text: () => Promise.resolve(body),
  };
}

// ---------------------------------------------------------------------------
// UsptoCasesProvider
// ---------------------------------------------------------------------------

const INSTANT_SLEEP = (): Promise<void> => Promise.resolve();

describe('UsptoCasesProvider', () => {
  const config = { searchUrl: 'https://tmsearch.uspto.gov/tmsearch', sleepFn: INSTANT_SLEEP };
  let provider: UsptoCasesProvider;

  beforeEach(() => {
    provider = new UsptoCasesProvider(config);
    vi.clearAllMocks();
  });

  it('returns an empty array when no hits match', async () => {
    mockFetch.mockResolvedValue(mockOkResponse({ hits: { total: { value: 0 }, hits: [] } }));
    const results = await provider.search('xqzbrk');
    expect(results).toEqual([]);
  });

  it('parses active trademark matches from Elasticsearch response', async () => {
    mockFetch.mockResolvedValue(
      mockOkResponse({
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
    );

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
    mockFetch.mockResolvedValue(
      mockOkResponse({
        hits: {
          hits: [
            { _source: { WM: 'OLDMARK', ST: '7-ABANDONED', ON: 'Acme', SN: '12345' } },
            { _source: { WM: 'EXPMARK', ST: '8-CANCELLED', ON: 'Acme', SN: '12346' } },
            { _source: { WM: 'LIVEMARK', ST: '4-PUBLISHED', ON: 'Acme', SN: '12347' } },
          ],
        },
      }),
    );

    const results = await provider.search('mark');
    expect(results).toHaveLength(1);
    expect(results[0]!.markName).toBe('LIVEMARK');
  });

  it('fails closed when the response shape is unexpected', async () => {
    // An unrecognised body is not an answer: reporting "no matches" for a
    // response the provider cannot read would clear a domain nobody
    // checked (ADR-0012, Principle 6).
    mockFetch.mockResolvedValue(mockOkResponse({ unexpected: 'shape' }));
    await expect(provider.search('test')).rejects.toBeInstanceOf(ProviderError);
  });

  it('throws ProviderError on network failure', async () => {
    mockFetch.mockRejectedValue(new Error('network error'));
    await expect(provider.search('nike')).rejects.toBeInstanceOf(ProviderError);
  });

  it('fails closed on a non-OK HTTP status (no empty result set)', async () => {
    // A non-OK answer is not an answer. The provider used to degrade to an
    // empty result set, which reported "this mark does not exist" for a
    // request that never happened - and the gate cleared the domain on it.
    // It throws now, so the failover tries the next source and the gate
    // reports Unverified when every source is down (ADR-0012).
    mockFetch.mockResolvedValue({ ok: false, status: 500, text: () => Promise.resolve('') });
    await expect(provider.search('nike')).rejects.toBeInstanceOf(ProviderError);
    // The error names the status: an operator has to be able to tell a
    // 405 (the endpoint moved) from a 500 (the service is down).
    const error = await provider.search('nike').catch((e: unknown) => e);
    expect((error as ProviderError).message).toMatch(/500/);
  });

  it('fails closed on a malformed JSON response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: () => Promise.reject(new SyntaxError('Unexpected token')),
      text: () => Promise.resolve(''),
    });
    await expect(provider.search('test')).rejects.toBeInstanceOf(ProviderError);
  });

  // ── WAF resilience ───────────────────────────────────────────────

  it('retries on WAF HTML response (403) and succeeds on second attempt', async () => {
    const nikeResponse = mockOkResponse({
      hits: {
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
        ],
      },
    });
    mockFetch.mockResolvedValueOnce(mockHtmlResponse(403)).mockResolvedValueOnce(nikeResponse);

    const results = await provider.search('nike');
    expect(results).toHaveLength(1);
    expect(results[0]!.markName).toBe('NIKE');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('increments wafBlockCount on WAF block', async () => {
    const nikeResponse = mockOkResponse({
      hits: { hits: [{ _source: { WM: 'NIKE', ST: '6-REGISTERED', ON: 'Nike', SN: '1' } }] },
    });
    mockFetch.mockResolvedValueOnce(mockHtmlResponse(403)).mockResolvedValueOnce(nikeResponse);

    await provider.search('nike');

    expect(provider.wafBlockCount).toBe(1);
    expect(provider.requestCount).toBe(2);
    expect(provider.wafBlockRate).toBe(0.5);
  });

  it('wafBlockCount is 0 after clean responses only', async () => {
    mockFetch.mockResolvedValue(mockOkResponse({ hits: { hits: [] } }));
    await provider.search('clean1');
    await provider.search('clean2');

    expect(provider.wafBlockCount).toBe(0);
    expect(provider.requestCount).toBe(2);
    expect(provider.wafBlockRate).toBe(0);
  });

  it('retries on 200 HTML WAF response and succeeds', async () => {
    const nikeResponse = mockOkResponse({
      hits: { hits: [{ _source: { WM: 'NIKE', ST: '6-REGISTERED', ON: 'Nike', SN: '1' } }] },
    });
    mockFetch
      .mockResolvedValueOnce(mockTextResponse('<html>WAF Challenge</html>'))
      .mockResolvedValueOnce(nikeResponse);

    const results = await provider.search('nike');
    expect(results).toHaveLength(1);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('throws ProviderError after exhausting WAF retries', async () => {
    // All 4 attempts (1 initial + 3 retries) return HTML WAF responses
    mockFetch
      .mockResolvedValueOnce(mockHtmlResponse(403))
      .mockResolvedValueOnce(mockHtmlResponse(403))
      .mockResolvedValueOnce(mockHtmlResponse(503))
      .mockResolvedValueOnce(mockTextResponse('<html>Blocked</html>'));

    await expect(provider.search('nike')).rejects.toBeInstanceOf(ProviderError);
    expect(mockFetch).toHaveBeenCalledTimes(4);
    expect(provider.wafBlockCount).toBe(4);
  });

  it('recovers after WAF retries and later requests work', async () => {
    const nikeResponse = mockOkResponse({
      hits: { hits: [{ _source: { WM: 'NIKE', ST: '6-REGISTERED', ON: 'Nike', SN: '1' } }] },
    });
    mockFetch
      .mockResolvedValueOnce(mockHtmlResponse(403))
      .mockResolvedValueOnce(nikeResponse)
      .mockResolvedValue(nikeResponse);

    const first = await provider.search('nike');
    expect(first).toHaveLength(1);

    // Second search: no WAF
    const second = await provider.search('nike');
    expect(second).toHaveLength(1);
    expect(provider.wafBlockCount).toBe(1);
    expect(provider.requestCount).toBe(3);
  });

  it('does NOT retry on a standard 403 that is not a WAF block', async () => {
    const json403 = {
      ok: false,
      status: 403,
      headers: { get: (): string => 'application/json' },
      json: (): Promise<{ error: string }> => Promise.resolve({ error: 'forbidden' }),
      text: (): Promise<string> => Promise.resolve('{"error":"forbidden"}'),
    };
    mockFetch.mockResolvedValue(json403);

    // The status is a definitive answer ("forbidden"), not a WAF challenge:
    // no retry, and no empty result set either - the error is thrown so the
    // failover can try the next source.
    await expect(provider.search('test')).rejects.toBeInstanceOf(ProviderError);
    // No retry for a JSON 403 (not a WAF block)
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('sends an honest, versioned User-Agent on every attempt', async () => {
    const nikeResponse = mockOkResponse({
      hits: { hits: [{ _source: { WM: 'NIKE', ST: '6-REGISTERED', ON: 'Nike', SN: '1' } }] },
    });
    mockFetch.mockResolvedValueOnce(mockHtmlResponse(403)).mockResolvedValueOnce(nikeResponse);

    await provider.search('nike');

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const agents = mockFetch.mock.calls.map(
      (call: unknown[]) => (call[1] as { headers: Record<string, string> }).headers['User-Agent'],
    );
    // One honest UA identifies the tool; no browser fingerprinting rotation.
    expect(new Set(agents).size).toBe(1);
    expect(agents[0]).toContain('dominus-oss');
    expect(agents[0]).toContain('github.com/AlessioBrillo/dominus');
  });

  // ── Current backend shape: `source` envelope with current field names ──
  it('parses active trademark matches from the current `source` response shape', async () => {
    mockFetch.mockResolvedValue(
      mockOkResponse({
        hits: {
          totalValue: 2,
          hits: [
            {
              source: {
                wordmark: 'NIKE',
                statusCode: 800,
                statusDescription: 'REGISTERED AND RENEWED',
                alive: true,
                ownerName: ['NIKE, INC.'],
                registrationId: '0978952',
                id: '75187260',
              },
            },
            {
              source: {
                wordmark: 'NIKE AIR',
                statusCode: 800,
                statusDescription: 'REGISTERED AND RENEWED',
                alive: true,
                ownerName: ['NIKE, INC.'],
                registrationId: '2000001',
                id: '75187261',
              },
            },
          ],
        },
      }),
    );

    const results = await provider.search('nike');
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      markName: 'NIKE',
      owner: 'NIKE, INC.',
      status: 'REGISTERED AND RENEWED',
      source: 'USPTO',
      registrationNumber: '0978952',
    });
    expect(results[1]).toMatchObject({
      markName: 'NIKE AIR',
      owner: 'NIKE, INC.',
      registrationNumber: '2000001',
    });
  });

  it('filters out inactive marks using the `alive` flag in the current shape', async () => {
    mockFetch.mockResolvedValue(
      mockOkResponse({
        hits: {
          totalValue: 3,
          hits: [
            {
              source: {
                wordmark: 'DEADMARK',
                statusCode: 700,
                statusDescription: 'ABANDONED',
                alive: false,
                ownerName: ['Acme'],
                registrationId: '12345',
                id: '1',
              },
            },
            {
              source: {
                wordmark: 'LIVE',
                statusCode: 800,
                statusDescription: 'REGISTERED AND RENEWED',
                alive: true,
                ownerName: ['Acme'],
                registrationId: '12346',
                id: '2',
              },
            },
          ],
        },
      }),
    );

    const results = await provider.search('mark');
    expect(results).toHaveLength(1);
    expect(results[0]!.markName).toBe('LIVE');
  });

  it('returns an empty array (clear) when the register has no matching records', async () => {
    mockFetch.mockResolvedValue(mockOkResponse({ hits: { totalValue: 0, hits: [] } }));
    const results = await provider.search('xqzbrk12345');
    expect(results).toEqual([]);
  });

  it('fails closed when hits carry no readable field (schema drift, not an empty set)', async () => {
    // Simulates the observed failure: the new backend returns `source`
    // envelopes, but with the old field names all null. Returning an empty
    // list here would falsely clear the domain - the provider must throw
    // instead so the gate reports Unverified.
    mockFetch.mockResolvedValue(
      mockOkResponse({
        hits: {
          totalValue: 170,
          hits: [
            {
              source: {
                WM: null,
                PM: null,
                ST: null,
                ON: null,
                SN: null,
                RN: null,
              },
            },
          ],
        },
      }),
    );
    await expect(provider.search('nike')).rejects.toBeInstanceOf(ProviderError);
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
    const tokenCalls = mockFetch.mock.calls.filter((call: unknown[]) => call[0] === config.authUrl);
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
      // Second retry search also fails with 401 — ultimate rejection
      .mockResolvedValueOnce({ ok: false, status: 401 })
      // Second search uses the still-cached token (not cleared after ultimate 401)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve(
            pagedResponse([{ trademarkName: 'SAMPLE', status: 'REGISTERED', applicantName: 'X' }]),
          ),
      });

    const provider = new EuipoProvider(config);
    await expect(provider.search('test')).rejects.toBeInstanceOf(ProviderError);

    // Token was cleared on the first 401 but re-fetched during the retry;
    // the ultimate 401 does not re-clear it, so the second search reuses it
    // and does not hit the auth token endpoint again.
    await provider.search('test2');
    const tokenCalls = mockFetch.mock.calls.filter((call: unknown[]) => call[0] === config.authUrl);
    expect(tokenCalls).toHaveLength(2);
  });

  it('mentions X-IBM-Client-Id and Trademark Search 1.1.0 in the 401 error message', async () => {
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
      // Second retry search also fails with 401
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

  // ── Pagination and fail-closed truncation (ADR-0014 follow-up) ────

  /** Builds one page of `count` registered marks, with the register's own total. */
  function pageOf(count: number, total: number, page: number): Record<string, unknown> {
    return {
      content: Array.from({ length: count }, (_, i) => ({
        trademarkName: `MARK${page}-${i}`,
        applicantName: 'Owner',
        status: 'REGISTERED',
        applicationNumber: `0${page}${i}`,
      })),
      totalElements: total,
      number: page,
      size: 2,
    };
  }

  it('walks every page until a short page ends the result set', async () => {
    // 5 matching records, page size 2 → pages of 2, 2, 1.
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: () => tokenResponse });
    mockFetch
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => pageOf(2, 5, 0) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => pageOf(2, 5, 1) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => pageOf(1, 5, 2) });

    const provider = new EuipoProvider({ ...config, pageSize: 2 });
    const results = await provider.search('mark');

    expect(results).toHaveLength(5);
    // 1 token request + 3 search pages; the loop stopped on the short page
    // rather than issuing a fourth request to confirm it.
    expect(mockFetch).toHaveBeenCalledTimes(4);
    const requestedPages = mockFetch.mock.calls
      .slice(1)
      .map((call: unknown[]) => new URL(call[0] as string).searchParams.get('page'));
    expect(requestedPages).toEqual(['0', '1', '2']);
  });

  it('throws EUIPO_RESULT_TRUNCATED when the register has records it cannot fetch', async () => {
    // 10 matching records, page size 2, at most 3 pages → only 6 are fetched.
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: () => tokenResponse });
    mockFetch
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => pageOf(2, 10, 0) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => pageOf(2, 10, 1) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => pageOf(2, 10, 2) });

    const provider = new EuipoProvider({ ...config, pageSize: 2, maxPages: 3 });
    const error = await provider.search('mark').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).code).toBe('EUIPO_RESULT_TRUNCATED');
    // The error must carry the numbers an operator needs to act on it.
    expect((error as ProviderError).message).toMatch(/fetched 6 of 10/);
    expect((error as ProviderError).context).toMatchObject({
      recordsFetched: 6,
      declaredTotal: 10,
      pageSize: 2,
      maxPages: 3,
    });
  });

  it('does not truncate when the register omits its total (legacy envelope)', async () => {
    // The legacy shape reports no totalElements/total, so there is no
    // evidence that unfetched pages remain and no error is warranted.
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: () => tokenResponse });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => ({ trademarks: [{ trademarkName: 'LEGACY', status: 'REGISTERED' }] }),
    });

    const provider = new EuipoProvider({ ...config, pageSize: 2 });
    const results = await provider.search('legacy');
    expect(results).toHaveLength(1);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('stops after one page when the first page is already short', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: () => tokenResponse });
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: () => pageOf(1, 1, 0) });

    const provider = new EuipoProvider({ ...config, pageSize: 50 });
    const results = await provider.search('unique');

    expect(results).toHaveLength(1);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
