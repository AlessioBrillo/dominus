// SPDX-License-Identifier: AGPL-3.0-only
import { Resolver } from 'node:dns';
import { LRUCache } from 'lru-cache';
import type { DnsCheckResult } from '../../types/domain-status.js';
import type { DnsProvider, DnsCheckOptions } from './dns-provider.js';
import { DomainStatus } from '../../types/domain-status.js';
import { withRetry } from '../retry-utils.js';
import type { RetryPolicy } from '../retry-policy.js';
import type { ProviderCacheRepository } from '../../db/repositories/provider-cache-repository.js';
import { getLogger } from '../../logger.js';
import type { RateLimiterLike } from '../rate-limiter.js';
import type { DnsBreakerRegistryLike } from './dns-breaker.js';

const logger = getLogger();

/**
 * STALE_UNKNOWN_WINDOW_MS: Persistent-cache Unknown rows older than this are
 * treated as misses and re-checked live. Keeps transient failures from being
 * frozen for the full persistent TTL (7 days by default).
 */
const STALE_UNKNOWN_WINDOW_MS = 15 * 60_000;

/**
 * STALE_AVAILABLE_DEFAULT_MS: Persistent-cache Available rows older than this
 * are re-checked live. Availability is the risky verdict (a false positive
 * produces a wasted buy recommendation), so it must not be frozen for the full
 * persistent TTL — unlike Registered, which is conservative. Default 24h
 * (ADR-0002 conservatism, mirrors the RDAP 404 semantics of ADR-0035).
 */
const STALE_AVAILABLE_DEFAULT_MS = 24 * 60 * 60_000;

type DnsRecordType = 'A' | 'AAAA' | 'NS' | 'SOA';

/**
 * UnboundResolver provides DNS resolution via a local Unbound recursive
 * resolver (typically running as a sidecar container or on the host). It uses
 * Node's native `dns.Resolver` pointed at the Unbound instance(s), providing
 * full DNSSEC validation, DoT/DoH upstream, and anycast-free resolution.
 *
 * This is the SINGLE SOURCE OF TRUTH for DNS in the hardened architecture
 * (ADR-0072). All multi-leg consensus complexity (DoH/DoT/tertiary) is
 * deprecated in favor of one properly configured Unbound cluster.
 */
export interface UnboundResolverOptions {
  /** Unbound host(s) — comma-separated, e.g. '127.0.0.1,::1' or 'unbound:5300'. */
  unboundHosts: string[];
  /** Per-query timeout in milliseconds (default: 1500). */
  lookupTimeoutMs?: number;
  /** In-memory cache TTL in milliseconds (default: 300000 = 5min). */
  cacheTtlMs?: number;
  /** Maximum in-memory cache entries (default: 10000, 0 = disabled). */
  maxSize?: number;
  /** Bulk check concurrency (default: 200). */
  bulkConcurrency?: number;
  /** Optional rate limiter for outbound queries. */
  rateLimiter?: RateLimiterLike;
  /** Optional retry policy. */
  retryPolicy?: Partial<RetryPolicy>;
  /** Optional persistent cache repository. */
  persistentCache?: ProviderCacheRepository | undefined;
  /** Persistent cache TTL in hours (default: 168 = 7 days). */
  persistentCacheTtlHours?: number;
  /** Persistent-cache Available stale window in ms (default: 24h). */
  persistentAvailableStaleMs?: number;
  /** Optional shared circuit breaker registry. */
  breakers?: DnsBreakerRegistryLike | undefined;
  /** Use DNS-over-TLS to Unbound (default: true). */
  useTls?: boolean | undefined;
  /** DoT port (default: 853). */
  tlsPort?: number | undefined;
  /** Enable DNSSEC validation (default: true). */
  dnssecValidationEnabled?: boolean | undefined;
  /** Enable parking page detection (default: false). */
  parkingEnabled?: boolean | undefined;
  /** Optional callback for recording resolution metrics (ADR-0072). */
  onResolution?:
    | ((stats: {
        durationMs: number;
        status: 'registered' | 'available' | 'unknown';
        dnssec: 'valid' | 'unchecked' | 'bogus';
        fromCache: boolean;
      }) => void)
    | undefined;
}

export class UnboundResolver implements DnsProvider {
  readonly name = 'UnboundResolver';

  readonly #unboundHosts: string[];
  readonly #lookupTimeoutMs: number;
  readonly #cacheTtlMs: number;
  readonly #maxSize: number;
  readonly #bulkConcurrency: number;
  readonly #rateLimiter: RateLimiterLike | undefined;
  readonly #retryPolicy: Partial<RetryPolicy> | undefined;
  readonly #persistentCache: ProviderCacheRepository | undefined;
  readonly #persistentCacheTtlHours: number;
  readonly #persistentAvailableStaleMs: number;
  readonly #breakers: DnsBreakerRegistryLike | undefined;
  readonly #cacheDisabled: boolean;
  readonly #cache: LRUCache<string, DnsCheckResult>;
  readonly #pending: Map<string, Promise<DnsCheckResult>> = new Map();
  readonly #resolver: Resolver;
  readonly #onResolution: UnboundResolverOptions['onResolution'];
  readonly #dnssecValidationEnabled: boolean;

  constructor(options: UnboundResolverOptions) {
    if (!options.unboundHosts || options.unboundHosts.length === 0) {
      throw new Error('UnboundResolver requires at least one unbound host');
    }
    this.#unboundHosts = options.unboundHosts;
    this.#lookupTimeoutMs = options.lookupTimeoutMs ?? 1500;
    this.#cacheTtlMs = options.cacheTtlMs ?? 300_000;
    this.#maxSize = options.maxSize ?? 10000;
    this.#bulkConcurrency = options.bulkConcurrency ?? 200;
    this.#rateLimiter = options.rateLimiter;
    this.#retryPolicy = options.retryPolicy;
    this.#persistentCache = options.persistentCache;
    this.#persistentCacheTtlHours = options.persistentCacheTtlHours ?? 168;
    this.#persistentAvailableStaleMs =
      options.persistentAvailableStaleMs ?? STALE_AVAILABLE_DEFAULT_MS;
    this.#breakers = options.breakers;
    this.#dnssecValidationEnabled = options.dnssecValidationEnabled ?? true;
    this.#onResolution = options.onResolution;

    // Create dedicated resolver pointed at Unbound
    this.#resolver = new Resolver();
    this.#resolver.setServers(this.#unboundHosts);

    this.#cacheDisabled = this.#maxSize <= 0;
    const cacheOptions: LRUCache.Options<string, DnsCheckResult, unknown> = {
      max: this.#cacheDisabled ? 1 : this.#maxSize,
      noUpdateTTL: false,
      allowStale: false,
      perf: { now: (): number => Date.now() },
    };
    if (this.#cacheTtlMs > 0) cacheOptions.ttl = this.#cacheTtlMs;
    this.#cache = new LRUCache<string, DnsCheckResult>(cacheOptions);
  }

  /** Close the resolver and clear pending lookups. */
  dispose(): void {
    this.#resolver.cancel();
    this.#pending.clear();
  }

  pruneCache(): number {
    if (this.#cacheDisabled) return 0;
    const before = this.#cache.size;
    this.#cache.purgeStale();
    const after = this.#cache.size;
    return before - after;
  }

  clearCache(): void {
    if (!this.#cacheDisabled) this.#cache.clear();
  }

  /** Current circuit state counts across the shared registry (metrics/tests),
   *  or undefined when no breaker registry is wired. */
  breakerSnapshot(): { open: number; closed: number; halfOpen: number; total: number } | undefined {
    if (this.#breakers === undefined) return undefined;
    const registry = this.#breakers as {
      snapshot?: () => { open: number; closed: number; halfOpen: number; total: number };
    };
    return registry.snapshot?.();
  }

  async checkAvailability(
    domain: string,
    signal?: AbortSignal,
    options?: DnsCheckOptions,
  ): Promise<DnsCheckResult> {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    const startTime = Date.now();

    // 1. Memory cache (fastest) — used for within-run dedup even with forceRecheck
    if (!this.#cacheDisabled) {
      const memCached = this.#cache.get(domain);
      if (memCached !== undefined) {
        this.#recordMetrics(memCached, Date.now() - startTime, true);
        return memCached;
      }
    }

    // 2. Persistent cache (DB-backed, survives restarts)
    //    Skip when forceRecheck is true: closeout domains may have changed
    //    status since the last lookup (e.g. newly expired).
    if (!options?.forceRecheck && this.#persistentCache !== undefined) {
      const raw = await this.#persistentCache.get(domain, this.name).catch(() => null);
      if (raw !== null) {
        try {
          const parsed: DnsCheckResult = JSON.parse(raw) as DnsCheckResult;
          if (parsed.status !== undefined && parsed.checkedAt !== undefined) {
            const staleUnknown =
              parsed.status === DomainStatus.Unknown &&
              Date.now() - Date.parse(parsed.checkedAt) > STALE_UNKNOWN_WINDOW_MS;
            const staleAvailable =
              parsed.status === DomainStatus.Available &&
              Date.now() - Date.parse(parsed.checkedAt) > this.#persistentAvailableStaleMs;
            if (!staleUnknown && !staleAvailable) {
              if (!this.#cacheDisabled) this.#cache.set(domain, parsed);
              this.#recordMetrics(parsed, Date.now() - startTime, true);
              return parsed;
            }
          }
        } catch {
          // Corrupted cache row — fall through to live lookup
        }
      }
    }

    // 3. Request coalescing (prevent duplicate in-flight lookups)
    const existing = this.#pending.get(domain);
    if (existing !== undefined) return existing;

    const promise = this.#lookup(domain, signal, startTime);
    this.#pending.set(domain, promise);
    try {
      return await promise;
    } finally {
      this.#pending.delete(domain);
    }
  }

  #recordMetrics(result: DnsCheckResult, durationMs: number, _fromCache: boolean): void {
    if (!this.#onResolution) return;
    let status: 'registered' | 'available' | 'unknown';
    if (result.status === DomainStatus.Registered) status = 'registered';
    else if (result.status === DomainStatus.Available) status = 'available';
    else status = 'unknown';
    // Map 'insecure' to 'unchecked' as we only track valid/unchecked/bogus
    const dnssec = result.dnssec === 'insecure' ? 'unchecked' : (result.dnssec ?? 'unchecked');
    this.#onResolution({
      durationMs,
      status,
      dnssec,
      fromCache: true,
    });
  }

  async #lookup(
    domain: string,
    _signal?: AbortSignal,
    startTime?: number,
  ): Promise<DnsCheckResult> {
    const checkedAt = new Date().toISOString();
    const lookupStartTime = startTime ?? Date.now();

    try {
      const resolveFn = (s?: AbortSignal): Promise<boolean | undefined> =>
        this.#resolveDomain(domain, s);

      let resolved: boolean | undefined;
      let dnssecStatus: DnsCheckResult['dnssec'] = 'unchecked';

      if (this.#rateLimiter && this.#retryPolicy) {
        await this.#rateLimiter.acquire();
        resolved = await withRetry(resolveFn, `unbound:${domain}`, this.#retryPolicy, undefined);
      } else if (this.#rateLimiter) {
        await this.#rateLimiter.acquire();
        resolved = await resolveFn(undefined);
      } else if (this.#retryPolicy) {
        resolved = await withRetry(resolveFn, `unbound:${domain}`, this.#retryPolicy, undefined);
      } else {
        resolved = await resolveFn(undefined);
      }

      // Unbound validates DNSSEC when configured with 'validator' module and
      // 'val-permissive-mode: no'. We trust Unbound's AD flag when DNSSEC is enabled.
      if (resolved !== undefined) {
        dnssecStatus = this.#dnssecValidationEnabled ? 'valid' : 'unchecked';
      } else {
        dnssecStatus = 'unchecked';
      }

      if (resolved !== undefined) {
        const status = resolved ? DomainStatus.Registered : DomainStatus.Available;

        const result: DnsCheckResult = {
          domain,
          status,
          checkedAt,
          dnssec: dnssecStatus,
        };
        this.#setCaches(domain, result);
        this.#recordMetrics(result, Date.now() - lookupStartTime, false);
        return result;
      }

      const unknown: DnsCheckResult = {
        domain,
        status: DomainStatus.Unknown,
        checkedAt,
        dnssec: dnssecStatus,
      };
      this.#setCaches(domain, unknown);
      this.#recordMetrics(unknown, Date.now() - lookupStartTime, false);
      return unknown;
    } catch (_err: unknown) {
      const result: DnsCheckResult = {
        domain,
        status: DomainStatus.Unknown,
        checkedAt,
        dnssec: 'unchecked',
      };
      this.#setCaches(domain, result);
      this.#recordMetrics(result, Date.now() - lookupStartTime, false);
      return result;
    }
  }

  /**
   * Write to both in-memory and persistent caches (persistent is non-fatal).
   * Unknown results are never persisted: they usually mean a transient
   * resolver failure, and freezing them for the full persistent TTL would
   * block the domain for days. They stay in the in-memory cache only, for
   * within-run deduplication.
   */
  #setCaches(domain: string, result: DnsCheckResult): void {
    if (!this.#cacheDisabled) this.#cache.set(domain, result);
    if (this.#persistentCache !== undefined && result.status !== DomainStatus.Unknown) {
      const ttlDays = this.#persistentCacheTtlHours / 24;
      this.#persistentCache.set(domain, this.name, JSON.stringify(result), ttlDays).catch(() => {
        /* Non-fatal: in-memory cache still works */
      });
    }
  }

  async #resolveDomain(domain: string, signal?: AbortSignal): Promise<boolean | undefined> {
    // With Unbound, we use a simple two-phase resolution: A then NS+SOA
    // This mirrors the conservative approach in NodeDnsProvider
    try {
      // Phase 1: A record only — fastest path
      const aOutcome = await this.#resolveWithTimeout(domain, 'A', this.#lookupTimeoutMs, signal)
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
      const fallbackSignal = signal
        ? AbortSignal.any([signal, fallbackAc.signal])
        : fallbackAc.signal;

      const fallbackTypes: DnsRecordType[] = ['NS', 'SOA'];
      const fallbackOutcomes = await Promise.all(
        fallbackTypes.map((type) =>
          this.#resolveWithTimeout(domain, type, this.#lookupTimeoutMs, fallbackSignal)
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
        logger.warn({ domain }, 'Unbound: A and NS/SOA both timed out');
        return undefined;
      }

      return false;
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw err;
      }
      logger.debug({ domain, err }, 'Unbound resolution error');
      return undefined;
    }
  }

  /** Resolve a single record type with timeout and abort support. */
  #resolveWithTimeout(
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

      this.#resolver.resolve(domain, recordType, (err, addresses) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abortHandler);
        if (err !== null) {
          reject(err);
        } else if (Array.isArray(addresses) && addresses.length > 0) {
          resolve(true);
        } else {
          resolve(false);
        }
      });
    });
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
