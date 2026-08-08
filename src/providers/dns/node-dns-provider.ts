// SPDX-License-Identifier: AGPL-3.0-only
import { promises as dnsPromises, Resolver } from 'node:dns';
import { LRUCache } from 'lru-cache';
import type { Dispatcher } from 'undici';
import { DomainStatus } from '../../types/domain-status.js';
import type { DnsCheckResult } from '../../types/domain-status.js';
import type { DnsProvider, DnsCheckOptions, DnsResolverGroup } from './dns-provider.js';
import { strategyToResolverGroups } from './dns-provider.js';
import { DohAgentPool } from './doh-agents.js';
import {
  DotPool,
  buildDnsQuery,
  classifyResponse,
  recordTypeToQtype,
  validateDnsResponse,
} from './dot-pool.js';
import { ParkingIpRegistry } from './parking-ip-registry.js';
import { withRetry } from '../retryable-provider.js';
import type { RetryPolicy } from '../retry-policy.js';
import type { ProviderCacheRepository } from '../../db/repositories/provider-cache-repository.js';
import { getLogger } from '../../logger.js';
import type { RateLimiterLike } from '../rate-limiter.js';

export { buildDnsQuery, validateDnsResponse } from './dot-pool.js';

const logger = getLogger();

/**
 * Persistent-cache Unknown rows older than this are treated as misses and
 * re-checked live. Keeps transient failures from being frozen for the full
 * persistent TTL (7 days by default).
 */
const STALE_UNKNOWN_WINDOW_MS = 15 * 60_000;

/**
 * Persistent-cache Available rows older than this are re-checked live.
 * Availability is the risky verdict (a false positive produces a wasted buy
 * recommendation), so it must not be frozen for the full persistent TTL —
 * unlike Registered, which is conservative. Default 24h
 * (ADR-0002 conservatism, mirrors the RDAP 404 semantics of ADR-0035).
 */
const STALE_AVAILABLE_DEFAULT_MS = 24 * 60 * 60_000;

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

/** Resolve a single record type with abort support. The Node resolver API
 *  cannot cancel in-flight lookups, so the result races the abort signal. */
function resolveWithAbort(
  domain: string,
  recordType: 'A' | 'AAAA',
  signal: AbortSignal,
  resolver?: Resolver,
): Promise<string[]> {
  return new Promise<string[]>((resolve, reject) => {
    const onAbort = (): void => reject(new DOMException('Aborted', 'AbortError'));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });

    const finish = (err: Error | null, addresses?: string[]): void => {
      signal.removeEventListener('abort', onAbort);
      if (err !== null) {
        reject(err);
      } else {
        resolve(addresses ?? []);
      }
    };

    if (resolver !== undefined) {
      resolver.resolve(domain, recordType, (err, addresses) => {
        if (err !== null) {
          finish(err);
        } else {
          finish(null, addresses as string[]);
        }
      });
    } else {
      dnsPromises.resolve(domain, recordType).then(
        (addresses) => finish(null, addresses as string[]),
        (err: unknown) => finish(err instanceof Error ? err : new Error(String(err))),
      );
    }
  });
}

/** Resolve A and AAAA records for IP-based parking detection, racing the
 *  caller's abort signal and a hard per-query deadline. Either lookup may
 *  fail independently without affecting the other. */
async function resolveAddressRecords(
  domain: string,
  timeoutMs: number,
  signal?: AbortSignal,
  resolver?: Resolver,
): Promise<string[]> {
  const deadline = AbortSignal.timeout(timeoutMs);
  const combined = signal !== undefined ? AbortSignal.any([signal, deadline]) : deadline;

  const [v4, v6] = await Promise.all([
    resolveWithAbort(domain, 'A', combined, resolver).catch(() => [] as string[]),
    resolveWithAbort(domain, 'AAAA', combined, resolver).catch(() => [] as string[]),
  ]);
  return [...v4, ...v6];
}

async function resolveDoh(
  domain: string,
  recordType: string,
  endpoint: string,
  signal?: AbortSignal,
  dispatcher?: Dispatcher,
): Promise<boolean> {
  const url = new URL(endpoint);
  url.searchParams.set('name', domain);
  url.searchParams.set('type', recordType);
  // Google's JSON API rejects the request without the ct= parameter
  // (verified live: dns.google/dns-query returns 400 without it, ADR-0047).
  // Cloudflare accepts and ignores it, so the parameter is unconditional.
  url.searchParams.set('ct', 'application/dns-json');

  const init: {
    headers: Record<string, string>;
    signal?: AbortSignal;
    dispatcher?: unknown;
  } = {
    headers: { accept: 'application/dns-json' },
  };
  if (signal !== undefined) init.signal = signal;
  if (dispatcher !== undefined) init.dispatcher = dispatcher;

  const response = await fetch(url.toString(), init as Parameters<typeof fetch>[1]);

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

  // Any non-zero status other than NXDOMAIN (SERVFAIL, REFUSED, ...) is a
  // resolver-side failure, not a verdict. It must vote neutral: mirrors
  // the DoT classifyResponse semantics (dot-pool.ts) so a broken resolver
  // can never be counted as a definitive "available". Previously Status:2
  // with no Answer fell into the NODATA branch and outvoted resolvers
  // that answered — a false positive.
  if (data.Status !== 0) {
    throw Object.assign(new Error(`DoH RCODE ${data.Status}`), { code: 'ESERVFAIL' });
  }

  if (!data.Answer || data.Answer.length === 0) {
    throw Object.assign(new Error('DoH NODATA'), { code: 'ENODATA' });
  }

  return true;
}

/**
 * RFC 8484 DoH wire-format leg (GET ?dns=<base64url>). Vendors that only
 * speak the wire protocol (Quad9, AdGuard, Mullvad) can never answer the
 * JSON API; every default DoH group carries one wire leg so the majority
 * vote needs three live transports, not two (ADR-0047).
 *
 * Verdict semantics are the conservative DoT ones (see classifyResponse in
 * dot-pool.ts): NXDOMAIN and NODATA are definitive, SERVFAIL/REFUSED are
 * neutral resolver failures, and a response whose query ID does not match
 * the request is dropped as corrupt.
 */
async function resolveDohWire(
  domain: string,
  recordType: string,
  endpoint: string,
  signal?: AbortSignal,
  dispatcher?: Dispatcher,
): Promise<boolean> {
  const query = buildDnsQuery(domain, recordTypeToQtype(recordType));
  const url = new URL(endpoint);
  url.searchParams.set('dns', query.toString('base64url'));

  const init: {
    headers: Record<string, string>;
    signal?: AbortSignal;
    dispatcher?: unknown;
  } = {
    headers: { accept: 'application/dns-message' },
  };
  if (signal !== undefined) init.signal = signal;
  if (dispatcher !== undefined) init.dispatcher = dispatcher;

  const response = await fetch(url.toString(), init as Parameters<typeof fetch>[1]);

  if (!response.ok) {
    throw new Error(`DoH wire query failed: ${response.status}`);
  }

  const body = Buffer.from(await response.arrayBuffer());
  if (!validateDnsResponse(body, query.readUInt16BE(0))) {
    throw Object.assign(new Error('DoH wire response ID mismatch'), { code: 'ESERVFAIL' });
  }

  const outcome = classifyResponse(body);
  if (outcome.kind === 'error') {
    throw Object.assign(new Error(outcome.message), { code: outcome.code });
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
 * Requests ride the provider's shared undici Agent (see DohAgentPool): one
 * keep-alive pool per endpoint origin, so consecutive queries reuse sockets
 * instead of paying a fresh TLS/HTTP handshake each (ADR-0044).
 *
 * `format` selects the request shape: 'json' (Google-style JSON API, the
 * default) or 'wire' (RFC 8484 base64url GET). Vendors without a JSON API
 * ride the wire path (ADR-0047).
 */
async function resolvesAnyDoh(
  domain: string,
  endpoint: string,
  timeout: number,
  signal?: AbortSignal,
  dispatcher?: Dispatcher,
  format: 'json' | 'wire' = 'json',
): Promise<boolean | undefined> {
  const query = (type: string, merged: AbortSignal): Promise<boolean> =>
    format === 'wire'
      ? resolveDohWire(domain, type, endpoint, merged, dispatcher)
      : resolveDoh(domain, type, endpoint, merged, dispatcher);

  // Phase 1: A record only
  const aTimeoutSignal = AbortSignal.timeout(timeout);
  const aCombined = signal ? AbortSignal.any([signal, aTimeoutSignal]) : aTimeoutSignal;
  const aOutcome = await query('A', aCombined)
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
      return query(type, merged)
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
  readonly #persistentAvailableStaleMs: number;
  readonly #nameservers: string[] | undefined;
  readonly #useDedicatedResolver: boolean;
  /** True when maxSize <= 0 — the in-memory cache is fully disabled. */
  readonly #cacheDisabled: boolean;
  readonly #dotPoolMaxQueued: number;
  readonly #cache: LRUCache<string, DnsCheckResult>;
  /** Pending in-flight lookups keyed by domain to prevent cache stampede. */
  readonly #pending: Map<string, Promise<DnsCheckResult>> = new Map();
  /** RFC 7766 DoT connection pools, keyed by endpoint|servername|port. */
  readonly #dotPools: Map<string, DotPool> = new Map();
  /** Native resolvers cached per nameserver set — reused across lookups. */
  readonly #nativeResolvers: Map<string, Resolver> = new Map();
  /** Shared keep-alive dispatchers (undici Agent) for DoH endpoints. */
  readonly #dohAgents: DohAgentPool;

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
    /**
     * Persistent-cache Available rows older than this are re-checked live.
     * Defaults to 24h. A shorter window loses freshness; a longer one risks
     * a false "Available" surviving a recent registration.
     */
    persistentAvailableStaleMs?: number;
    nameservers?: string[];
    useDedicatedResolver?: boolean;
    dotPoolMaxQueued?: number;
    /** Max keep-alive sockets per DoH endpoint origin (DNS_DOH_MAX_CONNECTIONS). */
    dohMaxConnections?: number;
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
    this.#persistentAvailableStaleMs =
      options?.persistentAvailableStaleMs ?? STALE_AVAILABLE_DEFAULT_MS;
    this.#nameservers = options?.nameservers;
    this.#useDedicatedResolver = options?.useDedicatedResolver ?? true;
    this.#dotPoolMaxQueued = options?.dotPoolMaxQueued ?? 4096;
    this.#dohAgents = new DohAgentPool({
      maxConnections: options?.dohMaxConnections ?? 64,
    });
    this.#resolverGroups =
      options?.resolverGroups ??
      strategyToResolverGroups(options?.lookupStrategy ?? 'native', this.#dohEndpoint);

    // maxSize <= 0 disables the in-memory cache entirely (DNS_CACHE_MAX_SIZE=0);
    // cacheTtlMs <= 0 disables TTL expiry, keeping LRU eviction only
    // (DNS_CACHE_TTL_SECONDS=0). Previously both were silently mapped back
    // to their defaults, so the documented disable semantics never worked.
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
        maxQueued: this.#dotPoolMaxQueued,
      });
      this.#dotPools.set(key, pool);
    }
    return pool;
  }

  /**
   * Close all DoT connection pools and release native resolvers.
   * Idempotent: safe to call during shutdown or after the provider
   * was never used (no pools created). Pending queries are rejected.
   */
  dispose(): void {
    for (const pool of this.#dotPools.values()) {
      pool.close();
    }
    this.#dotPools.clear();
    this.#dohAgents.dispose();
    this.#nativeResolvers.clear();
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

  async checkAvailability(
    domain: string,
    signal?: AbortSignal,
    options?: DnsCheckOptions,
  ): Promise<DnsCheckResult> {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    // 1. Memory cache (fastest) — used for within-run dedup even with forceRecheck
    if (!this.#cacheDisabled) {
      const memCached = this.#cache.get(domain);
      if (memCached !== undefined) return memCached;
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
            // A transient failure must not be frozen for the full persistent
            // TTL: Unknown rows older than a short window are re-checked
            // live instead of served (legacy rows from before this guard).
            const staleUnknown =
              parsed.status === DomainStatus.Unknown &&
              Date.now() - Date.parse(parsed.checkedAt) > STALE_UNKNOWN_WINDOW_MS;
            // Availability is the risky verdict — a false positive is a
            // wasted buy recommendation. Like Unknown, an Available row
            // older than its stale window is re-checked live instead of
            // served. Registered stays served for the full TTL: it is the
            // conservative outcome (ADR-0002) and expirations are the
            // exception, not the rule.
            const staleAvailable =
              parsed.status === DomainStatus.Available &&
              Date.now() - Date.parse(parsed.checkedAt) > this.#persistentAvailableStaleMs;
            if (!staleUnknown && !staleAvailable) {
              if (!this.#cacheDisabled) this.#cache.set(domain, parsed);
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

    // The shared lookup deliberately does NOT observe the initiating caller's
    // abort signal for its wire queries: that signal is the property of every
    // coalesced caller. Binding the first caller's signal used to poison all
    // of them — its abort degraded the wire query into 'aborted' → Unknown for
    // every peer. The bounded lookup timeout still guarantees the lookup
    // cannot outlive its budget, and entry-level pre-abort checks still fail
    // fast. A cancelled run lets in-flight queries complete with a real verdict
    // instead of manufacturing an Unknown it could not verify (ADR-0044).
    // The caller's signal is still forwarded so best-effort sub-work (the
    // parking-IP probe) terminates with the caller instead of hanging the
    // shared verdict.
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
        resolved = await withRetry(resolveFn, `dns:${domain}`, this.#retryPolicy, undefined);
      } else if (this.#rateLimiter) {
        await this.#rateLimiter.acquire();
        resolved = await resolveFn(undefined);
      } else if (this.#retryPolicy) {
        resolved = await withRetry(resolveFn, `dns:${domain}`, this.#retryPolicy, undefined);
      } else {
        resolved = await resolveFn(undefined);
      }

      if (resolved !== undefined) {
        const status = resolved ? DomainStatus.Registered : DomainStatus.Available;
        let isParked: boolean | undefined;
        let parkingRegistrar: string | undefined;

        if (resolved && this.#parkingEnabled) {
          // Parking detection is enrichment metadata, not a verdict input,
          // so it is best-effort: it runs under the provider-wide rate
          // limiter and a hard per-query deadline and aborts with the caller
          // — it can neither burst the DNS budget nor outlive an aborted run.
          // A probe failure (rate-limit queue overflow, abort, timeout) keeps
          // the Registered verdict and simply drops the parking enrichment.
          // Previously the probe bypassed both the rate limiter and the
          // abort signal and had no deadline of its own.
          try {
            if (this.#rateLimiter) await this.#rateLimiter.acquire();
            const addresses = await resolveAddressRecords(
              domain,
              this.#lookupTimeoutMs,
              signal,
              this.#getResolver(),
            );
            const parkingCheck = this.#parkingRegistry.checkIps(addresses);
            isParked = parkingCheck.parked || undefined;
            parkingRegistrar = parkingCheck.registrar;
          } catch {
            // Keep the Registered verdict; the parking enrichment is optional.
          }
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
      return resolvesAnyDoh(
        domain,
        spec.endpoint ?? this.#dohEndpoint,
        timeout,
        combinedSignal,
        this.#dohAgents.dispatcherFor(spec.endpoint ?? this.#dohEndpoint),
        spec.format ?? 'json',
      );
    });

    const outcomes = await Promise.allSettled(tasks);

    // A definitive resolve (records returned) is the conservative-safe
    // verdict: reporting a domain Registered when it is free only costs an
    // opportunity, never a wasted buy. Any resolver proving resolution
    // wins, regardless of what the rest of the group says.
    for (const o of outcomes) {
      if (o.status === 'fulfilled' && o.value === true) {
        childAbort.abort();
        return true;
      }
    }

    childAbort.abort();

    // Availability is the risky verdict (ADR-0002), so a lone NXDOMAIN must
    // not outvote resolvers that could not answer — but a strict majority
    // of the group agreeing on NXDOMAIN is trusted even when a minority
    // failed (SERVFAIL, timeout). Previously any single failure made the
    // whole group undecided, pushing the verdict onto the native
    // system-resolver fallback — the least independent node in the path.
    let availableVotes = 0;
    for (const o of outcomes) {
      if (o.status === 'fulfilled' && o.value === false) availableVotes++;
    }
    if (availableVotes > group.lookups.length / 2) return false;

    return undefined;
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
