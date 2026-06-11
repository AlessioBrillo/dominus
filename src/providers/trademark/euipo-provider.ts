import { ProviderError } from '../../types/errors.js';
import type { TrademarkMatch, TrademarkProvider } from './trademark-provider.js';

/**
 * EUIPO trademark search provider using the Trademark Search 1.1.0
 * API (RSQL queries, `X-IBM-Client-Id` gateway header, OAuth2
 * client_credentials for token acquisition).
 *
 * The legacy COPLA endpoint was retired; queries against it return
 * zero hits silently. See ADR-0014 for the migration context.
 *
 * Free registration required at:
 *   https://euipo.europa.eu/ohimportal/en/open-data
 *
 * When credentials are absent the constructor does not throw; instead
 * `search()` raises a ProviderError so the gate treats this source as
 * unavailable and degrades gracefully.
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
  filingNumber?: string;
  registrationNumber?: string;
}

/**
 * EUIPO Trademark Search 1.1.0 returns a Spring-Data-style paged envelope.
 * The legacy COPLA endpoint returned `{ trademarks: [...] }`; both shapes
 * are accepted so the parser is robust to EUIPO API evolution and to
 * pre-production environments that still serve the old envelope.
 */
interface EuipoSearchResponse {
  content?: EuipoTrademark[];
  items?: EuipoTrademark[];
  trademarks?: EuipoTrademark[];
  totalElements?: number;
  total?: number;
  number?: number;
  size?: number;
}

const INACTIVE_STATUS_TOKENS = [
  'refused',
  'withdrawn',
  'expired',
  'cancelled',
  'canceled',
  'surrendered',
  'invalid',
  'lapsed',
  'revoked',
];

export interface EuipoProviderConfig {
  clientId: string | undefined;
  clientSecret: string | undefined;
  authUrl: string;
  apiUrl: string;
  /** Page size requested from EUIPO (default: 50, EUIPO max is 100). */
  pageSize?: number;
}

export class EuipoProvider implements TrademarkProvider {
  readonly #clientId: string | undefined;
  readonly #clientSecret: string | undefined;
  readonly #authUrl: string;
  readonly #apiUrl: string;
  readonly #pageSize: number;

  #token: string | null = null;
  #tokenExpiresAt: number = 0;
  #tokenPromise: Promise<string> | null = null;

  constructor(config: EuipoProviderConfig) {
    this.#clientId = config.clientId;
    this.#clientSecret = config.clientSecret;
    this.#authUrl = config.authUrl;
    this.#apiUrl = config.apiUrl;
    this.#pageSize = config.pageSize ?? 50;
  }

  async search(term: string): Promise<TrademarkMatch[]> {
    const token = await this.#getToken();
    const url = this.#buildSearchUrl(term);

    let response: Response;
    try {
      response = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'X-IBM-Client-Id': this.#clientId ?? '',
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
      this.#token = null;
      this.#tokenExpiresAt = 0;
      throw new ProviderError(
        `EUIPO search unauthorised (HTTP ${response.status}) for term "${term}". ` +
          'Verify EUIPO_CLIENT_ID (OAuth2 client_id is reused as X-IBM-Client-Id) ' +
          'and that the subscription to Trademark Search 1.1.0 is active.',
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

  #buildSearchUrl(term: string): URL {
    const url = new URL(this.#apiUrl);
    // RSQL: `trademarkName==*<term>*` performs a case-insensitive substring
    // match against the verbal element (mark name). Wildcards are quoted
    // implicitly by `*`; the term itself is sanitised to prevent RSQL
    // injection (asterisks, spaces, and quotes inside the term would
    // otherwise break the query grammar).
    const sanitised = term.replace(/[\\*'"\s]/g, '').toLowerCase();
    url.searchParams.set('query', `trademarkName==*${sanitised}*`);
    url.searchParams.set('page', '0');
    url.searchParams.set('size', String(this.#pageSize));
    return url;
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
    if (this.#token !== null && now < this.#tokenExpiresAt - 60_000) {
      return this.#token;
    }

    if (this.#tokenPromise !== null) {
      return this.#tokenPromise;
    }

    this.#tokenPromise = this.#acquireToken();
    try {
      return await this.#tokenPromise;
    } finally {
      this.#tokenPromise = null;
    }
  }

  async #acquireToken(): Promise<string> {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.#clientId!,
      client_secret: this.#clientSecret!,
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
    this.#tokenExpiresAt = Date.now() + tokenData.expires_in * 1_000;
    return this.#token;
  }

  #parseResponse(raw: unknown): TrademarkMatch[] {
    if (!isEuipoSearchResponse(raw)) return [];

    const list = raw.content ?? raw.items ?? raw.trademarks ?? [];
    return list
      .filter((tm): tm is EuipoTrademark => tm !== null && tm !== undefined)
      .filter((tm) => isActiveEuipoStatus(tm.status))
      .map((tm) => ({
        markName: tm.trademarkName ?? '',
        owner: tm.applicantName ?? '',
        status: tm.status ?? '',
        source: 'EUIPO',
        registrationNumber: tm.applicationNumber ?? tm.registrationNumber ?? tm.filingNumber,
      }))
      .filter((m) => m.markName.length > 0);
  }
}

function isActiveEuipoStatus(status: string | undefined): boolean {
  if (!status) return false;
  const lower = status.toLowerCase();
  return !INACTIVE_STATUS_TOKENS.some((token) => lower.includes(token));
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
  if (typeof v !== 'object' || v === null) return false;
  return (
    'content' in v || 'items' in v || 'trademarks' in v || 'totalElements' in v || 'total' in v
  );
}
