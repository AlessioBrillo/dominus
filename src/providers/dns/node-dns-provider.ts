import { promises as dnsPromises } from 'node:dns';
import { DomainStatus } from '../../types/domain-status.js';
import type { DnsCheckResult } from '../../types/domain-status.js';
import { loadConfig } from '../../config.js';

export interface DnsProvider {
  checkAvailability(domain: string, signal?: AbortSignal): Promise<DnsCheckResult>;
  checkBulk(domains: string[], signal?: AbortSignal): Promise<DnsCheckResult[]>;
  clearCache(): void;
}

import { getLogger } from '../../logger.js';

const logger = getLogger();

type DnsRecordType = 'A' | 'AAAA' | 'CNAME' | 'MX' | 'NS' | 'SOA';

export type DnsLookupStrategy = 'native' | 'native-with-doh-fallback' | 'doh-only';

function getLookupTimeout(): number {
  try {
    return loadConfig().DNS_LOOKUP_TIMEOUT_MS;
  } catch {
    return 1500;
  }
}

function getLookupStrategy(): DnsLookupStrategy {
  try {
    return loadConfig().DNS_LOOKUP_STRATEGY;
  } catch {
    return 'native';
  }
}

function getDohEndpoint(): string {
  try {
    return loadConfig().DNS_DOH_ENDPOINT;
  } catch {
    return 'https://cloudflare-dns.com/dns-query';
  }
}

function getDefaultCacheTtl(): number {
  try {
    return loadConfig().DNS_CACHE_TTL_SECONDS * 1000;
  } catch {
    return 300_000;
  }
}

function resolveWithTimeout(
  domain: string,
  recordType: DnsRecordType,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error(`DNS ${recordType} lookup timed out for ${domain}`);
      (err as { code?: string }).code = 'ETIMEOUT';
      reject(err);
    }, timeoutMs);

    if (signal?.aborted) {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }

    const abortHandler = (): void => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', abortHandler, { once: true });

    dnsPromises
      .resolve(domain, recordType)
      .then(() => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abortHandler);
        resolve(true);
      })
      .catch((err) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abortHandler);
        reject(err);
      });
  });
}

async function resolveDoh(
  domain: string,
  recordType: string,
  endpoint: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const url = new URL(endpoint);
  url.searchParams.set('name', domain);
  url.searchParams.set('type', recordType);

  const init: Parameters<typeof fetch>[1] & { signal?: AbortSignal } = {
    headers: { accept: 'application/dns-json' },
  };
  if (signal !== undefined) init.signal = signal as AbortSignal;

  const response = await fetch(url.toString(), init);

  if (!response.ok) {
    throw new Error(`DoH query failed: ${response.status}`);
  }

  const data = (await response.json()) as {
    Status: number;
    Answer?: Array<{ type: number; data: string }>;
  };

  if (data.Status === 3) {
    throw Object.assign(new Error('DoH NXDOMAIN'), { code: 'ENOTFOUND' });
  }

  if (!data.Answer || data.Answer.length === 0) {
    throw Object.assign(new Error('DoH NODATA'), { code: 'ENODATA' });
  }

  return true;
}

const ALL_RECORDS: DnsRecordType[] = ['A', 'AAAA', 'CNAME', 'MX', 'NS', 'SOA'];

async function resolvesAnyNative(
  domain: string,
  timeout: number,
  signal?: AbortSignal,
): Promise<boolean | undefined> {
  // Launch ALL record types in parallel via race.
  // First resolve → domain is registered (return true).
  // All reject with NXDOMAIN/NODATA → domain is available (return false).
  // Any reject with timeout → unknown (return undefined).
  const childAbort = new AbortController();
  const combinedSignal = signal ? AbortSignal.any([signal, childAbort.signal]) : childAbort.signal;

  const tasks = ALL_RECORDS.map((type) =>
    resolveWithTimeout(domain, type, timeout, combinedSignal)
      .then(() => {
        childAbort.abort();
        return { type, resolved: true as const, aborted: false as const };
      })
      .catch((err: unknown) => {
        const e = err as { code?: string; name?: string };
        return {
          type,
          resolved: false as const,
          aborted: e.name === ('AbortError' as const),
          code: e.code,
        };
      }),
  );

  const outcomes = await Promise.all(tasks);

  // If any record type resolved → domain is registered
  for (const o of outcomes) {
    if (o.resolved) return true;
  }

  let anyTimeout = false;
  for (const o of outcomes) {
    if (o.resolved) continue;
    if (o.aborted) continue;
    const c = o.code;
    if (c === 'ETIMEOUT' || c === 'ESOCKETTIMEOUT') {
      anyTimeout = true;
    } else if (c !== 'ENOTFOUND' && c !== 'ENODATA' && c !== undefined) {
      return undefined;
    }
  }

  if (anyTimeout) {
    logger.warn({ domain }, 'DNS: all record types timed out or NXDOMAIN');
    return undefined;
  }

  return false;
}

const DOH_TYPES = ['A', 'AAAA', 'NS', 'SOA'];

async function resolvesAnyDoh(
  domain: string,
  endpoint: string,
  timeout: number,
  signal?: AbortSignal,
): Promise<boolean | undefined> {
  const childAbort = new AbortController();
  const combinedSignal = signal ? AbortSignal.any([signal, childAbort.signal]) : childAbort.signal;

  const tasks = DOH_TYPES.map((type) => {
    const timeoutSignal = AbortSignal.timeout(timeout);
    const merged = AbortSignal.any([combinedSignal, timeoutSignal]);
    return resolveDoh(domain, type, endpoint, merged)
      .then(() => {
        childAbort.abort();
        return { resolved: true as const, aborted: false as const };
      })
      .catch((err: unknown) => {
        const e = err as { code?: string; name?: string };
        return {
          resolved: false as const,
          aborted: e.name === ('AbortError' as const),
          code: e.code,
        };
      });
  });

  const outcomes = await Promise.all(tasks);

  for (const o of outcomes) {
    if (o.resolved) return true;
  }

  const anyUnknown = outcomes.some(
    (o) =>
      !o.resolved &&
      !o.aborted &&
      o.code !== undefined &&
      o.code !== 'ENOTFOUND' &&
      o.code !== 'ENODATA',
  );
  if (anyUnknown) return undefined;
  return false;
}

interface CacheEntry {
  result: DnsCheckResult;
  expiresAt: number;
}

export class NodeDnsProvider implements DnsProvider {
  #cache: Map<string, CacheEntry> = new Map();
  readonly #cacheTtlMs: number;
  readonly #maxSize: number;

  constructor(cacheTtlMs?: number, maxSize?: number) {
    this.#cacheTtlMs = cacheTtlMs ?? getDefaultCacheTtl();
    this.#maxSize = maxSize ?? 10000;
  }

  /** Clear cached entries older than TTL */
  pruneCache(): number {
    const now = Date.now();
    let pruned = 0;
    for (const [key, entry] of this.#cache) {
      if (entry.expiresAt < now) {
        this.#cache.delete(key);
        pruned++;
      }
    }
    return pruned;
  }

  clearCache(): void {
    this.#cache.clear();
  }

  async checkAvailability(domain: string, signal?: AbortSignal): Promise<DnsCheckResult> {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    const cached = this.#cache.get(domain);
    if (cached !== undefined && cached.expiresAt > Date.now()) {
      return cached.result;
    }

    const strategy = getLookupStrategy();
    const timeout = getLookupTimeout();
    const checkedAt = new Date().toISOString();

    try {
      if (strategy === 'doh-only') {
        const endpoint = getDohEndpoint();
        const doh = await resolvesAnyDoh(domain, endpoint, timeout, signal);
        if (doh !== undefined) {
          return this.#cached(domain, {
            domain,
            status: doh ? DomainStatus.Registered : DomainStatus.Available,
            checkedAt,
          });
        }
        return this.#cached(domain, { domain, status: DomainStatus.Unknown, checkedAt });
      }

      const native = await resolvesAnyNative(domain, timeout, signal);

      if (native !== undefined) {
        return this.#cached(domain, {
          domain,
          status: native ? DomainStatus.Registered : DomainStatus.Available,
          checkedAt,
        });
      }

      // Native resolver timed out — try DoH fallback if enabled
      if (strategy === 'native-with-doh-fallback') {
        const endpoint = getDohEndpoint();
        logger.warn({ domain, endpoint }, 'DNS: native resolver timed out, falling back to DoH');
        const doh = await resolvesAnyDoh(domain, endpoint, timeout, signal);
        if (doh !== undefined) {
          return this.#cached(domain, {
            domain,
            status: doh ? DomainStatus.Registered : DomainStatus.Available,
            checkedAt,
          });
        }
      }

      return this.#cached(domain, { domain, status: DomainStatus.Unknown, checkedAt });
    } catch (err: unknown) {
      const code = (err as { code?: string }).code;
      if (code === 'ENOTFOUND' || code === 'ENODATA') {
        return this.#cached(domain, { domain, status: DomainStatus.Available, checkedAt });
      }
      return this.#cached(domain, { domain, status: DomainStatus.Unknown, checkedAt });
    }
  }

  #cached(domain: string, result: DnsCheckResult): DnsCheckResult {
    if (this.#maxSize > 0) {
      if (this.#cache.has(domain)) {
        this.#cache.delete(domain);
      } else if (this.#cache.size >= this.#maxSize) {
        const oldest = this.#cache.keys().next();
        if (!oldest.done && oldest.value !== undefined) {
          this.#cache.delete(oldest.value);
        }
      }
      this.#cache.set(domain, { result, expiresAt: Date.now() + this.#cacheTtlMs });
    }
    return result;
  }

  async checkBulk(domains: string[], signal?: AbortSignal): Promise<DnsCheckResult[]> {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const concurrency = loadConfig().DNS_BULK_CONCURRENCY;
    const results: DnsCheckResult[] = [];
    for (let i = 0; i < domains.length; i += concurrency) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const chunk = domains.slice(i, i + concurrency);
      const chunkResults = await Promise.all(
        chunk.map((d) =>
          this.checkAvailability(d, signal).catch(() => ({
            domain: d,
            status: DomainStatus.Unknown,
            checkedAt: new Date().toISOString(),
          })),
        ),
      );
      results.push(...chunkResults);
    }
    return results;
  }
}
