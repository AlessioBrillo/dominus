import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GoogleAdsProvider } from '../google-ads-provider.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('GoogleAdsProvider', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  const fullConfig = {
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    refreshToken: 'test-refresh-token',
    developerToken: 'test-dev-token',
    customerId: '1234567890',
  };

  function mockTokenResponse(): void {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: 'test-access-token', expires_in: 3600 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }

  it('returns zero metrics when config is missing', async () => {
    const provider = new GoogleAdsProvider({
      clientId: undefined,
      clientSecret: undefined,
      refreshToken: undefined,
      developerToken: undefined,
      customerId: undefined,
    });
    const result = await provider.getMetrics('example');
    expect(result.monthlySearchVolume).toBe(0);
    expect(result.cpc).toBe(0);
  });

  it('returns zero metrics when only partial config is provided', async () => {
    const provider = new GoogleAdsProvider({
      clientId: 'partial',
      clientSecret: undefined,
      refreshToken: undefined,
      developerToken: undefined,
      customerId: undefined,
    });
    const result = await provider.getMetrics('example');
    expect(result.monthlySearchVolume).toBe(0);
  });

  it('fetches OAuth2 token and queries the API', async () => {
    mockTokenResponse();
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          {
            results: [
              {
                metrics: {
                  impressions: '12000',
                  averageCpc: '500000',
                },
              },
            ],
          },
        ]),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const provider = new GoogleAdsProvider(fullConfig);
    const result = await provider.getMetrics('cloud');

    expect(mockFetch).toHaveBeenCalledTimes(2);
    // First call: OAuth2 token
    const tokenUrl = mockFetch.mock.calls[0]![0]! as string;
    expect(tokenUrl).toContain('oauth2.googleapis.com');
    // Second call: Google Ads API
    const apiUrl = mockFetch.mock.calls[1]![0]! as string;
    expect(apiUrl).toContain('googleads.googleapis.com');
    expect(apiUrl).toContain('1234567890');
    expect(result).toEqual({
      term: 'cloud',
      monthlySearchVolume: 12000,
      cpc: 0.5,
      competition: 0,
    });
  });

  it('caches OAuth2 token between requests', async () => {
    mockTokenResponse();
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify([{ results: [{ metrics: { impressions: '500', averageCpc: '100000' } }] }]),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify([{ results: [{ metrics: { impressions: '300', averageCpc: '200000' } }] }]),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const provider = new GoogleAdsProvider(fullConfig);
    await provider.getMetrics('term1');
    await provider.getMetrics('term2');

    // Token fetched only once (2 API calls, but only 1 token fetch)
    const tokenCalls = mockFetch.mock.calls.filter((call) =>
      (call[0] as string).includes('oauth2'),
    );
    expect(tokenCalls).toHaveLength(1);
  });

  it('returns zero metrics on API error', async () => {
    mockTokenResponse();
    mockFetch.mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));

    const provider = new GoogleAdsProvider(fullConfig);
    const result = await provider.getMetrics('example');

    expect(result.monthlySearchVolume).toBe(0);
  });

  it('returns zero metrics on network failure', async () => {
    mockTokenResponse();
    mockFetch.mockRejectedValueOnce(new Error('Network failure'));

    const provider = new GoogleAdsProvider(fullConfig);
    const result = await provider.getMetrics('example');

    expect(result.monthlySearchVolume).toBe(0);
  });

  it('returns zero metrics when API response has no results', async () => {
    mockTokenResponse();
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify([{ results: [] }]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const provider = new GoogleAdsProvider(fullConfig);
    const result = await provider.getMetrics('example');

    expect(result.monthlySearchVolume).toBe(0);
    expect(result.cpc).toBe(0);
  });

  it('respects daily quota and stops after limit', async () => {
    mockTokenResponse();
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify([{ results: [{ metrics: { impressions: '100', averageCpc: '50000' } }] }]),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const provider = new GoogleAdsProvider({ ...fullConfig, dailyQuota: 1 });
    await provider.getMetrics('term1');
    // After quota exhausted, second call returns zero without API call
    const result = await provider.getMetrics('term2');
    expect(result.monthlySearchVolume).toBe(0);
  });

  it('sanitises GAQL single quotes to prevent injection', async () => {
    mockTokenResponse();
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify([{ results: [{ metrics: { impressions: '0', averageCpc: '0' } }] }]),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const provider = new GoogleAdsProvider(fullConfig);
    await provider.getMetrics("it's");

    const apiCall = mockFetch.mock.calls[1]!;
    const body = JSON.parse(apiCall[1]!.body as string) as { query: string };
    expect(body.query).not.toContain("it's");
    expect(body.query).toContain("it\\'s");
  });
});
