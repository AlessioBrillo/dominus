import { ProviderError } from '../../types/errors.js';
import type { TrademarkMatch, TrademarkProvider } from './trademark-provider.js';

/**
 * EUIPO trademark search provider using the COPLA REST API with OAuth2
 * client_credentials flow.
 *
 * Free registration required at:
 *   https://euipo.europa.eu/ohimportal/en/open-data
 *
 * When credentials are absent the constructor throws a ProviderError so the
 * gate treats this source as unavailable and degrades gracefully.
 */

interface EuipoTokenResponse {
  access_token: string;
  expires_in: number;
}

interface EuipoTrademark {
  trademarkName?: string;
  applicantName?: string;
  status?: string;
  applicationNumber?: string;
  kind?: string;
}

interface EuipoSearchResponse {
  trademarks?: EuipoTrademark[];
  total?: number;
}

export interface EuipoProviderConfig {
  clientId: string | undefined;
  clientSecret: string | undefined;
  authUrl: string;
  apiUrl: string;
}

export class EuipoProvider implements TrademarkProvider {
  readonly #clientId: string | undefined;
  readonly #clientSecret: string | undefined;
  readonly #authUrl: string;
  readonly #apiUrl: string;

  #token: string | null = null;
  #tokenExpiresAt: number = 0;

  constructor(config: EuipoProviderConfig) {
    this.#clientId = config.clientId;
    this.#clientSecret = config.clientSecret;
    this.#authUrl = config.authUrl;
    this.#apiUrl = config.apiUrl;
  }

  async search(term: string): Promise<TrademarkMatch[]> {
    const token = await this.#getToken();
    const url = new URL(this.#apiUrl);
    url.searchParams.set('trademarkName', term);
    url.searchParams.set('pageSize', '50');
    url.searchParams.set('pageNumber', '0');

    let response: Response;
    try {
      response = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err: unknown) {
      throw new ProviderError(
        `EUIPO request failed for term "${term}": ${String(err)}`,
        'EuipoProvider',
        'EUIPO_REQUEST_FAILED',
      );
    }

    if (response.status === 401 || response.status === 403) {
      // Token may have been invalidated; clear the cached token
      this.#token = null;
      this.#tokenExpiresAt = 0;
      throw new ProviderError(
        `EUIPO search unauthorised (HTTP ${response.status}) for term "${term}"`,
        'EuipoProvider',
        'EUIPO_UNAUTHORIZED',
      );
    }

    if (!response.ok) {
      throw new ProviderError(
        `EUIPO search returned HTTP ${response.status} for term "${term}"`,
        'EuipoProvider',
        'EUIPO_HTTP_ERROR',
      );
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch (err: unknown) {
      throw new ProviderError(
        `EUIPO response is not valid JSON for term "${term}": ${String(err)}`,
        'EuipoProvider',
        'EUIPO_PARSE_ERROR',
      );
    }

    return this.#parseResponse(data);
  }

  async #getToken(): Promise<string> {
    if (!this.#clientId || !this.#clientSecret) {
      throw new ProviderError(
        'EUIPO_CLIENT_ID and EUIPO_CLIENT_SECRET are not configured. ' +
          'Register for free at https://euipo.europa.eu/ohimportal/en/open-data',
        'EuipoProvider',
        'EUIPO_MISSING_CREDENTIALS',
      );
    }

    const now = Date.now();
    // Reuse token if it still has at least 60 seconds remaining
    if (this.#token !== null && now < this.#tokenExpiresAt - 60_000) {
      return this.#token;
    }

    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.#clientId,
      client_secret: this.#clientSecret,
    });

    let response: Response;
    try {
      response = await fetch(this.#authUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err: unknown) {
      throw new ProviderError(
        `EUIPO token request failed: ${String(err)}`,
        'EuipoProvider',
        'EUIPO_TOKEN_REQUEST_FAILED',
      );
    }

    if (!response.ok) {
      throw new ProviderError(
        `EUIPO token endpoint returned HTTP ${response.status}`,
        'EuipoProvider',
        'EUIPO_TOKEN_HTTP_ERROR',
      );
    }

    let tokenData: unknown;
    try {
      tokenData = await response.json();
    } catch (err: unknown) {
      throw new ProviderError(
        `EUIPO token response is not valid JSON: ${String(err)}`,
        'EuipoProvider',
        'EUIPO_TOKEN_PARSE_ERROR',
      );
    }

    if (!isTokenResponse(tokenData)) {
      throw new ProviderError(
        'EUIPO token response missing access_token field',
        'EuipoProvider',
        'EUIPO_TOKEN_INVALID',
      );
    }

    this.#token = tokenData.access_token;
    this.#tokenExpiresAt = now + tokenData.expires_in * 1_000;
    return this.#token;
  }

  #parseResponse(raw: unknown): TrademarkMatch[] {
    if (!isEuipoSearchResponse(raw)) return [];

    return (raw.trademarks ?? [])
      .filter((tm): tm is EuipoTrademark => tm !== null && tm !== undefined)
      .filter((tm) => isActiveEuipoStatus(tm.status))
      .map((tm) => ({
        markName: tm.trademarkName ?? '',
        owner: tm.applicantName ?? '',
        status: tm.status ?? '',
        source: 'EUIPO',
        registrationNumber: tm.applicationNumber,
      }))
      .filter((m) => m.markName.length > 0);
  }
}

function isActiveEuipoStatus(status: string | undefined): boolean {
  if (!status) return false;
  const lower = status.toLowerCase();
  // Exclude clearly inactive statuses
  return !lower.includes('refused') && !lower.includes('withdrawn') && !lower.includes('expired');
}

function isTokenResponse(v: unknown): v is EuipoTokenResponse {
  return (
    typeof v === 'object' &&
    v !== null &&
    'access_token' in v &&
    typeof (v as Record<string, unknown>).access_token === 'string' &&
    'expires_in' in v &&
    typeof (v as Record<string, unknown>).expires_in === 'number'
  );
}

function isEuipoSearchResponse(v: unknown): v is EuipoSearchResponse {
  return typeof v === 'object' && v !== null && 'trademarks' in v;
}
