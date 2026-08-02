// SPDX-License-Identifier: AGPL-3.0-only
import { promises as dnsPromises, Resolver } from 'node:dns';
import { LRUCache } from 'lru-cache';
import { DomainStatus } from '../../types/domain-status.js';
import type { DnsCheckResult } from '../../types/domain-status.js';
import type { DnsProvider, DnsCheckOptions, DnsResolverGroup } from './dns-provider.js';
import { strategyToResolverGroups } from './dns-provider.js';
import { DotPool } from './dot-pool.js';
import { ParkingIpRegistry } from './parking-ip-registry.js';
import { withRetry } from '../retryable-provider.js';
import type { RetryPolicy } from '../retry-policy.js';
import type { ProviderCacheRepository } from '../../db/repositories/provider-cache-repository.js';
import { getLogger } from '../../logger.js';
import type { RateLimiterLike } from '../rate-limiter.js';

export { buildDnsQuery, validateDnsResponse } from './dot-pool.js';

const logger = getLogger();

type DnsRecordType = 'A' | 'AAAA' | 'NS' | 'SOA';

export type DnsLookupStrategy =
  | 'native'
  | 'native-with-doh-fallback'
  | 'doh-only'
  | 'doh-primary'
  | 'dot-only'
  | 'dot-with-doh-fallback'
  | 'multi-doh-plus-native';

function resolveWithTimeout(
  domain: string,
  recordType: DnsRecordType,
  timeoutMs: number,
  signal?: AbortSignal,
  resolver?: Resolver,
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

    const doLookup = (): Promise<string[]> => {
      if (resolver !== undefined) {
        return new Promise<string[]>((resolveLookup, rejectLookup) => {
          resolver.resolve(domain, recordType, (err, addresses) => {
            if (err !== null) {
              rejectLookup(err);
            } else if (Array.isArray(addresses)) {
              resolveLookup(addresses as string[]);
            } else {
              resolveLookup([]);
            }
          });
        });
      }
      return dnsPromises.resolve(domain, recordType) as Promise<string[]>;
    };

    doLookup()
      .then(() => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abortHandler);
        resolve(true);
      })
      .catch((err: unknown) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abortHandler);
        reject(err);
      });
  });
}

function resolveWithResolver(
  domain: string,
  rrtype: string,
  resolver: Resolver,
): Promise<string[]> {
  return new Promise<string[]>((resolve, reject) => {
    resolver.resolve(domain, rrtype, (err, addresses) => {
      if (err !== null) {
        reject(err);
      } else if (Array.isArray(addresses)) {
        resolve(addresses as string[]);
      } else {
        resolve([]);
      }
    });
  });
}

/** Resolve A and AAAA records for IP-based parking detection. */
async function resolveAddressRecords(domain: string, resolver?: Resolver): Promise<string[]> {
  const resolveA =
    resolver !== undefined
      ? resolveWithResolver(domain, 'A', resolver)
      : dnsPromises.resolve(domain, 'A');
  const resolveAAAA =
    resolver !== undefined
      ? resolveWithResolver(domain, 'AAAA', resolver)
      : dnsPromises.resolve(domain, 'AAAA');
  const [v4, v6] = await Promise.all([
    resolveA.catch(() => [] as string[]),
    resolveAAAA.catch(() => [] as string[]),
  ]);
  return [...v4, ...v6];
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

async function resolvesAnyNative(
  domain: string,
  timeout: number,
  signal?: AbortSignal,
  resolver?: Resolver,
): Promise<boolean | undefined> {
  // Phase 1: A record only — fastest path
  const aOutcome = await resolveWithTimeout(domain, 'A', timeout, signal, resolver)
    .then(() => true as const)
    .catch((err: unknown) => {
      const e = err as { code?: string; name?: string };
      if (e.name === 'AbortError') return 'aborted' as const;
      if (e.code === 'ENOTFOUND' || e.code === 'ENODATA') return 'nxdomain' as const;
      if (e.code === 'ETIMEOUT' || e.code === 'ESOCKETTIMEOUT') return 'timeout' as const;
      return 'error' as const;
    });

  if (aOutcome === true) return true;
  if (aOutcome === 'aborted') return undefined;

  // Phase 2: NS + SOA in parallel — catch domains registered without A records
  const fallbackAc = new AbortController();
  const fallbackSignal = signal ? AbortSignal.any([signal, fallbackAc.signal]) : fallbackAc.signal;

  const fallbackTypes: DnsRecordType[] = ['NS', 'SOA'];
  const fallbackOutcomes = await Promise.all(
    fallbackTypes.map((type) =>
      resolveWithTimeout(domain, type, timeout, fallbackSignal, resolver)
        .then(() => {
          fallbackAc.abort();
          return {
            resolved: true as const,
            code: undefined as string | undefined,
            aborted: false as const,
          };
        })
        .catch((err: unknown) => {
          const e = err as { code?: string; name?: string };
          return {
            resolved: false as const,
            code: e.code,
            aborted: e.name === ('AbortError' as const),
          };
        }),
    ),
  );

  for (const o of fallbackOutcomes) {
    if (o.resolved) return true;
  }

  let anyTimeout = false;
  for (const o of fallbackOutcomes) {
    if (o.aborted) continue;
    const c = o.code;
    if (c === 'ETIMEOUT' || c === 'ESOCKETTIMEOUT') {
      anyTimeout = true;
    } else if (c !== 'ENOTFOUND' && c !== 'ENODATA' && c !== undefined) {
      return undefined;
    }
  }

  if (anyTimeout) {
    logger.warn({ domain }, 'DNS: A and NS/SOA both timed out');
    return undefined;
  }

  return false;
}

/**
 * Two-phase DNS-over-HTTPS resolution — same A→NS+SOA strategy as native.
 * Uses shared HTTPS agent with keepalive for connection reuse across queries.
 */
async function resolvesAnyDoh(
  domain: string,
  endpoint: string,
  timeout: number,
  signal?: AbortSignal,
): Promise<boolean | undefined> {
  // Phase 1: A record only
  const aTimeoutSignal = AbortSignal.timeout(timeout);
  const aCombined = signal ? AbortSignal.any([signal, aTimeoutSignal]) : aTimeoutSignal;
  const aOutcome = await resolveDoh(domain, 'A', endpoint, aCombined)
    .then(() => true as const)
    .catch((err: unknown) => {
      const e = err as { code?: string; name?: string };
      if (e.name === 'AbortError') return 'aborted' as const;
      if (e.code === 'ENOTFOUND' || e.code === 'ENODATA') return 'nxdomain' as const;
      return 'error' as const;
    });

  if (aOutcome === true) return true;
  if (aOutcome === 'aborted') return undefined;

  // Phase 2: NS + SOA in parallel
  const fallbackAc = new AbortController();
  const fallbackSignal = signal ? AbortSignal.any([signal, fallbackAc.signal]) : fallbackAc.signal;

  const fallbackTypes = ['NS', 'SOA'];
  const fallbackOutcomes = await Promise.all(
    fallbackTypes.map((type) => {
      const typeTimeout = AbortSignal.timeout(timeout);
      const merged = AbortSignal.any([fallbackSignal, typeTimeout]);
      return resolveDoh(domain, type, endpoint, merged)
        .then(() => {
          fallbackAc.abort();
          return {
            resolved: true as const,
            code: undefined as string | undefined,
            aborted: false as const,
          };
        })
        .catch((err: unknown) => {
          const e = err as { code?: string; name?: string };
          return {
            resolved: false as const,
            code: e.code,
            aborted: e.name === ('AbortError' as const),
          };
        });
    }),
  );

  for (const o of fallbackOutcomes) {
    if (o.resolved) return true;
  }

  const anyUnknown = fallbackOutcomes.some(
    (o) =>
      !o.resolved &&
      !o.aborted &&
      (o.code === undefined || (o.code !== 'ENOTFOUND' && o.code !== 'ENODATA')),
  );
  if (anyUnknown) return undefined;
  return false;
}

/**
 * Two-phase DNS-over-TLS resolution — same A→NS+SOA strategy.
 */
async function resolvesAnyDot(
  domain: string,
  pool: DotPool,
  timeout: number,
  signal?: AbortSignal,
): Promise<boolean | undefined> {
  // Phase 1: A record only
  const aOutcome = await pool
    .query(domain, 'A', timeout, signal)
    .then(() => true as const)
    .catch((err: unknown) => {
      const e = err as { code?: string; name?: string };
      if (e.name === 'AbortError') return 'aborted' as const;
      if (e.code === 'ENOTFOUND' || e.code === 'ENODATA') return 'nxdomain' as const;
      return 'error' as const;
    });

  if (aOutcome === true) return true;
  if (aOutcome === 'aborted') return undefined;

  // Phase 2: NS + SOA in parallel
  const fallbackAc = new AbortController();
  const fallbackSignal = signal ? AbortSignal.any([signal, fallbackAc.signal]) : fallbackAc.signal;

  const fallbackTypes = ['NS', 'SOA'];
  const fallbackOutcomes = await Promise.all(
    fallbackTypes.map((type) => {
      const typeTimeout = AbortSignal.timeout(timeout);
      const merged = AbortSignal.any([fallbackSignal, typeTimeout]);
      return pool
        .query(domain, type, timeout, merged)
        .then(() => {
          fallbackAc.abort();
          return {
            resolved: true as const,
            code: undefined as string | undefined,
            aborted: false as const,
          };
        })
        .catch((err: unknown) => {
          const e = err as { code?: string; name?: string };
          return {
            resolved: false as const,
            code: e.code,
            aborted: e.name === ('AbortError' as const),
          };
        });
    }),
  );

  for (const o of fallbackOutcomes) {
    if (o.resolved) return true;
  }

  const anyUnknown = fallbackOutcomes.some(
    (o) =>
      !o.resolved &&
      !o.aborted &&
      (o.code === undefined || (o.code !== 'ENOTFOUND' && o.code !== 'ENODATA')),
  );
  if (anyUnknown) return undefined;
  return false;
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
  readonly #rateLimiter: RateLimiterLike | undefined;
  readonly #retryPolicy: Partial<RetryPolicy> | undefined;
  readonly #persistentCache: ProviderCacheRepository | undefined;
  readonly #persistentCacheTtlHours: number;
  readonly #nameservers: string[] | undefined;
  readonly #useDedicatedResolver: boolean;
  readonly #cache: LRUCache<string, DnsCheckResult>;
  /** Pending in-flight lookups keyed by domain to prevent cache stampede. */
  readonly #pending: Map<string, Promise<DnsCheckResult>> = new Map();
  /** RFC 7766 DoT connection pools, keyed by endpoint|servername|port. */
  readonly #dotPools: Map<string, DotPool> = new Map();
  /** Native resolvers cached per nameserver set — reused across lookups. */
  readonly #nativeResolvers: Map<string, Resolver> = new Map();

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
    rateLimiter?: RateLimiterLike | undefined;
    retryPolicy?: Partial<RetryPolicy> | undefined;
    persistentCache?: ProviderCacheRepository | undefined;
    persistentCacheTtlHours?: number;
    nameservers?: string[];
    useDedicatedResolver?: boolean;
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
    this.#persistentCache = options?.persistentCache;
    this.#persistentCacheTtlHours = options?.persistentCacheTtlHours ?? 168;
    this.#nameservers = options?.nameservers;
    this.#useDedicatedResolver = options?.useDedicatedResolver ?? true;
    this.#resolverGroups =
      options?.resolverGroups ??
      strategyToResolverGroups(options?.lookupStrategy ?? 'native', this.#dohEndpoint);

    const ttlMs = this.#cacheTtlMs > 0 ? this.#cacheTtlMs : 300_000;
    this.#cache = new LRUCache<string, DnsCheckResult>({
      max: this.#maxSize > 0 ? this.#maxSize : 10_000,
      ttl: ttlMs,
      noUpdateTTL: false,
      allowStale: false,
      perf: { now: (): number => Date.now() },
    });
  }

  #getResolver(): Resolver | undefined {
    if (!this.#useDedicatedResolver) return undefined;
    const hasCustomServers = this.#nameservers !== undefined && this.#nameservers.length > 0;
    if (!hasCustomServers) return undefined;
    return this.#cachedResolver(this.#nameservers!);
  }

  /** Get (or create) a Resolver for a nameserver set, cached per set. */
  #cachedResolver(nameservers: string[]): Resolver {
    const key = nameservers.join(',');
    let resolver = this.#nativeResolvers.get(key);
    if (resolver === undefined) {
      resolver = new Resolver();
      resolver.setServers(nameservers);
      this.#nativeResolvers.set(key, resolver);
    }
    return resolver;
  }

  /** Get (or create) the shared DoT connection pool for an endpoint. */
  #getDotPool(endpoint: string, servername?: string, port?: number): DotPool {
    const key = `${endpoint}|${servername ?? ''}|${port ?? 853}`;
    let pool = this.#dotPools.get(key);
    if (pool === undefined) {
      pool = new DotPool({
        endpoint,
        ...(servername !== undefined ? { servername } : {}),
        ...(port !== undefined ? { port } : {}),
      });
      this.#dotPools.set(key, pool);
    }
    return pool;
  }

  pruneCache(): number {
    const before = this.#cache.size;
    this.#cache.purgeStale();
    const after = this.#cache.size;
    return before - after;
  }

  clearCache(): void {
    this.#cache.clear();
  }

  async checkAvailability(
    domain: string,
    signal?: AbortSignal,
    options?: DnsCheckOptions,
  ): Promise<DnsCheckResult> {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    // 1. Memory cache (fastest) — used for within-run dedup even with forceRecheck
    const memCached = this.#cache.get(domain);
    if (memCached !== undefined) return memCached;

    // 2. Persistent cache (DB-backed, survives restarts)
    //    Skip when forceRecheck is true: closeout domains may have changed
    //    status since the last lookup (e.g. newly expired).
    if (!options?.forceRecheck && this.#persistentCache !== undefined) {
      const raw = await this.#persistentCache.get(domain, this.name).catch(() => null);
      if (raw !== null) {
        try {
          const parsed: DnsCheckResult = JSON.parse(raw) as DnsCheckResult;
          if (parsed.status !== undefined && parsed.checkedAt !== undefined) {
            this.#cache.set(domain, parsed);
            return parsed;
          }
        } catch {
          // Corrupted cache row — fall through to live lookup
        }
      }
    }

    // 3. Request coalescing (prevent duplicate in-flight lookups)
    const existing = this.#pending.get(domain);
    if (existing !== undefined) return existing;

    const promise = this.#lookup(domain, signal);
    this.#pending.set(domain, promise);
    try {
      return await promise;
    } finally {
      this.#pending.delete(domain);
    }
  }

  async #lookup(domain: string, signal?: AbortSignal): Promise<DnsCheckResult> {
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
          const addresses = await resolveAddressRecords(domain, this.#getResolver());
          const parkingCheck = this.#parkingRegistry.checkIps(addresses);
          isParked = parkingCheck.parked || undefined;
          parkingRegistrar = parkingCheck.registrar;
        }

        const result: DnsCheckResult = { domain, status, checkedAt, isParked, parkingRegistrar };
        this.#setCaches(domain, result);
        return result;
      }

      const unknown: DnsCheckResult = { domain, status: DomainStatus.Unknown, checkedAt };
      this.#setCaches(domain, unknown);
      return unknown;
    } catch (err: unknown) {
      const code = (err as { code?: string }).code;
      if (code === 'ENOTFOUND' || code === 'ENODATA') {
        const result: DnsCheckResult = { domain, status: DomainStatus.Available, checkedAt };
        this.#setCaches(domain, result);
        return result;
      }
      const unknown: DnsCheckResult = { domain, status: DomainStatus.Unknown, checkedAt };
      this.#setCaches(domain, unknown);
      return unknown;
    }
  }

  /** Write to both in-memory and persistent caches (persistent is non-fatal). */
  #setCaches(domain: string, result: DnsCheckResult): void {
    this.#cache.set(domain, result);
    if (this.#persistentCache !== undefined) {
      const ttlDays = this.#persistentCacheTtlHours / 24;
      this.#persistentCache.set(domain, this.name, JSON.stringify(result), ttlDays).catch(() => {
        /* Non-fatal: in-memory cache still works */
      });
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
        const groupResolver =
          spec.nameservers !== undefined
            ? this.#cachedResolver(spec.nameservers)
            : this.#getResolver();
        return resolvesAnyNative(domain, timeout, combinedSignal, groupResolver);
      }
      if (spec.type === 'dot') {
        return resolvesAnyDot(
          domain,
          this.#getDotPool(spec.endpoint ?? this.#dohEndpoint, spec.servername, spec.port),
          timeout,
          combinedSignal,
        );
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

    // A lookup that produced no opinion (timeout, network error, or a
    // rejected task) must not be outvoted by a definitive NXDOMAIN from
    // another resolver in the group. One resolver's failure to confirm
    // availability means the domain must not be reported Available —
    // unknown wins over available (ADR-0002 conservatism).
    for (const o of outcomes) {
      if (o.status === 'rejected' || (o.status === 'fulfilled' && o.value === undefined)) {
        return undefined;
      }
    }

    // Every remaining outcome is a definitive false (NXDOMAIN) — the
    // whole group agrees the domain is available.
    return false;
  }

  async checkBulk(
    domains: string[],
    signal?: AbortSignal,
    options?: DnsCheckOptions,
  ): Promise<DnsCheckResult[]> {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    const results: DnsCheckResult[] = new Array(domains.length);
    let nextIndex = 0;
    let activeWorkers = 0;
    let done = false;

    return new Promise<DnsCheckResult[]>((resolve, reject) => {
      const onAbort = (): void => {
        done = true;
        reject(new DOMException('Aborted', 'AbortError'));
      };
      if (signal !== undefined) {
        signal.addEventListener('abort', onAbort, { once: true });
      }

      const worker = async (): Promise<void> => {
        while (!done) {
          const idx = nextIndex++;
          if (idx >= domains.length) {
            activeWorkers--;
            if (activeWorkers === 0) {
              cleanup();
              resolve(results);
            }
            return;
          }
          try {
            results[idx] = await this.checkAvailability(domains[idx]!, signal, options);
          } catch {
            results[idx] = {
              domain: domains[idx] ?? 'unknown',
              status: DomainStatus.Unknown,
              checkedAt: new Date().toISOString(),
            };
          }
        }
      };

      const cleanup = (): void => {
        if (signal !== undefined) {
          signal.removeEventListener('abort', onAbort);
        }
      };

      // Spawn worker pool — cap by rate limiter burst capacity when configured
      const burstLimit =
        this.#rateLimiter !== undefined && Number.isFinite(this.#rateLimiter.maxTokens)
          ? this.#rateLimiter.maxTokens
          : this.#bulkConcurrency;
      const concurrency = Math.min(this.#bulkConcurrency, burstLimit, domains.length);
      activeWorkers = concurrency > 0 ? concurrency : 1;
      for (let i = 0; i < concurrency; i++) {
        void worker();
      }
    });
  }
}
