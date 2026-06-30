import { promises as dnsPromises } from 'node:dns';
import { DomainStatus } from '../../types/domain-status.js';
import type { DnsCheckResult } from '../../types/domain-status.js';
import type { DnsProvider } from './dns-provider.js';
import { ParkingIpRegistry } from './parking-ip-registry.js';
import { getLogger } from '../../logger.js';

const logger = getLogger();

type DnsRecordType = 'A' | 'AAAA' | 'CNAME' | 'MX' | 'NS' | 'SOA';

export type DnsLookupStrategy = 'native' | 'native-with-doh-fallback' | 'doh-only';

// Phase 1: most discriminating record types — covers ~95% of registered domains.
// Only falls through to Phase 2 when ALL Phase 1 returns NXDOMAIN.
const PHASE1_RECORDS: DnsRecordType[] = ['A', 'AAAA'];
const PHASE2_RECORDS: DnsRecordType[] = ['CNAME', 'MX', 'NS', 'SOA'];

const HEALTH_CHECK_DOMAIN = 'google.com';

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
    // ponytail: single timeout log per domain — repeated warnings across batches
    // are suppressed. Add per-resolver timeout tracking when the system resolver
    // spans multiple upstreams.
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
  readonly name = 'NodeDnsProvider';
  readonly #lookupTimeoutMs: number;
  readonly #lookupStrategy: DnsLookupStrategy;
  readonly #dohEndpoint: string;
  readonly #cacheTtlMs: number;
  readonly #maxSize: number;
  readonly #bulkConcurrency: number;
  readonly #parkingEnabled: boolean;
  readonly #parkingRegistry: ParkingIpRegistry;
  readonly #healthCheckEnabled: boolean;
  #healthCheckCache: { healthy: boolean; expiresAt: number } | null = null;
  #cache: Map<string, CacheEntry> = new Map();

  constructor(options?: {
    lookupTimeoutMs?: number;
    lookupStrategy?: DnsLookupStrategy;
    dohEndpoint?: string;
    cacheTtlMs?: number;
    maxSize?: number;
    bulkConcurrency?: number;
    parkingEnabled?: boolean;
    parkingRegistry?: ParkingIpRegistry;
    healthCheckEnabled?: boolean;
  }) {
    this.#lookupTimeoutMs = options?.lookupTimeoutMs ?? 1500;
    this.#lookupStrategy = options?.lookupStrategy ?? 'native';
    this.#dohEndpoint = options?.dohEndpoint ?? 'https://cloudflare-dns.com/dns-query';
    this.#cacheTtlMs = options?.cacheTtlMs ?? 300_000;
    this.#maxSize = options?.maxSize ?? 10000;
    this.#bulkConcurrency = options?.bulkConcurrency ?? 50;
    this.#parkingEnabled = options?.parkingEnabled ?? false;
    this.#parkingRegistry = options?.parkingRegistry ?? new ParkingIpRegistry([]);
    this.#healthCheckEnabled = options?.healthCheckEnabled ?? true;
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

    const strategy = this.#lookupStrategy;
    const timeout = this.#lookupTimeoutMs;
    const checkedAt = new Date().toISOString();

    try {
      if (strategy === 'doh-only') {
        const doh = await resolvesAnyDoh(domain, this.#dohEndpoint, timeout, signal);
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
        logger.warn(
          { domain, endpoint: this.#dohEndpoint },
          'DNS: native resolver timed out, falling back to DoH',
        );
        const doh = await resolvesAnyDoh(domain, this.#dohEndpoint, timeout, signal);
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
      await resolveWithTimeout(HEALTH_CHECK_DOMAIN, 'A', this.#lookupTimeoutMs, signal);
      this.#healthCheckCache = { healthy: true, expiresAt: now + 30_000 };
    } catch {
      this.#healthCheckCache = { healthy: false, expiresAt: now + 10_000 };
      throw new Error(
        'DNS resolver health check failed — system resolver is unavailable. ' +
          'Check /etc/resolv.conf or network connectivity.',
      );
    }
  }

  async checkBulk(domains: string[], signal?: AbortSignal): Promise<DnsCheckResult[]> {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    await this.#checkResolverHealth(signal);

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
