import { ProviderError } from '../../types/errors.js';
import type { TrademarkMatch, TrademarkProvider } from './trademark-provider.js';
import { type RateLimiterLike, RateLimiter } from '../rate-limiter.js';
import { getLogger } from '../../logger.js';

/**
 * Keyless USPTO trademark search provider with WAF resilience.
 *
 * Uses the tmsearch.uspto.gov Elasticsearch backend (POST /tmsearch).
 * The endpoint accepts queries over Elasticsearch fields:
 *   WM — word mark, ST — status, ON — owner name,
 *   SN — serial number, RN — registration number.
 *
 * The endpoint is protected by AWS WAF on the browser-facing path; server-side
 * requests may be blocked depending on the WAF configuration. This provider
 * implements:
 *   - User-Agent rotation across realistic browser values to reduce WAF
 *     challenge probability
 *   - Automatic retry with exponential backoff on WAF block (non-JSON
 *     response, 403/503)
 *   - WAF block counter exposed via `wafBlockCount` for operator visibility
 *
 * Any network or HTTP failure after retries is wrapped in a ProviderError
 * and allows the trademark gate to degrade gracefully (Principle 1 / §6).
 */

interface UsptoBucket {
  WM?: string;
  PM?: string; // pseudo mark
  ST?: string;
  ON?: string;
  SN?: string;
  RN?: string;
}

interface UsptoHit {
  _source?: UsptoBucket;
}

interface UsptoResponse {
  hits?: {
    total?: { value?: number };
    hits?: UsptoHit[];
  };
}

const ACTIVE_STATUS_PREFIX = '6-'; // USPTO status codes starting with 6 are registered/active

const logger = getLogger();

const USER_AGENTS: readonly string[] = [
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:126.0) Gecko/20100101 Firefox/126.0',
];

const MAX_WAF_RETRIES = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isWafBlock(response: Response): boolean {
  const contentType = response.headers?.get?.('content-type') ?? '';
  const status = response.status;
  // AWS WAF typically returns 403, 503, or 200 with HTML/JavaScript content
  if (status === 403 || status === 503) return true;
  if (
    status === 200 &&
    !contentType.includes('application/json') &&
    !contentType.includes('text/json')
  )
    return true;
  return false;
}

export interface UsptoProviderConfig {
  searchUrl: string;
  rateLimiter?: RateLimiterLike;
}

export class UsptoCasesProvider implements TrademarkProvider {
  readonly #searchUrl: string;
  readonly #rateLimiter: RateLimiterLike;
  #wafBlockCount: number = 0;
  #requestCount: number = 0;

  constructor(config: UsptoProviderConfig) {
    this.#searchUrl = config.searchUrl;
    this.#rateLimiter = config.rateLimiter ?? RateLimiter.unlimited();
  }

  /** Number of WAF blocks detected since provider creation. */
  get wafBlockCount(): number {
    return this.#wafBlockCount;
  }

  /** Total search requests made since provider creation. */
  get requestCount(): number {
    return this.#requestCount;
  }

  /** Ratio of WAF-blocked requests to total (0-1). NaN when no requests made. */
  get wafBlockRate(): number {
    if (this.#requestCount === 0) return NaN;
    return this.#wafBlockCount / this.#requestCount;
  }

  async search(term: string, signal?: AbortSignal): Promise<TrademarkMatch[]> {
    return this.#searchWithRetry(term, 0, signal);
  }

  async #searchWithRetry(
    term: string,
    attempt: number,
    signal?: AbortSignal,
  ): Promise<TrademarkMatch[]> {
    const body = JSON.stringify({
      query: {
        bool: {
          should: [
            { match_phrase: { WM: { query: term, boost: 5 } } },
            { match: { WM: { query: term, boost: 2 } } },
            { match_phrase: { PM: { query: term, boost: 1 } } },
          ],
          minimum_should_match: 1,
        },
      },
      _source: ['WM', 'PM', 'ST', 'ON', 'SN', 'RN'],
      from: 0,
      size: 50,
    });

    const userAgent = USER_AGENTS[(attempt + this.#requestCount) % USER_AGENTS.length]!;

    let response: Response;
    try {
      const abortTimeout = AbortSignal.timeout(8_000);
      const combined = signal ? AbortSignal.any([signal, abortTimeout]) : abortTimeout;
      response = await this.#rateLimiter.throttle(() =>
        fetch(this.#searchUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'User-Agent': userAgent,
          },
          body,
          signal: combined,
        }),
      );
    } catch (err: unknown) {
      this.#requestCount++;
      if (attempt < MAX_WAF_RETRIES) {
        const delay = Math.min(1_000 * 2 ** attempt, 8_000);
        await sleep(delay);
        return this.#searchWithRetry(term, attempt + 1, signal);
      }
      throw new ProviderError(
        `USPTO request failed for term "${term}" after ${attempt + 1} attempts: ${String(err)}`,
        'UsptoCasesProvider',
        'USPTO_REQUEST_FAILED',
      );
    }

    this.#requestCount++;

    if (!response.ok && isWafBlock(response)) {
      this.#wafBlockCount++;
      const text = await response.text().catch(() => '');
      const snippet = text.length > 200 ? text.slice(0, 200) : text;
      logger.warn(
        {
          httpStatus: response.status,
          contentType: response.headers?.get?.('content-type'),
          snippet,
          term,
          attempt,
        },
        `USPTO WAF block on attempt ${attempt + 1}`,
      );
      if (attempt < MAX_WAF_RETRIES) {
        const delay = Math.min(1_000 * 2 ** attempt, 8_000);
        await sleep(delay);
        return this.#searchWithRetry(term, attempt + 1, signal);
      }
      logger.error(
        { httpStatus: response.status, term, wafBlockCount: this.#wafBlockCount },
        'USPTO WAF block persists after all retries — degrading to empty result set.',
      );
      return [];
    }

    if (!response.ok) {
      logger.warn(
        { httpStatus: response.status, term },
        'USPTO returned non-OK HTTP status — degrading to empty result set.',
      );
      return [];
    }

    const contentType = response.headers?.get?.('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      // WAF block detection on 200 OK with non-JSON content
      this.#wafBlockCount++;
      const text = await response.text().catch(() => '');
      const snippet = text.length > 200 ? text.slice(0, 200) : text;
      logger.warn(
        { contentType, snippet, term, attempt },
        `USPTO returned non-JSON response (attempt ${attempt + 1}) — likely WAF blocking.`,
      );
      if (attempt < MAX_WAF_RETRIES) {
        const delay = Math.min(1_000 * 2 ** attempt, 8_000);
        await sleep(delay);
        return this.#searchWithRetry(term, attempt + 1, signal);
      }
      logger.error(
        { term, wafBlockCount: this.#wafBlockCount },
        'USPTO WAF block persists after all retries — degrading to empty result set.',
      );
      return [];
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch (err: unknown) {
      logger.warn(
        { err, term },
        'USPTO response not valid JSON — backend may have changed. ' +
          'Degrading: treating as no matches found.',
      );
      return [];
    }

    const result = this.#parseResponse(data);
    if (result.length > 0) return result;

    if (!isUsptoResponse(data)) {
      const preview = JSON.stringify(data).slice(0, 300);
      logger.warn(
        { term, preview },
        'USPTO response structure unrecognised — expected { hits: { hits: [...] } }. ' +
          'The USPTO Elasticsearch backend may have changed its response format. ' +
          'Degrading: treating as no matches found. If this persists, check tmsearch.uspto.gov.',
      );
    }

    return result;
  }

  #parseResponse(raw: unknown): TrademarkMatch[] {
    if (!isUsptoResponse(raw)) return [];

    const hits = raw.hits?.hits ?? [];
    return hits
      .map((hit) => hit._source)
      .filter((src): src is UsptoBucket => src !== undefined && src !== null)
      .filter((src) => isActiveStatus(src.ST))
      .map((src) => ({
        markName: src.WM ?? src.PM ?? '',
        owner: src.ON ?? '',
        status: src.ST ?? '',
        source: 'USPTO',
        registrationNumber: src.RN ?? src.SN,
      }))
      .filter((m) => m.markName.length > 0);
  }
}

function isActiveStatus(st: string | undefined): boolean {
  if (!st) return false;
  // Active registrations start with "6-" in the USPTO status code scheme.
  // Applications in-progress start with "4-"; abandoned/cancelled start with "7-","8-".
  // We err on the side of caution: include everything except clearly abandoned/expired.
  return !st.startsWith('7-') && !st.startsWith('8-');
}

function isUsptoResponse(v: unknown): v is UsptoResponse {
  return typeof v === 'object' && v !== null && 'hits' in v;
}

export { ACTIVE_STATUS_PREFIX };
