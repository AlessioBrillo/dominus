import { connect as tlsConnect, type ConnectionOptions } from 'node:tls';
import { promises as dnsPromises } from 'node:dns';
import { LRUCache } from 'lru-cache';
import { DomainStatus } from '../../types/domain-status.js';
import type { DnsCheckResult } from '../../types/domain-status.js';
import type { DnsProvider, DnsResolverGroup } from './dns-provider.js';
import { strategyToResolverGroups } from './dns-provider.js';
import { ParkingIpRegistry } from './parking-ip-registry.js';
import { withRetry } from '../retryable-provider.js';
import type { RetryPolicy } from '../retry-policy.js';
import type { ProviderCacheRepository } from '../../db/repositories/provider-cache-repository.js';
import { getLogger } from '../../logger.js';
import type { RateLimiterLike } from '../rate-limiter.js';

const logger = getLogger();

type DnsRecordType = 'A' | 'AAAA' | 'CNAME' | 'MX' | 'NS' | 'SOA';

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

/** Resolve A and AAAA records for IP-based parking detection. */
async function resolveAddressRecords(domain: string): Promise<string[]> {
  const [v4, v6] = await Promise.all([
    dnsPromises.resolve(domain, 'A').catch(() => [] as string[]),
    dnsPromises.resolve(domain, 'AAAA').catch(() => [] as string[]),
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

/**
 * DNS-over-TLS resolver using raw TCP+TLS sockets.
 * Implements RFC 7858 — sends wire-format DNS queries over a TLS connection.
 */
function resolveDot(
  domain: string,
  recordType: string,
  endpoint: string,
  timeoutMs: number,
  servername?: string,
  port?: number,
  signal?: AbortSignal,
): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const destPort = port ?? 853;

    const dnsQuery = buildDnsQuery(domain, recordTypeToQtype(recordType));

    const tlsOpts: ConnectionOptions = {
      host: endpoint,
      port: destPort,
      servername: servername ?? endpoint,
      rejectUnauthorized: true,
    };

    const tlsSocket = tlsConnect(tlsOpts);

    const cleanup = (): void => {
      tlsSocket.destroy();
      if (abortHandler !== undefined && signal !== undefined) {
        signal.removeEventListener('abort', abortHandler);
      }
    };

    const abortHandler = (): void => {
      tlsSocket.destroy();
      reject(new DOMException('Aborted', 'AbortError'));
    };
    if (signal !== undefined) {
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    const timer = setTimeout(() => {
      tlsSocket.destroy();
      const err = new Error(`DoT lookup timed out for ${domain}`);
      (err as { code?: string }).code = 'ETIMEOUT';
      reject(err);
    }, timeoutMs);

    tlsSocket.on('connect', () => {
      // Send the length-prefixed DNS query
      const lengthPrefixed = Buffer.alloc(2 + dnsQuery.length);
      lengthPrefixed.writeUInt16BE(dnsQuery.length, 0);
      dnsQuery.copy(lengthPrefixed, 2);
      tlsSocket.write(lengthPrefixed);
    });

    tlsSocket.on('data', (data: Buffer) => {
      clearTimeout(timer);
      cleanup();
      // Response has 2-byte length prefix, then DNS response
      // We check the DNS response header flags: bit 15 (QR) should be 1 (response),
      // and the RCODE in the last 4 bits of byte 3
      if (data.length < 4) {
        reject(new Error('DoT: response too short'));
        return;
      }
      const flags = data.readUInt16BE(2);
      const rcode = flags & 0x0f;

      if (rcode === 3) {
        // NXDOMAIN
        const err = Object.assign(new Error('DoT NXDOMAIN'), { code: 'ENOTFOUND' });
        reject(err);
        return;
      }

      if (rcode !== 0) {
        // Other error
        const err = Object.assign(new Error(`DoT RCODE ${rcode}`), { code: 'ESERVFAIL' });
        reject(err);
        return;
      }

      // Count answer records: DNS header bytes 6-7 (ANCOUNT)
      const ancount = data.readUInt16BE(6);
      if (ancount === 0) {
        const err = Object.assign(new Error('DoT NODATA'), { code: 'ENODATA' });
        reject(err);
        return;
      }

      resolve(true);
    });

    tlsSocket.on('error', (err: Error) => {
      clearTimeout(timer);
      cleanup();
      reject(err);
    });

    tlsSocket.on('close', () => {
      clearTimeout(timer);
      cleanup();
    });
  });
}

/**
 * Build a minimal DNS query message (RFC 1035 section 4.1.1).
 * Uses a fixed 16-bit query ID and single-question format.
 */
function buildDnsQuery(domain: string, qtype: number): Buffer {
  const header = Buffer.alloc(12);
  // ID: 0x0000 (we only care about the response)
  header.writeUInt16BE(0x0000, 0);
  // Flags: standard query with recursion desired (0x0100)
  header.writeUInt16BE(0x0100, 2);
  // QDCOUNT: 1 question
  header.writeUInt16BE(1, 4);
  // ANCOUNT, NSCOUNT, ARCOUNT: 0
  header.writeUInt16BE(0, 6);
  header.writeUInt16BE(0, 8);
  header.writeUInt16BE(0, 10);

  const qname = encodeDnsName(domain);
  const question = Buffer.alloc(qname.length + 4);
  qname.copy(question, 0);
  question.writeUInt16BE(qtype, qname.length);
  // QCLASS: IN (1)
  question.writeUInt16BE(1, qname.length + 2);

  return Buffer.concat([header, question]);
}

function encodeDnsName(name: string): Buffer {
  const parts = name.split('.');
  const buffers: Buffer[] = [];
  for (const part of parts) {
    const buf = Buffer.from(part, 'ascii');
    const len = Buffer.alloc(1);
    len[0] = buf.length;
    buffers.push(len, buf);
  }
  buffers.push(Buffer.from([0x00]));
  return Buffer.concat(buffers);
}

function recordTypeToQtype(type: string): number {
  switch (type) {
    case 'A':
      return 1;
    case 'AAAA':
      return 28;
    case 'CNAME':
      return 5;
    case 'MX':
      return 15;
    case 'NS':
      return 2;
    case 'SOA':
      return 6;
    default:
      return 1;
  }
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

async function resolvesAnyDot(
  domain: string,
  endpoint: string,
  timeout: number,
  servername?: string,
  port?: number,
  signal?: AbortSignal,
): Promise<boolean | undefined> {
  const childAbort = new AbortController();
  const combinedSignal = signal ? AbortSignal.any([signal, childAbort.signal]) : childAbort.signal;

  const DOT_TYPES = ['A', 'AAAA', 'NS', 'SOA'];

  const tasks = DOT_TYPES.map((type) => {
    const timeoutSignal = AbortSignal.timeout(timeout);
    const merged = AbortSignal.any([combinedSignal, timeoutSignal]);
    return resolveDot(domain, type, endpoint, timeout, servername, port, merged)
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
  readonly #cache: LRUCache<string, DnsCheckResult>;
  /** Pending in-flight lookups keyed by domain to prevent cache stampede. */
  readonly #pending: Map<string, Promise<DnsCheckResult>> = new Map();

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

  pruneCache(): number {
    const before = this.#cache.size;
    this.#cache.purgeStale();
    const after = this.#cache.size;
    return before - after;
  }

  clearCache(): void {
    this.#cache.clear();
  }

  async checkAvailability(domain: string, signal?: AbortSignal): Promise<DnsCheckResult> {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    // 1. Memory cache (fastest)
    const memCached = this.#cache.get(domain);
    if (memCached !== undefined) return memCached;

    // 2. Persistent cache (DB-backed, survives restarts)
    if (this.#persistentCache !== undefined) {
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
          const addresses = await resolveAddressRecords(domain);
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
      this.#persistentCache.set(domain, this.name, JSON.stringify(result), 7).catch(() => {
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
        return resolvesAnyNative(domain, timeout, combinedSignal);
      }
      if (spec.type === 'dot') {
        return resolvesAnyDot(
          domain,
          spec.endpoint ?? this.#dohEndpoint,
          timeout,
          spec.servername,
          spec.port,
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

  async checkBulk(domains: string[], signal?: AbortSignal): Promise<DnsCheckResult[]> {
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
            results[idx] = await this.checkAvailability(domains[idx]!, signal);
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

      // Spawn worker pool
      const concurrency = Math.min(this.#bulkConcurrency, domains.length);
      activeWorkers = concurrency > 0 ? concurrency : 1;
      for (let i = 0; i < concurrency; i++) {
        void worker();
      }
    });
  }
}
