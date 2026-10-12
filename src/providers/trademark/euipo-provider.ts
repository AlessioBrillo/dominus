// SPDX-License-Identifier: AGPL-3.0-only
import { ProviderError } from '../../types/errors.js';
import type { TrademarkMatch, TrademarkProvider } from './trademark-provider.js';
import { type RateLimiterLike, RateLimiter } from '../rate-limiter.js';

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
 *
 * Pagination is complete and fail-closed (ADR-0014 follow-up). The API
 * returns at most `pageSize` records per call — historically 50 — which
 * meant a term with more matches than one page had its tail silently
 * dropped, and the gate then reported Clear for a term that does appear
 * in the register. `search()` now walks every page up to `maxPages` and,
 * when the register declares more records than it is allowed to fetch,
 * throws `EUIPO_RESULT_TRUNCATED`. The gate treats that as an unverified
 * source, so the verdict becomes Unverified rather than Clear (Principle
 * 6, Principle 5: when in doubt, do not clear).
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

/** One parsed page of search results. */
interface EuipoPage {
  /** Matches surviving the inactive-status filter. */
  matches: TrademarkMatch[];
  /** Records returned by this page BEFORE filtering — what the API sent. */
  recordsFetched: number;
  /** The register's own count of matching records, when it reports one. */
  total: number | null;
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
  /** Records per page requested from EUIPO (default: 50, EUIPO max is 100). */
  pageSize?: number;
  /**
   * Upper bound on how many result pages a single `search()` call fetches
   * (default: 10). A term matching more records than
   * `pageSize * maxPages` makes `search()` throw
   * `EUIPO_RESULT_TRUNCATED` instead of returning a partial list, so the
   * gate reports Unverified rather than Clear. Raise it when a legitimate
   * term is being reported as truncated; lower it to cut API calls on
   * very loose terms.
   */
  maxPages?: number;
  rateLimiter?: RateLimiterLike;
}

const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_MAX_PAGES = 10;

/** Per-request deadline, covering both the search and the retry path. */
const REQUEST_TIMEOUT_MS = 15_000;

export class EuipoProvider implements TrademarkProvider {
  readonly #clientId: string | undefined;
  readonly #clientSecret: string | undefined;
  readonly #authUrl: string;
  readonly #apiUrl: string;
  readonly #pageSize: number;
  readonly #maxPages: number;
  readonly #rateLimiter: RateLimiterLike;

  #token: string | null = null;
  #tokenExpiresAt: number = 0;
  #tokenPromise: Promise<string> | null = null;

  constructor(config: EuipoProviderConfig) {
    this.#clientId = config.clientId;
    this.#clientSecret = config.clientSecret;
    this.#authUrl = config.authUrl;
    this.#apiUrl = config.apiUrl;
    this.#pageSize = config.pageSize ?? DEFAULT_PAGE_SIZE;
    this.#maxPages = Math.max(1, config.maxPages ?? DEFAULT_MAX_PAGES);
    this.#rateLimiter = config.rateLimiter ?? RateLimiter.unlimited();
  }

  /**
   * Searches the EUIPO register for `term`, walking every result page
   * (up to `maxPages`).
   *
   * Truncation is fail-closed. When the register declares more matching
   * records than this provider is allowed to fetch, the method throws
   * `EUIPO_RESULT_TRUNCATED` rather than returning a partial list: a
   * partially enumerated register cannot support the conclusion "no match
   * found", and silently dropping the tail is precisely the failure the
   * trademark gate exists to prevent.
   */
  async search(term: string, signal?: AbortSignal): Promise<TrademarkMatch[]> {
    const token = await this.#getToken();

    const matches: TrademarkMatch[] = [];
    let recordsFetched = 0;
    // `totalElements` is the register's own count of matching records
    // (Spring-Data style). It is the only reliable signal that unfetched
    // pages remain: after the inactive-status filter is applied, a short
    // page is indistinguishable from the last page.
    let declaredTotal: number | null = null;

    for (let page = 0; page < this.#maxPages; page += 1) {
      const envelope = await this.#fetchPage(term, page, token, signal);

      if (declaredTotal === null) declaredTotal = envelope.total;
      matches.push(...envelope.matches);
      recordsFetched += envelope.recordsFetched;

      // A short page means the result set is exhausted: stop before
      // spending a request to confirm what the page size already told us.
      if (envelope.recordsFetched < this.#pageSize) break;
    }

    if (declaredTotal !== null && recordsFetched < declaredTotal) {
      throw new ProviderError(
        `EUIPO results truncated for term "${term}": fetched ${recordsFetched} of ` +
          `${declaredTotal} matching records (page size ${this.#pageSize}, at most ` +
          `${this.#maxPages} pages). Raise EUIPO_MAX_PAGES to verify this term completely.`,
        'EuipoProvider',
        'EUIPO_RESULT_TRUNCATED',
        {
          term,
          recordsFetched,
          declaredTotal,
          pageSize: this.#pageSize,
          maxPages: this.#maxPages,
        },
      );
    }

    return matches;
  }

  /**
   * Fetches one page of results, re-acquiring the access token exactly
   * once when the API rejects it as expired (401) or unauthorised (403).
   */
  async #fetchPage(
    term: string,
    page: number,
    token: string,
    signal: AbortSignal | undefined,
  ): Promise<EuipoPage> {
    const url = this.#buildSearchUrl(term, page);

    let response = await this.#request(url, token, signal);

    if (response.status === 401 || response.status === 403) {
      // The token expired between #getToken() and this request: discard it
      // and retry the same page once with a fresh one.
      this.#token = null;
      this.#tokenExpiresAt = 0;
      const freshToken = await this.#getToken();
      response = await this.#request(url, freshToken, signal);

      if (response.status === 401 || response.status === 403) {
        throw new ProviderError(
          `EUIPO search unauthorised (HTTP ${response.status}) for term "${term}". ` +
            'Verify EUIPO_CLIENT_ID (OAuth2 client_id is reused as X-IBM-Client-Id) ' +
            'and that the subscription to Trademark Search 1.1.0 is active.',
          'EuipoProvider',
          'EUIPO_UNAUTHORIZED',
        );
      }
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
        `EUIPO response is not valid JSON for term "${term}"`,
        'EuipoProvider',
        'EUIPO_PARSE_ERROR',
        {},
        err instanceof Error ? err : undefined,
      );
    }

    return this.#parsePage(data);
  }

  async #request(url: URL, token: string, signal: AbortSignal | undefined): Promise<Response> {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    try {
      return await this.#rateLimiter.throttle(() =>
        fetch(url.toString(), {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${token}`,
            'X-IBM-Client-Id': this.#clientId ?? '',
            Accept: 'application/json',
          },
          signal: signal !== undefined ? AbortSignal.any([signal, timeout]) : timeout,
        }),
      );
    } catch (err: unknown) {
      throw new ProviderError(
        `EUIPO request failed for "${url.searchParams.get('query') ?? ''}": ${String(err)}`,
        'EuipoProvider',
        'EUIPO_REQUEST_FAILED',
      );
    }
  }

  #buildSearchUrl(term: string, page: number): URL {
    const url = new URL(this.#apiUrl);
    // RSQL: `trademarkName==*<term>*` performs a case-insensitive substring
    // match against the verbal element (mark name). Wildcards are quoted
    // implicitly by `*`; the term itself is sanitised to prevent RSQL
    // injection (asterisks, spaces, and quotes inside the term would
    // otherwise break the query grammar).
    const sanitised = term.replace(/[\\*'"\s]/g, '').toLowerCase();
    url.searchParams.set('query', `trademarkName==*${sanitised}*`);
    url.searchParams.set('page', String(page));
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
      response = await this.#rateLimiter.throttle(() =>
        fetch(this.#authUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
          signal: AbortSignal.timeout(10_000),
        }),
      );
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
        {},
        err instanceof Error ? err : undefined,
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

  #parsePage(raw: unknown): EuipoPage {
    if (!isEuipoSearchResponse(raw)) return { matches: [], recordsFetched: 0, total: null };

    const list = raw.content ?? raw.items ?? raw.trademarks ?? [];
    const records = list.filter((tm): tm is EuipoTrademark => tm !== null && tm !== undefined);

    const matches = records
      .filter((tm) => isActiveEuipoStatus(tm.status))
      .map((tm) => ({
        markName: tm.trademarkName ?? '',
        owner: tm.applicantName ?? '',
        status: tm.status ?? '',
        source: 'EUIPO',
        registrationNumber: tm.applicationNumber ?? tm.registrationNumber ?? tm.filingNumber,
      }))
      .filter((m) => m.markName.length > 0);

    const total = raw.totalElements ?? raw.total ?? null;

    return { matches, recordsFetched: records.length, total };
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
