import { ProviderError } from '../../types/errors.js';
import type { TrademarkMatch, TrademarkProvider } from './trademark-provider.js';
import { RateLimiter } from '../rate-limiter.js';

/**
 * Keyless USPTO trademark search provider.
 *
 * Uses the tmsearch.uspto.gov Elasticsearch backend (POST /tmsearch).
 * The endpoint accepts queries over Elasticsearch fields:
 *   WM — word mark, ST — status, ON — owner name,
 *   SN — serial number, RN — registration number.
 *
 * The endpoint is protected by AWS WAF on the browser-facing path; server-side
 * requests may be blocked depending on the WAF configuration. Any network or
 * HTTP failure is wrapped in a ProviderError and allows the trademark gate to
 * degrade gracefully (Principle 1 / Principle 6).
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

export interface UsptoProviderConfig {
  searchUrl: string;
  rateLimiter?: RateLimiter;
}

export class UsptoCasesProvider implements TrademarkProvider {
  readonly #searchUrl: string;
  readonly #rateLimiter: RateLimiter;

  constructor(config: UsptoProviderConfig) {
    this.#searchUrl = config.searchUrl;
    this.#rateLimiter = config.rateLimiter ?? RateLimiter.unlimited();
  }

  async search(term: string): Promise<TrademarkMatch[]> {
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

    let response: Response;
    try {
      response = await this.#rateLimiter.throttle(() =>
        fetch(this.#searchUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'User-Agent': 'Mozilla/5.0 (compatible; DOMINUS/1.0 trademark-check)',
          },
          body,
          signal: AbortSignal.timeout(8_000),
        }),
      );
    } catch (err: unknown) {
      throw new ProviderError(
        `USPTO request failed for term "${term}": ${String(err)}`,
        'UsptoCasesProvider',
        'USPTO_REQUEST_FAILED',
      );
    }

    if (!response.ok) {
      throw new ProviderError(
        `USPTO search returned HTTP ${response.status} for term "${term}"`,
        'UsptoCasesProvider',
        'USPTO_HTTP_ERROR',
      );
    }

    const contentType = response.headers?.get?.('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      const text = await response.text().catch(() => '');
      const snippet = text.length > 200 ? text.slice(0, 200) : text;
      throw new ProviderError(
        `USPTO returned non-JSON response for term "${term}" (content-type: ${contentType}). ` +
          `This may indicate AWS WAF blocking. Response: ${snippet}`,
        'UsptoCasesProvider',
        'USPTO_WAF_BLOCK',
      );
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch (err: unknown) {
      throw new ProviderError(
        `USPTO response is not valid JSON for term "${term}": ${String(err)}`,
        'UsptoCasesProvider',
        'USPTO_PARSE_ERROR',
      );
    }

    return this.#parseResponse(data);
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
