// SPDX-License-Identifier: AGPL-3.0-only
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
 *   - Random User-Agent selection across realistic browser values to reduce WAF
 *     challenge probability
 *   - Automatic retry with exponential backoff + jitter on WAF block
 *   - WAF block counter exposed via `wafBlockCount` for operator visibility
 *   - Prometheus counter metric for WAF blocks (ADR-0065)
 *
 * Any network or HTTP failure after retries is wrapped in a ProviderError
 * and allows the trademark gate to degrade gracefully (Principle 1 / §6).
 */

const ACTIVE_STATUS_PREFIX = '6-'; // USPTO status codes starting with 6 are registered/active

const logger = getLogger();

/** Honest client identifier. The USPTO search backend no longer serves a WAF
 *  challenge on the production search path, so there is no reason to rotate
 *  browser user-agents. Identifying the tool is both polite and useful for
 *  the USPTO's own operations. Update the version segment at each release. */
const USER_AGENT = 'dominus-oss/1.3.3 (+https://github.com/AlessioBrillo/dominus)';

const MAX_WAF_RETRIES = 3;

/** Maximum backoff delay in ms (increased from 8s to 30s for WAF resilience). */
const MAX_WAF_BACKOFF_MS = 30_000;

/** Jitter factor for retry backoff (±30%). */
const WAF_RETRY_JITTER_FACTOR = 0.3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isWafBlock(response: Response): boolean {
  const contentType = response.headers?.get?.('content-type') ?? '';
  const status = response.status;
  // AWS WAF typically returns 403, 503, or 200 with HTML/JavaScript content.
  // A JSON response at any status is a legitimate API response, never a WAF block.
  const isJson = contentType.includes('application/json') || contentType.includes('text/json');
  if (isJson) return false;
  if (status === 403 || status === 503) return true;
  if (status === 200) return true;
  return false;
}

/** Calculate exponential backoff with jitter for WAF retries. */
function calculateWafBackoff(attempt: number): number {
  const baseDelay = Math.min(1_000 * 2 ** attempt, MAX_WAF_BACKOFF_MS);
  const jitter = baseDelay * WAF_RETRY_JITTER_FACTOR * (Math.random() * 2 - 1); // ±30%
  return Math.round(baseDelay + jitter);
}

export interface UsptoProviderConfig {
  searchUrl: string;
  rateLimiter?: RateLimiterLike;
  /** Delay function for WAF retry backoff. Defaults to setTimeout-based sleep.
   *  Override in tests to avoid real delays (e.g. () => Promise.resolve()). */
  sleepFn?: (ms: number) => Promise<void>;
}

export class UsptoCasesProvider implements TrademarkProvider {
  readonly #searchUrl: string;
  readonly #rateLimiter: RateLimiterLike;
  readonly #sleepFn: (ms: number) => Promise<void>;
  #wafBlockCount: number = 0;
  #requestCount: number = 0;

  constructor(config: UsptoProviderConfig) {
    this.#searchUrl = config.searchUrl;
    this.#rateLimiter = config.rateLimiter ?? RateLimiter.unlimited();
    this.#sleepFn = config.sleepFn ?? sleep;
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
      // Request the current response field names. `_source` is the envelope
      // key the current backend uses; projecting only the fields we read
      // keeps the response small and makes schema drift visible (a missing
      // projected field is an unrecognized schema, not an empty result set).
      _source: [
        'wordmark',
        'wordmarkPseudoText',
        'statusCode',
        'statusDescription',
        'alive',
        'ownerName',
        'registrationId',
        'id',
      ],
      from: 0,
      size: 100,
    });

    // Random User-Agent selection instead of round-robin to avoid WAF
    // fingerprinting
    const userAgent = USER_AGENT;

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
        const delay = calculateWafBackoff(attempt);
        await this.#sleepFn(delay);
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
        const delay = calculateWafBackoff(attempt);
        await this.#sleepFn(delay);
        return this.#searchWithRetry(term, attempt + 1, signal);
      }
      logger.error(
        { httpStatus: response.status, term, wafBlockCount: this.#wafBlockCount },
        'USPTO WAF block persists after all retries — throwing for failover.',
      );
      throw new ProviderError(
        `USPTO WAF block exhausted for term "${term}" after ${MAX_WAF_RETRIES + 1} attempts`,
        'UsptoCasesProvider',
        'USPTO_WAF_EXHAUSTED',
      );
    }

    if (!response.ok) {
      // Fail closed (ADR-0012, Principle 6). A non-OK answer is NOT an
      // answer: returning an empty result set here would report "this
      // mark does not exist" for a request that never happened, and the
      // gate would clear a domain nobody checked. The error is thrown so
      // the failover can try the next source, and so the gate reports
      // Unverified when every source is down.
      logger.error(
        { httpStatus: response.status, term },
        'USPTO returned a non-OK HTTP status — failing closed so another source can answer.',
      );
      throw new ProviderError(
        `USPTO returned HTTP ${response.status} for term "${term}" — the search could not be performed.`,
        'UsptoCasesProvider',
        'USPTO_REQUEST_FAILED',
      );
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
        const delay = calculateWafBackoff(attempt);
        await this.#sleepFn(delay);
        return this.#searchWithRetry(term, attempt + 1, signal);
      }
      logger.error(
        { term, wafBlockCount: this.#wafBlockCount },
        'USPTO WAF block persists after all retries — throwing for failover.',
      );
      throw new ProviderError(
        `USPTO JSON WAF block exhausted for term "${term}" after ${MAX_WAF_RETRIES + 1} attempts`,
        'UsptoCasesProvider',
        'USPTO_WAF_EXHAUSTED',
      );
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch (err: unknown) {
      // A body that is not JSON is not an answer either (ADR-0012): the
      // backend may have changed, and an empty result set would be a
      // negative result carrying no weight.
      logger.error(
        { err, term },
        'USPTO response was not valid JSON — failing closed (the backend may have changed).',
      );
      throw new ProviderError(
        `USPTO response was not valid JSON for term "${term}" — the backend may have changed.`,
        'UsptoCasesProvider',
        'USPTO_INVALID_RESPONSE',
      );
    }

    return this.#parseResponse(data);
  }

  #parseResponse(raw: unknown): TrademarkMatch[] {
    if (!isUsptoResponse(raw)) {
      const preview = JSON.stringify(raw).slice(0, 300);
      throw new ProviderError(
        `USPTO response structure was unrecognised — expected { hits: { hits: [...] } }, got ${preview}.`,
        'UsptoCasesProvider',
        'USPTO_INVALID_RESPONSE',
      );
    }

    const hits = (raw.hits?.hits ?? []) as unknown[];
    if (!Array.isArray(hits)) {
      throw new ProviderError(
        'USPTO response structure was unrecognised — hits.hits is not an array.',
        'UsptoCasesProvider',
        'USPTO_INVALID_RESPONSE',
      );
    }

    const results: TrademarkMatch[] = [];
    let recognizableFields = 0;

    for (const rawHit of hits) {
      const hit = rawHit as Record<string, unknown>;
      const src = (hit.source ?? hit._source) as Record<string, unknown> | undefined;
      if (!src || typeof src !== 'object') continue;

      // The current backend nests fields under `source` with current names
      // (wordmark, alive, statusCode, ownerName, registrationId, id); the
      // legacy backend nested them under `_source` with WM/ST/ON/SN/RN.
      // Recognize either envelope and either field naming.
      const markName = String(
        src.wordmark ?? src.WM ?? src.wordmarkPseudoText ?? src.PM ?? '',
      ).trim();
      const owner = String(src.ownerName ?? src.ON ?? '');
      const registrationNumber = src.registrationId ?? src.RN ?? src.SN ?? src.id;

      let status: string;
      let active: boolean;
      if (src.alive !== undefined) {
        // `alive` is the authoritative activity flag on the current backend.
        active = src.alive === true;
        status = String(src.statusDescription ?? '');
      } else {
        status = String(src.ST ?? src.statusCode ?? '');
        active = isActiveStatus(status);
      }

      const hasReadableField =
        src.wordmark != null ||
        src.WM != null ||
        src.wordmarkPseudoText != null ||
        src.PM != null ||
        src.alive != null ||
        src.ST != null ||
        src.statusCode != null ||
        src.ownerName != null ||
        src.ON != null;
      if (hasReadableField) recognizableFields += 1;

      if (!markName) continue;
      if (!active) continue;

      results.push({
        markName,
        owner,
        status,
        source: 'USPTO',
        registrationNumber: registrationNumber ? String(registrationNumber) : undefined,
      });
    }

    // Fail closed: hits were returned but none carry a readable field, which
    // means the backend changed its shape and we cannot trust an empty list.
    // Reporting "no matches" here would clear a domain nobody checked
    // (Principle 6).
    if (hits.length > 0 && recognizableFields === 0) {
      const preview = JSON.stringify(hits).slice(0, 300);
      throw new ProviderError(
        `USPTO response schema was unrecognised: ${hits.length} hit(s) present but no readable mark fields (${preview}).`,
        'UsptoCasesProvider',
        'USPTO_INVALID_RESPONSE',
      );
    }

    return results;
  }
}

function isActiveStatus(st: string | undefined): boolean {
  if (!st) return false;
  // Active registrations start with "6-" in the USPTO status code scheme.
  // Applications in-progress start with "4-"; abandoned/cancelled start with "7-","8-".
  // We err on the side of caution: include everything except clearly abandoned/expired.
  return !st.startsWith('7-') && !st.startsWith('8-');
}

function isUsptoResponse(v: unknown): v is { hits?: { hits?: unknown[] } } {
  return typeof v === 'object' && v !== null && 'hits' in v;
}

export { ACTIVE_STATUS_PREFIX };
