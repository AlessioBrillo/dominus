import { promises as dnsPromises } from 'node:dns';
import { DomainStatus } from '../../types/domain-status.js';
import type { DnsCheckResult } from '../../types/domain-status.js';
import type { DnsProvider, DnsResolverGroup } from './dns-provider.js';
import { strategyToResolverGroups } from './dns-provider.js';
import { ParkingIpRegistry } from './parking-ip-registry.js';
import type { RateLimiter } from '../rate-limiter.js';
import { withRetry } from '../retryable-provider.js';
import type { RetryPolicy } from '../retry-policy.js';
import { getLogger } from '../../logger.js';

const logger = getLogger();

type DnsRecordType = 'A' | 'AAAA' | 'CNAME' | 'MX' | 'NS' | 'SOA';

export type DnsLookupStrategy = 'native' | 'native-with-doh-fallback' | 'doh-only' | 'doh-primary';

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

/** Resolve only A (IPv4) records to collect raw IP addresses for parking detection. */
async function resolveAddressRecords(domain: string): Promise<string[]> {
  const result = await dnsPromises.resolve(domain, 'A').catch(() => [] as string[]);

  return result;
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
      (o.code === undefined || (o.code !== 'ENOTFOUND' && o.code !== 'ENODATA')),
  );
  if (anyUnknown) return undefined;
  return false;
}

interface CacheEntry {
  result: DnsCheckResult;
  expiresAt: number;
}

export class NodeDnsProvider implements DnsProvider {
  readonly name = 'NodeDnsProvider';
  readonly #lookupTimeoutMs: number;
  readonly #resolverGroups: DnsResolverGroup[];
  readonly #dohEndpoint: string;
  readonly #cacheTtlMs: number;
  readonly #maxSize: number;
  readonly #bulkConcurrency: number;
  readonly #parkingEnabled: boolean;
  readonly #parkingRegistry: ParkingIpRegistry;
  readonly #rateLimiter: RateLimiter | undefined;
  readonly #retryPolicy: Partial<RetryPolicy> | undefined;
  #cache: Map<string, CacheEntry> = new Map();

  constructor(options?: {
    lookupTimeoutMs?: number;
    lookupStrategy?: DnsLookupStrategy;
    resolverGroups?: DnsResolverGroup[];
    dohEndpoint?: string;
    cacheTtlMs?: number;
    maxSize?: number;
    bulkConcurrency?: number;
    parkingEnabled?: boolean;
    parkingRegistry?: ParkingIpRegistry;
    rateLimiter?: RateLimiter | undefined;
    retryPolicy?: Partial<RetryPolicy> | undefined;
  }) {
    this.#lookupTimeoutMs = options?.lookupTimeoutMs ?? 1500;
    this.#dohEndpoint = options?.dohEndpoint ?? 'https://cloudflare-dns.com/dns-query';
    this.#cacheTtlMs = options?.cacheTtlMs ?? 300_000;
    this.#maxSize = options?.maxSize ?? 10000;
    this.#bulkConcurrency = options?.bulkConcurrency ?? 50;
    this.#parkingEnabled = options?.parkingEnabled ?? false;
    this.#parkingRegistry = options?.parkingRegistry ?? new ParkingIpRegistry([]);
    this.#rateLimiter = options?.rateLimiter;
    this.#retryPolicy = options?.retryPolicy;
    this.#resolverGroups =
      options?.resolverGroups ??
      strategyToResolverGroups(options?.lookupStrategy ?? 'native', this.#dohEndpoint);
  }

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

    const checkedAt = new Date().toISOString();

    try {
      const resolveFn = (s?: AbortSignal): Promise<boolean | undefined> =>
        this.#resolveDomain(domain, s);

      let resolved: boolean | undefined;

      if (this.#rateLimiter && this.#retryPolicy) {
        await this.#rateLimiter.acquire();
        resolved = await withRetry(resolveFn, `dns:${domain}`, this.#retryPolicy, signal);
      } else if (this.#rateLimiter) {
        await this.#rateLimiter.acquire();
        resolved = await resolveFn(signal);
      } else if (this.#retryPolicy) {
        resolved = await withRetry(resolveFn, `dns:${domain}`, this.#retryPolicy, signal);
      } else {
        resolved = await resolveFn(signal);
      }

      if (resolved !== undefined) {
        const status = resolved ? DomainStatus.Registered : DomainStatus.Available;
        let isParked: boolean | undefined;
        let parkingRegistrar: string | undefined;

        if (resolved && this.#parkingEnabled) {
          const addresses = await resolveAddressRecords(domain);
          const parkingCheck = this.#parkingRegistry.checkIps(addresses);
          isParked = parkingCheck.parked || undefined;
          parkingRegistrar = parkingCheck.registrar;
        }

        return this.#cached(domain, { domain, status, checkedAt, isParked, parkingRegistrar });
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

  async #resolveDomain(domain: string, signal?: AbortSignal): Promise<boolean | undefined> {
    for (let i = 0; i < this.#resolverGroups.length; i++) {
      const group = this.#resolverGroups[i];
      if (group === undefined) continue;
      const result = await this.#raceGroup(domain, group, signal);
      if (result !== undefined) return result;
      if (i < this.#resolverGroups.length - 1) {
        logger.warn(
          { domain, group: group.name, remaining: this.#resolverGroups.length - i - 1 },
          'DNS: resolver group failed, trying next group',
        );
      }
    }
    return undefined;
  }

  async #raceGroup(
    domain: string,
    group: DnsResolverGroup,
    signal?: AbortSignal,
  ): Promise<boolean | undefined> {
    const childAbort = new AbortController();
    const combinedSignal = signal
      ? AbortSignal.any([signal, childAbort.signal])
      : childAbort.signal;

    const timeout = this.#lookupTimeoutMs;

    const tasks = group.lookups.map((spec) => {
      if (spec.type === 'native') {
        return resolvesAnyNative(domain, timeout, combinedSignal);
      }
      return resolvesAnyDoh(domain, spec.endpoint ?? this.#dohEndpoint, timeout, combinedSignal);
    });

    const outcomes = await Promise.allSettled(tasks);

    for (const o of outcomes) {
      if (o.status === 'fulfilled' && o.value === true) {
        childAbort.abort();
        return true;
      }
    }

    childAbort.abort();

    let anyDefinitive = false;
    for (const o of outcomes) {
      if (o.status === 'fulfilled' && o.value !== undefined) {
        anyDefinitive = true;
      }
    }

    if (anyDefinitive) return false;

    let anyRejected = false;
    for (const o of outcomes) {
      if (o.status === 'rejected') {
        anyRejected = true;
        break;
      }
    }

    if (anyRejected) return undefined;

    for (const o of outcomes) {
      if (o.status === 'fulfilled' && o.value === undefined) {
        return undefined;
      }
    }

    return false;
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
    const concurrency = this.#bulkConcurrency;
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
