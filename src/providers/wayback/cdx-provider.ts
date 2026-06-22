import { ProviderError } from '../../types/errors.js';
import { RateLimiter } from '../rate-limiter.js';
import type { WaybackProvider, WaybackResult } from './wayback-provider.js';

const CDX_SEARCH_URL = 'https://web.archive.org/cdx/search/cdx';
const DEFAULT_TIMEOUT_MS = 10_000;
const CDX_PAGE_SIZE = 5000;

interface CdxRow {
  timestamp: string;
  original: string;
  statusCode: string;
}

function parseCdxJson(raw: string): CdxRow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed) || parsed.length < 2) return [];
  const rows: CdxRow[] = [];
  for (let i = 1; i < parsed.length; i++) {
    const entry = parsed[i];
    if (!Array.isArray(entry) || entry.length < 3) continue;
    const timestamp = entry[0];
    const original = entry[1];
    const statusCode = entry[2];
    if (typeof timestamp !== 'string' || typeof original !== 'string' || typeof statusCode !== 'string') continue;
    rows.push({ timestamp, original, statusCode });
  }
  return rows;
}

function timestampToDate(ts: string): Date {
  const year = Number.parseInt(ts.slice(0, 4), 10);
  const month = Number.parseInt(ts.slice(4, 6), 10) - 1;
  const day = Number.parseInt(ts.slice(6, 8), 10);
  const hour = Number.parseInt(ts.slice(8, 10), 10);
  const min = Number.parseInt(ts.slice(10, 12), 10);
  const sec = Number.parseInt(ts.slice(12, 14), 10);
  return new Date(year, month, day, hour, min, sec);
}

export class CdxWaybackProvider implements WaybackProvider {
  readonly name: string;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #rateLimiter: RateLimiter;

  constructor(
    baseUrl: string = CDX_SEARCH_URL,
    rateLimiter?: RateLimiter,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {
    this.#baseUrl = baseUrl;
    this.name = 'CdxWaybackProvider';
    this.#rateLimiter = rateLimiter ?? RateLimiter.unlimited();
    this.#timeoutMs = timeoutMs;
  }

  async getExpiryData(domain: string, signal?: AbortSignal): Promise<WaybackResult> {
    return this.#rateLimiter.throttle(() => this.#doGetExpiryData(domain, signal));
  }

  async #doGetExpiryData(domain: string, signal?: AbortSignal): Promise<WaybackResult> {
    const url = this.#buildCdxUrl(domain, 0);
    const rows = await this.#fetchAllPages(url, domain, signal);

    if (rows.length === 0) {
      return this.#emptyResult(domain);
    }

    const checkedAt = new Date().toISOString();

    const firstTimestamp = rows[0]?.timestamp;
    if (firstTimestamp === undefined) {
      return { domain, domainAge: 0, waybackSnapshots: 0, checkedAt };
    }

    const firstDate = timestampToDate(firstTimestamp);
    const domainAge = Math.max(0, (Date.now() - firstDate.getTime()) / (365.25 * 24 * 60 * 60 * 1000));

    return {
      domain,
      domainAge: Math.round(domainAge * 10) / 10,
      waybackSnapshots: rows.length,
      checkedAt,
    };
  }

  async #fetchAllPages(url: URL, domain: string, signal?: AbortSignal): Promise<CdxRow[]> {
    const allRows: CdxRow[] = [];
    let offset = 0;

    while (true) {
      if (signal?.aborted) throw new ProviderError(`Wayback CDX aborted for ${domain}`, this.name);

      url.searchParams.set('offset', String(offset));

      let response: Response;
      try {
        response = await fetch(url.toString(), {
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(this.#timeoutMs)])
            : AbortSignal.timeout(this.#timeoutMs),
        });
      } catch (err) {
        if (allRows.length > 0) return allRows;
        throw new ProviderError(`Wayback CDX request failed for ${domain}: ${String(err)}`, this.name);
      }

      if (response.status === 404) return allRows;
      if (!response.ok) {
        if (allRows.length > 0) return allRows;
        if (response.status === 429) {
          throw new ProviderError(`Wayback CDX rate limited for ${domain}`, this.name, 'RATE_LIMITED');
        }
        return allRows;
      }

      const raw = await response.text();
      const rows = parseCdxJson(raw);

      if (rows.length === 0) return allRows;

      allRows.push(...rows);
      offset += CDX_PAGE_SIZE;

      if (rows.length < CDX_PAGE_SIZE) return allRows;
    }
  }

  #buildCdxUrl(domain: string, offset: number): URL {
    const url = new URL(this.#baseUrl);
    url.searchParams.set('url', `${domain}/*`);
    url.searchParams.set('output', 'json');
    url.searchParams.set('fl', 'timestamp,original,statuscode');
    url.searchParams.set('limit', String(CDX_PAGE_SIZE));
    url.searchParams.set('offset', String(offset));
    return url;
  }

  #emptyResult(domain: string): WaybackResult {
    return { domain, domainAge: 0, waybackSnapshots: 0, checkedAt: new Date().toISOString() };
  }
}
