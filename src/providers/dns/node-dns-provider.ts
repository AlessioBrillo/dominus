import { promises as dnsPromises } from 'node:dns';
import { DomainStatus } from '../../types/domain-status.js';
import type { DnsCheckResult } from '../../types/domain-status.js';
import type { DnsProvider } from './dns-provider.js';
import { ParkingIpRegistry } from './parking-ip-registry.js';
import { getLogger } from '../../logger.js';
import { normalizeDomain } from '../../utils/domain.js';
import type { RedisCacheProvider } from '../redis/redis-cache-provider.js';

const logger = getLogger();

type DnsRecordType = 'A' | 'AAAA' | 'CNAME' | 'MX' | 'NS' | 'SOA';

export type DnsLookupStrategy = 'native' | 'native-with-doh-fallback' | 'doh-only';

export interface DohResolver {
  name: string;
  url: string;
}

const DEFAULT_DOH_RESOLVERS: DohResolver[] = [
  { name: 'Cloudflare', url: 'https://cloudflare-dns.com/dns-query' },
  { name: 'Google', url: 'https://dns.google/dns-query' },
  { name: 'Quad9', url: 'https://dns.quad9.net/dns-query' },
];

// Phase 1: most discriminating record types — covers ~95% of registered domains.
// Only falls through to Phase 2 when ALL Phase 1 returns NXDOMAIN.
const PHASE1_RECORDS: DnsRecordType[] = ['A', 'AAAA'];
const PHASE2_RECORDS: DnsRecordType[] = ['CNAME', 'MX', 'NS', 'SOA'];

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

/** Resolve A (IPv4) and AAAA (IPv6) records to collect raw IP addresses for parking detection. */
async function resolveAddressRecords(domain: string): Promise<string[]> {
  const [a, aaaa] = await Promise.all([
    dnsPromises.resolve(domain, 'A').catch(() => [] as string[]),
    dnsPromises.resolve(domain, 'AAAA').catch(() => [] as string[]),
  ]);
  return [...a, ...aaaa];
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

async function resolvePhase(
  phaseRecords: DnsRecordType[],
  domain: string,
  timeout: number,
  signal?: AbortSignal,
): Promise<boolean | undefined> {
  const childAbort = new AbortController();
  const combinedSignal = signal ? AbortSignal.any([signal, childAbort.signal]) : childAbort.signal;

  const tasks = phaseRecords.map((type) =>
    resolveWithTimeout(domain, type, timeout, combinedSignal)
      .then(() => {
        childAbort.abort();
        return {
          resolved: true as const,
          aborted: false as const,
          code: undefined as string | undefined,
        };
      })
      .catch((err: unknown) => {
        const e = err as { code?: string; name?: string };
        return {
          resolved: false as const,
          aborted: e.name === ('AbortError' as const),
          code: e.code,
        };
      }),
  );

  const outcomes = await Promise.all(tasks);

  // First success — domain is registered
  for (const o of outcomes) {
    if (o.resolved) return true;
  }

  let anyTimeout = false;
  let anyError = false;
  for (const o of outcomes) {
    if (o.aborted) continue;
    const c = o.code;
    if (c === 'ETIMEOUT' || c === 'ESOCKETTIMEOUT') {
      anyTimeout = true;
    } else if (c !== 'ENOTFOUND' && c !== 'ENODATA' && c !== undefined) {
      anyError = true;
    }
  }

  if (anyTimeout) {
    logger.warn({ domain, phase: phaseRecords.join(',') }, 'DNS: phase timed out');
    return undefined;
  }

  if (anyError) return undefined;

  return false;
}

async function resolvesAnyNative(
  domain: string,
  timeout: number,
  signal?: AbortSignal,
): Promise<boolean | undefined> {
  const phase1 = await resolvePhase(PHASE1_RECORDS, domain, timeout, signal);

  // Phase 1 resolved (registered or available) => return immediately, skip Phase 2
  if (phase1 !== undefined) return phase1;

  // Phase 1 indeterminate (timeout or error) => fall through to Phase 2
  // to avoid false negatives from transient A/AAAA failures
  return resolvePhase(PHASE2_RECORDS, domain, timeout, signal);
}

const DOH_PHASE1_TYPES = ['A', 'AAAA'];
const DOH_PHASE2_TYPES = ['NS', 'SOA'];

async function resolveDohPhase(
  domain: string,
  endpoint: string,
  recordTypes: string[],
  timeout: number,
  signal?: AbortSignal,
): Promise<boolean | undefined> {
  const childAbort = new AbortController();
  const combinedSignal = signal ? AbortSignal.any([signal, childAbort.signal]) : childAbort.signal;

  const tasks = recordTypes.map((type) => {
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

  let anyTimeout = false;
  let anyError = false;
  for (const o of outcomes) {
    if (o.aborted) continue;
    if (!('code' in o)) continue;
    const outcome = o as { resolved: false; aborted: boolean; code: string | undefined };
    const c = outcome.code;
    if (c === 'ETIMEOUT' || c === 'ESOCKETTIMEOUT') {
      anyTimeout = true;
    } else if (c !== 'ENOTFOUND' && c !== 'ENODATA') {
      anyError = true;
    }
  }

  if (anyTimeout) return undefined;
  if (anyError) return undefined;
  return false;
}

/**
 * Two-phase DoH resolution matching the native resolver pattern:
 * Phase 1 (A/AAAA) covers ~95% of domains — registered or available.
 * Phase 2 (NS/SOA) only fires when Phase 1 returns ambiguous (timeout/error).
 * This avoids 2 redundant HTTP requests per domain for the common case.
 */
async function resolvesAnyDoh(
  domain: string,
  endpoint: string,
  timeout: number,
  signal?: AbortSignal,
): Promise<boolean | undefined> {
  const phase1 = await resolveDohPhase(domain, endpoint, DOH_PHASE1_TYPES, timeout, signal);
  if (phase1 !== undefined) return phase1;
  return resolveDohPhase(domain, endpoint, DOH_PHASE2_TYPES, timeout, signal);
}

/** Run all healthy DoH resolvers in parallel; first clear result wins. */
async function raceDohResolvers(
  domain: string,
  resolvers: DohResolver[],
  timeout: number,
  signal?: AbortSignal,
): Promise<boolean | undefined> {
  if (resolvers.length === 0) return undefined;

  const winnerAc = new AbortController();
  const combined = signal ? AbortSignal.any([signal, winnerAc.signal]) : winnerAc.signal;

  const promises = resolvers.map(async (resolver) => {
    try {
      const result = await resolvesAnyDoh(domain, resolver.url, timeout, combined);
      if (result !== undefined) {
        winnerAc.abort();
        return { result, resolver };
      }
      return null;
    } catch {
      return null;
    }
  });

  const settled = await Promise.allSettled(promises);
  for (const s of settled) {
    if (s.status === 'fulfilled' && s.value !== null) {
      return s.value.result;
    }
  }
  return undefined;
}

/** Semaphore to cap concurrent DNS operations and prevent event-loop starvation. */
class DnsSemaphore {
  #active = 0;
  readonly #max: number;
  readonly #queue: Array<{
    resolve: () => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  constructor(max: number) {
    this.#max = max;
  }

  async acquire(timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    if (this.#active < this.#max) {
      this.#active++;
      return true;
    }
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        const idx = this.#queue.findIndex((e) => e.timer === timer);
        if (idx !== -1) this.#queue.splice(idx, 1);
        resolve(false);
      }, timeoutMs);
      const abortHandler = (): void => {
        clearTimeout(timer);
        const idx = this.#queue.findIndex((e) => e.timer === timer);
        if (idx !== -1) this.#queue.splice(idx, 1);
        resolve(false);
      };
      signal?.addEventListener('abort', abortHandler, { once: true });
      this.#queue.push({
        resolve: () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', abortHandler);
          this.#active++;
          resolve(true);
        },
        timer,
      });
    });
  }

  release(): void {
    const next = this.#queue.shift();
    if (next) {
      next.resolve();
    } else {
      this.#active = Math.max(0, this.#active - 1);
    }
  }
}

interface CacheEntry {
  result: DnsCheckResult;
  expiresAt: number;
}

export class NodeDnsProvider implements DnsProvider {
  readonly name = 'NodeDnsProvider';
  readonly #lookupTimeoutMs: number;
  readonly #lookupStrategy: DnsLookupStrategy;
  readonly #dohResolvers: DohResolver[];
  readonly #cacheTtlMs: number;
  readonly #maxSize: number;
  readonly #bulkConcurrency: number;
  readonly #parkingEnabled: boolean;
  readonly #parkingRegistry: ParkingIpRegistry;
  readonly #healthCheckEnabled: boolean;
  readonly #healthCheckDomain: string;
  readonly #semaphore: DnsSemaphore;
  readonly #redisCache: RedisCacheProvider<DnsCheckResult> | undefined;
  #resolverHealth: Map<string, { healthy: boolean; lastCheck: number }> = new Map();
  #healthCheckCache: { healthy: boolean; expiresAt: number } | null = null;
  #cache: Map<string, CacheEntry> = new Map();

  constructor(options?: {
    lookupTimeoutMs?: number;
    lookupStrategy?: DnsLookupStrategy;
    dohEndpoint?: string;
    dohResolvers?: DohResolver[];
    cacheTtlMs?: number;
    maxSize?: number;
    bulkConcurrency?: number;
    parkingEnabled?: boolean;
    parkingRegistry?: ParkingIpRegistry;
    healthCheckEnabled?: boolean;
    healthCheckDomain?: string;
    semaphoreConcurrency?: number;
    redisCache?: RedisCacheProvider<DnsCheckResult>;
  }) {
    this.#lookupTimeoutMs = options?.lookupTimeoutMs ?? 1500;
    this.#lookupStrategy = options?.lookupStrategy ?? 'native';
    // If custom resolvers are provided, use them; otherwise fall back to defaults
    const customResolvers = options?.dohResolvers;
    if (customResolvers && customResolvers.length > 0) {
      this.#dohResolvers = customResolvers;
    } else {
      const defaultUrl = options?.dohEndpoint ?? 'https://cloudflare-dns.com/dns-query';
      this.#dohResolvers = [
        { name: 'primary', url: defaultUrl },
        ...DEFAULT_DOH_RESOLVERS.filter((r) => r.url !== defaultUrl),
      ];
    }
    this.#cacheTtlMs = options?.cacheTtlMs ?? 300_000;
    this.#maxSize = options?.maxSize ?? 10000;
    this.#bulkConcurrency = options?.bulkConcurrency ?? 50;
    this.#parkingEnabled = options?.parkingEnabled ?? false;
    this.#parkingRegistry = options?.parkingRegistry ?? new ParkingIpRegistry([]);
    this.#healthCheckEnabled = options?.healthCheckEnabled ?? true;
    this.#healthCheckDomain = options?.healthCheckDomain ?? 'google.com';
    this.#semaphore = new DnsSemaphore(options?.semaphoreConcurrency ?? 100);
    this.#redisCache = options?.redisCache;
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

  async #tryDohWithFailover(
    domain: string,
    timeout: number,
    signal?: AbortSignal,
  ): Promise<boolean | undefined> {
    const healthy = this.#dohResolvers.filter((r) => {
      const health = this.#resolverHealth.get(r.url);
      if (health && !health.healthy && Date.now() - health.lastCheck < 30_000) return false;
      return true;
    });

    if (healthy.length === 0) return undefined;

    try {
      const result = await raceDohResolvers(domain, healthy, timeout, signal);
      if (result !== undefined) {
        // We don't know which resolver won, so optimistically mark all as healthy
        for (const r of healthy) {
          this.#resolverHealth.set(r.url, { healthy: true, lastCheck: Date.now() });
        }
        return result;
      }
    } catch {
      // All resolvers failed — mark as unhealthy
      for (const r of healthy) {
        this.#resolverHealth.set(r.url, { healthy: false, lastCheck: Date.now() });
        logger.warn({ domain, resolver: r.name }, 'DNS: DoH resolver failed in parallel race');
      }
    }

    return undefined;
  }

  async checkAvailability(domain: string, signal?: AbortSignal): Promise<DnsCheckResult> {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    const norm = normalizeDomain(domain);
    const lookupDomain = norm.isValid ? norm.normalized : domain;

    // Redis cache (shared across instances, survives restarts)
    if (this.#redisCache) {
      const redisResult = await this.#redisCache.get(lookupDomain);
      if (redisResult !== null) {
        return redisResult;
      }
    }

    // In-memory cache (fastest, per-instance)
    const cached = this.#cache.get(lookupDomain);
    if (cached !== undefined && cached.expiresAt > Date.now()) {
      // LRU: re-insert to move to end of Map iteration order
      this.#cache.delete(lookupDomain);
      this.#cache.set(lookupDomain, cached);
      return cached.result;
    }

    const strategy = this.#lookupStrategy;
    const timeout = this.#lookupTimeoutMs;
    const checkedAt = new Date().toISOString();

    const acquired = await this.#semaphore.acquire(timeout, signal);
    if (!acquired) {
      return this.#cached(domain, { domain, status: DomainStatus.Unknown, checkedAt });
    }

    try {
      const result = await this.#checkWithStrategy(lookupDomain, strategy, timeout, signal);
      // Populate Redis cache on fresh result
      if (this.#redisCache && result.status !== DomainStatus.Unknown) {
        this.#redisCache.set(lookupDomain, result).catch(() => {});
      }
      return result;
    } finally {
      this.#semaphore.release();
    }
  }

  async #checkWithStrategy(
    domain: string,
    strategy: DnsLookupStrategy,
    timeout: number,
    signal?: AbortSignal,
  ): Promise<DnsCheckResult> {
    const checkedAt = new Date().toISOString();

    if (strategy === 'doh-only') {
      const doh = await this.#tryDohWithFailover(domain, timeout, signal);
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
      const status = native ? DomainStatus.Registered : DomainStatus.Available;
      let isParked: boolean | undefined;
      let parkingRegistrar: string | undefined;

      if (native && this.#parkingEnabled) {
        const addresses = await resolveAddressRecords(domain);
        const parkingCheck = this.#parkingRegistry.checkIps(addresses);
        isParked = parkingCheck.parked || undefined;
        parkingRegistrar = parkingCheck.registrar;
      }

      return this.#cached(domain, {
        domain,
        status,
        checkedAt,
        isParked: isParked,
        parkingRegistrar,
      });
    }

    if (strategy === 'native-with-doh-fallback') {
      logger.warn({ domain }, 'DNS: native resolver timed out, falling back to multi-resolver DoH');
      const doh = await this.#tryDohWithFailover(domain, timeout, signal);
      if (doh !== undefined) {
        return this.#cached(domain, {
          domain,
          status: doh ? DomainStatus.Registered : DomainStatus.Available,
          checkedAt,
        });
      }
    }

    return this.#cached(domain, { domain, status: DomainStatus.Unknown, checkedAt });
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

  async #checkResolverHealth(signal?: AbortSignal): Promise<void> {
    if (!this.#healthCheckEnabled) return;

    const now = Date.now();
    if (this.#healthCheckCache && this.#healthCheckCache.expiresAt > now) {
      if (!this.#healthCheckCache.healthy) {
        throw new Error(
          'DNS resolver health check failed — system resolver is unavailable. ' +
            'Check /etc/resolv.conf or network connectivity.',
        );
      }
      return;
    }

    try {
      await resolveWithTimeout(this.#healthCheckDomain, 'A', this.#lookupTimeoutMs, signal);
      this.#healthCheckCache = { healthy: true, expiresAt: now + 30_000 };
    } catch {
      this.#healthCheckCache = { healthy: false, expiresAt: now + 10_000 };
      throw new Error(
        `DNS resolver health check failed for ${this.#healthCheckDomain} — ` +
          'system resolver is unavailable. ' +
          'Check /etc/resolv.conf or network connectivity.',
      );
    }
  }

  async checkBulk(domains: string[], signal?: AbortSignal): Promise<DnsCheckResult[]> {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    await this.#checkResolverHealth(signal);

    const n = domains.length;
    if (n === 0) return [];

    const results = new Array<DnsCheckResult>(n);
    let nextIndex = 0;

    const worker = async (): Promise<void> => {
      while (nextIndex < n) {
        if (signal?.aborted) return;
        const i = nextIndex++;
        const domain = domains[i]!;
        try {
          results[i] = await this.checkAvailability(domain, signal);
        } catch {
          results[i] = {
            domain,
            status: DomainStatus.Unknown,
            checkedAt: new Date().toISOString(),
          };
        }
      }
    };

    const workers = Math.min(this.#bulkConcurrency, n);
    await Promise.all(Array.from({ length: workers }, () => worker()));
    return results;
  }
}
