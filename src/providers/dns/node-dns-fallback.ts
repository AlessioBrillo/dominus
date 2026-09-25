// SPDX-License-Identifier: AGPL-3.0-only
import { Resolver as NodeResolver } from 'node:dns';
import { LRUCache } from 'lru-cache';
import type { DnsCheckResult } from '../../types/domain-status.js';
import type { DnsProvider, DnsCheckOptions } from './dns-provider.js';
import { DomainStatus } from '../../types/domain-status.js';
import { getLogger } from '../../logger.js';
import type { ProviderCacheRepository } from '../../db/repositories/provider-cache-repository.js';
import type { RateLimiterLike } from '../rate-limiter.js';
import type { RetryPolicy } from '../retry-policy.js';
import { withRetry } from '../retry-utils.js';

const logger = getLogger();

const STALE_UNKNOWN_WINDOW_MS = 15 * 60_000;
const STALE_AVAILABLE_DEFAULT_MS = 24 * 60 * 60_000;

type DnsRecordType = 'A' | 'AAAA' | 'NS' | 'SOA';

export interface NodeDnsFallbackOptions {
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
  /** Optional callback for recording resolution metrics. */
  onResolution?:
    | ((stats: {
        durationMs: number;
        status: 'registered' | 'available' | 'unknown';
        dnssec: 'valid' | 'unchecked' | 'bogus';
        fromCache: boolean;
      }) => void)
    | undefined;
  /** Parking detection enabled (accepted for API compatibility, not implemented in fallback). */
  parkingEnabled?: boolean;
  /** Parking IP registry (accepted for API compatibility, not implemented in fallback). */
  parkingRegistry?: unknown;
  /** Test-only: inject a mock resolver for testing. */
  testResolver?: NodeResolver;
}

export class NodeDnsFallback implements DnsProvider {
  readonly name = 'NodeDnsFallback';

  readonly #lookupTimeoutMs: number;
  readonly #cacheTtlMs: number;
  readonly #maxSize: number;
  readonly #bulkConcurrency: number;
  readonly #rateLimiter: RateLimiterLike | undefined;
  readonly #retryPolicy: Partial<RetryPolicy> | undefined;
  readonly #persistentCache: ProviderCacheRepository | undefined;
  readonly #persistentCacheTtlHours: number;
  readonly #persistentAvailableStaleMs: number;
  readonly #cacheDisabled: boolean;
  readonly #cache: LRUCache<string, DnsCheckResult>;
  readonly #pending: Map<string, Promise<DnsCheckResult>> = new Map();
  readonly #resolver: NodeResolver;
  readonly #onResolution: NodeDnsFallbackOptions['onResolution'];

  constructor(options: NodeDnsFallbackOptions = {}) {
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
    this.#onResolution = options.onResolution;

    this.#resolver = options.testResolver ?? new NodeResolver();

    this.#cacheDisabled = this.#maxSize <= 0;
    const cacheOptions: LRUCache.Options<string, DnsCheckResult, unknown> = {
      max: this.#cacheDisabled ? 1 : this.#maxSize,
      noUpdateTTL: false,
      allowStale: false,
      perf: { now: (): number => Date.now() },
    };
    if (this.#cacheTtlMs > 0) cacheOptions.ttl = this.#cacheTtlMs;
    this.#cache = new LRUCache<string, DnsCheckResult>(cacheOptions);

    logger.warn(
      'NodeDnsFallback active — DNSSEC validation DISABLED. This is a fallback mode for community onboarding only. Production MUST use UnboundResolver with DNS_UNBOUND_STRICT=true.',
    );
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

  dispose(): void {
    this.#pending.clear();
    this.#resolver.cancel();
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
        const durationMs = Date.now() - startTime;
        this.#recordMetrics(memCached, durationMs, true);
        return { ...memCached, durationMs, fromCache: true };
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
              const durationMs = Date.now() - startTime;
              this.#recordMetrics(parsed, durationMs, true);
              return { ...parsed, durationMs, fromCache: true };
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

  #recordMetrics(result: DnsCheckResult, durationMs: number, fromCache: boolean): void {
    if (!this.#onResolution) return;
    let status: 'registered' | 'available' | 'unknown';
    if (result.status === DomainStatus.Registered) status = 'registered';
    else if (result.status === DomainStatus.Available) status = 'available';
    else status = 'unknown';
    const dnssec = result.dnssec === 'insecure' ? 'unchecked' : (result.dnssec ?? 'unchecked');
    this.#onResolution({
      durationMs,
      status,
      dnssec,
      fromCache,
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
      const resolveFn = (): Promise<boolean | undefined> => this.#resolveDomain(domain);

      let resolved: boolean | undefined;

      if (this.#rateLimiter && this.#retryPolicy) {
        await this.#rateLimiter.acquire();
        resolved = await withRetry(resolveFn, `node-dns:${domain}`, this.#retryPolicy, undefined);
      } else if (this.#rateLimiter) {
        await this.#rateLimiter.acquire();
        resolved = await resolveFn();
      } else if (this.#retryPolicy) {
        resolved = await withRetry(resolveFn, `node-dns:${domain}`, this.#retryPolicy, undefined);
      } else {
        resolved = await resolveFn();
      }

      // NodeDnsFallback does NOT perform DNSSEC validation.
      // All results are stamped with 'unchecked' DNSSEC status.
      const dnssecStatus: DnsCheckResult['dnssec'] = 'unchecked';

      if (resolved !== undefined) {
        const status = resolved ? DomainStatus.Registered : DomainStatus.Available;

        const result: DnsCheckResult = {
          domain,
          status,
          checkedAt,
          dnssec: dnssecStatus,
        };
        this.#setCaches(domain, result);
        const durationMs = Date.now() - lookupStartTime;
        this.#recordMetrics(result, durationMs, false);
        return { ...result, durationMs, fromCache: false };
      }

      const unknown: DnsCheckResult = {
        domain,
        status: DomainStatus.Unknown,
        checkedAt,
        dnssec: dnssecStatus,
      };
      this.#setCaches(domain, unknown);
      const unknownDurationMs = Date.now() - lookupStartTime;
      this.#recordMetrics(unknown, unknownDurationMs, false);
      return { ...unknown, durationMs: unknownDurationMs, fromCache: false };
    } catch (_err) {
      const result: DnsCheckResult = {
        domain,
        status: DomainStatus.Unknown,
        checkedAt,
        dnssec: 'unchecked',
      };
      this.#setCaches(domain, result);
      const durationMs = Date.now() - lookupStartTime;
      this.#recordMetrics(result, durationMs, false);
      return { ...result, durationMs, fromCache: false };
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

  async #resolveDomain(domain: string): Promise<boolean | undefined> {
    // Two-phase resolution: A then NS+SOA
    // Mirrors the conservative approach in UnboundResolver
    try {
      // Phase 1: A record only — fastest path
      const aOutcome = await this.#resolveWithTimeout(domain, 'A', this.#lookupTimeoutMs)
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
      const fallbackSignal = AbortSignal.any([fallbackAc.signal]);

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
        logger.warn({ domain }, 'NodeDnsFallback: A and NS/SOA both timed out');
        return undefined;
      }

      return false;
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw err;
      }
      logger.debug({ domain, err }, 'NodeDnsFallback resolution error');
      return undefined;
    }
  }

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
