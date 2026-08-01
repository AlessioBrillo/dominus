// SPDX-License-Identifier: AGPL-3.0-only
import { ProviderError } from '../../types/errors.js';
import type { TrademarkMatch, TrademarkProvider } from './trademark-provider.js';
import { type RateLimiterLike, RateLimiter } from '../rate-limiter.js';
import { getLogger } from '../../logger.js';

const TSDR_TIMEOUT_MS = 10_000;

interface TsdrResponseItem {
  markName?: string;
  mark_identification?: string;
  statusCode?: string;
  status?: string;
  owner?: string;
  filingDate?: string;
  registrationDate?: string;
  registrationNumber?: string;
  serialNumber?: string;
}

const logger = getLogger();

export class TsdrTrademarkProvider implements TrademarkProvider {
  readonly name: string;
  readonly #searchUrl: string;
  readonly #rateLimiter: RateLimiterLike;

  constructor(
    searchUrl = 'https://tsdr.uspto.gov/tsdr/tmsearch/data',
    rateLimiter?: RateLimiterLike,
  ) {
    this.name = 'TsdrTrademarkProvider';
    this.#searchUrl = searchUrl;
    this.#rateLimiter = rateLimiter ?? RateLimiter.unlimited();
  }

  async search(term: string, signal?: AbortSignal): Promise<TrademarkMatch[]> {
    const url = `${this.#searchUrl}?searchType=basic&search=${encodeURIComponent(term)}`;

    let response: Response;
    try {
      const timeout = AbortSignal.timeout(TSDR_TIMEOUT_MS);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      response = await this.#rateLimiter.throttle(() => fetch(url, { signal: combined }));
    } catch (err: unknown) {
      throw new ProviderError(
        `TSDR request failed for term "${term}": ${String(err)}`,
        this.name,
        'TSDR_REQUEST_FAILED',
      );
    }

    if (!response.ok) {
      logger.warn({ httpStatus: response.status, term }, 'TSDR returned non-OK status');
      return [];
    }

    const contentType = response.headers?.get?.('content-type') ?? '';
    if (!contentType.includes('application/json') && !contentType.includes('text/json')) {
      logger.warn({ contentType, term }, 'TSDR returned non-JSON response');
      return [];
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch {
      logger.warn({ term }, 'TSDR response not valid JSON');
      return [];
    }

    const parsed = this.#parseResponse(data);
    if (parsed.length === 0) {
      logger.debug({ term, preview: JSON.stringify(data).slice(0, 200) }, 'TSDR no matches found');
    }
    return parsed;
  }

  #parseResponse(raw: unknown): TrademarkMatch[] {
    if (typeof raw !== 'object' || raw === null) return [];

    // Accept two envelope shapes: { results: [...] } or { items: [...] }
    const items: TsdrResponseItem[] = [];
    const r = raw as Record<string, unknown>;

    if (Array.isArray(r.results)) {
      items.push(...r.results);
    }
    if (Array.isArray(r.items)) {
      items.push(...r.items);
    }

    return items
      .filter((item): item is TsdrResponseItem & { markName: string } => {
        const name = item.markName ?? item.mark_identification ?? '';
        return name.trim().length > 0;
      })
      .map((item) => ({
        markName: item.markName ?? item.mark_identification ?? '',
        owner: item.owner ?? '',
        registrationNumber: item.registrationNumber ?? item.serialNumber,
        source: 'USPTO' as const,
        status: 'UNKNOWN',
      }));
  }
}
