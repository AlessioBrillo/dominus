import type { KeywordMetrics, KeywordProvider } from './keyword-provider.js';
import { getLogger } from '../../logger.js';

export interface GoogleAdsProviderConfig {
  clientId: string | undefined;
  clientSecret: string | undefined;
  refreshToken: string | undefined;
  developerToken: string | undefined;
  customerId: string | undefined;
  /** Max queries per day (free tier: 10,000). Default: 9,500 to stay under limit. */
  dailyQuota?: number;
}

interface GoogleAdsTokenResponse {
  access_token: string;
  expires_in: number;
}

interface GoogleAdsSearchResult {
  results?: Array<{
    keywordView?: {
      resourceName?: string;
    };
    metrics?: {
      impressions?: string;
      averageCpc?: string;
      biddableConversions?: string;
    };
    segments?: {
      date?: string;
    };
  }>;
  fieldMask?: string;
  nextPageToken?: string;
}

export class GoogleAdsProvider implements KeywordProvider {
  private readonly config: Required<GoogleAdsProviderConfig>;
  private warned: boolean = false;
  private queriesToday: number = 0;
  private quotaResetAt: number = Date.now() + 86_400_000;

  #token: string | null = null;
  #tokenExpiresAt: number = 0;

  constructor(config: GoogleAdsProviderConfig) {
    this.config = {
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      refreshToken: config.refreshToken,
      developerToken: config.developerToken,
      customerId: config.customerId,
      dailyQuota: config.dailyQuota ?? 9_500,
    };
  }

  async getMetrics(term: string): Promise<KeywordMetrics> {
    if (!this.isConfigured()) {
      this.warnOnce();
      return this.zeroMetrics(term);
    }

    if (this.isQuotaExhausted()) {
      getLogger().warn({ term }, 'Google Ads daily quota exhausted — returning zero volume');
      return this.zeroMetrics(term);
    }

    const token = await this.#getToken();
    const results = await this.#searchKeywordVolume(term, token);

    const metrics = this.#extractMetrics(results, term);
    this.queriesToday++;
    return metrics;
  }

  private isConfigured(): boolean {
    const c = this.config;
    return !!(c.clientId && c.clientSecret && c.refreshToken && c.developerToken && c.customerId);
  }

  private isQuotaExhausted(): boolean {
    const now = Date.now();
    if (now > this.quotaResetAt) {
      this.queriesToday = 0;
      this.quotaResetAt = now + 86_400_000;
      return false;
    }
    return this.queriesToday >= this.config.dailyQuota;
  }

  private warnOnce(): void {
    if (this.warned) return;
    getLogger().warn(
      'Google Ads credentials are incomplete (GOOGLE_ADS_CLIENT_ID / GOOGLE_ADS_CLIENT_SECRET / ' +
        'GOOGLE_ADS_REFRESH_TOKEN / GOOGLE_ADS_DEVELOPER_TOKEN / GOOGLE_ADS_CUSTOMER_ID). ' +
        'Set all five in .env to enable keyword volume lookups. Gracefully returning zero volume.',
    );
    this.warned = true;
  }

  private zeroMetrics(term: string): KeywordMetrics {
    return { term, monthlySearchVolume: 0, cpc: 0, competition: 0 };
  }

  async #getToken(): Promise<string> {
    if (!this.config.clientId || !this.config.clientSecret || !this.config.refreshToken) {
      throw new Error('Google Ads OAuth2 credentials not configured');
    }

    const now = Date.now();
    if (this.#token !== null && now < this.#tokenExpiresAt - 60_000) {
      return this.#token;
    }

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      refresh_token: this.config.refreshToken,
    });

    let response: Response;
    try {
      response = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err: unknown) {
      throw new Error(`Google Ads token request failed: ${String(err)}`, { cause: err });
    }

    if (!response.ok) {
      throw new Error(`Google Ads token endpoint returned HTTP ${response.status}`);
    }

    let tokenData: unknown;
    try {
      tokenData = await response.json();
    } catch (err: unknown) {
      throw new Error('Google Ads token response is not valid JSON', { cause: err });
    }

    if (!isTokenResponse(tokenData)) {
      throw new Error('Google Ads token response missing access_token');
    }

    this.#token = tokenData.access_token;
    this.#tokenExpiresAt = now + tokenData.expires_in * 1_000;
    return this.#token;
  }

  async #searchKeywordVolume(term: string, token: string): Promise<GoogleAdsSearchResult> {
    const url = `https://googleads.googleapis.com/v19/customers/${this.config.customerId}/googleAds:searchStream`;

    const gaql = `
      SELECT
        keyword_view.resource_name,
        metrics.impressions,
        metrics.average_cpc
      FROM keyword_view
      WHERE keyword_view.keyword.text = '${this.#sanitiseGaql(term)}'
        AND segments.date DURING LAST_30_DAYS
      LIMIT 1
    `.trim();

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'developer-token': this.config.developerToken ?? '',
          'Content-Type': 'application/json',
          'login-customer-id': this.config.customerId ?? '',
        },
        body: JSON.stringify({ query: gaql }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err: unknown) {
      getLogger().error({ err, term }, 'Google Ads API request failed');
      return { results: [] };
    }

    if (!response.ok) {
      getLogger().error(
        { status: response.status, statusText: response.statusText, term },
        'Google Ads API returned error',
      );
      return { results: [] };
    }

    try {
      const data = (await response.json()) as unknown;
      if (Array.isArray(data) && data.length > 0) {
        return data[0] as GoogleAdsSearchResult;
      }
      return data as GoogleAdsSearchResult;
    } catch {
      getLogger().error({ term }, 'Google Ads API returned invalid JSON');
      return { results: [] };
    }
  }

  #extractMetrics(result: GoogleAdsSearchResult, term: string): KeywordMetrics {
    const results = result.results;
    if (!results || results.length === 0) {
      return this.zeroMetrics(term);
    }

    const row = results[0];
    if (!row) return this.zeroMetrics(term);

    const metrics = row.metrics;
    if (!metrics) return this.zeroMetrics(term);

    const impressions = parseInt(metrics.impressions ?? '0', 10);
    const avgCpcMicros = parseInt(metrics.averageCpc ?? '0', 10);

    return {
      term,
      monthlySearchVolume: isNaN(impressions) ? 0 : impressions,
      cpc: isNaN(avgCpcMicros) ? 0 : Math.round((avgCpcMicros / 1_000_000) * 100) / 100,
      competition: 0,
    };
  }

  // Sanitise GAQL string literal to prevent injection (single quotes only)
  #sanitiseGaql(value: string): string {
    return value.replace(/'/g, "\\'");
  }
}

function isTokenResponse(v: unknown): v is GoogleAdsTokenResponse {
  return (
    typeof v === 'object' &&
    v !== null &&
    'access_token' in v &&
    typeof (v as Record<string, unknown>).access_token === 'string' &&
    'expires_in' in v &&
    typeof (v as Record<string, unknown>).expires_in === 'number'
  );
}
