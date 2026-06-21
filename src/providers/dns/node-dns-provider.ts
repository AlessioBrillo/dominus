import { promises as dnsPromises } from 'node:dns';
import { DomainStatus } from '../../types/domain-status.js';
import type { DnsCheckResult } from '../../types/domain-status.js';
import type { DnsProvider } from './dns-provider.js';
import { loadConfig } from '../../config.js';
import { getLogger } from '../../logger.js';

const logger = getLogger();

type DnsRecordType = 'A' | 'AAAA' | 'CNAME' | 'NS' | 'SOA';

const PRIMARY_RECORDS: DnsRecordType[] = ['A', 'AAAA', 'CNAME', 'NS'];

export type DnsLookupStrategy = 'native' | 'native-with-doh-fallback';

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

async function resolvesAnyNative(
  domain: string,
  timeout: number,
  signal?: AbortSignal,
): Promise<boolean | undefined> {
  for (const recordType of PRIMARY_RECORDS) {
    try {
      await resolveWithTimeout(domain, recordType, timeout, signal);
      return true;
    } catch (err: unknown) {
      const code = (err as { code?: string }).code;
      if (code === 'ENOTFOUND' || code === 'ENODATA') {
        continue;
      }
      if (code === 'ETIMEOUT' || code === 'ESOCKETTIMEOUT') {
        logger.warn({ domain, recordType }, 'DNS lookup timed out');
        return undefined;
      }
      return undefined;
    }
  }

  // All primary types failed — try SOA for NXDOMAIN confirmation
  try {
    await resolveWithTimeout(domain, 'SOA', timeout, signal);
    return true;
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    if (code === 'ENOTFOUND') return false;
    return false;
  }
}

async function resolvesAnyDoh(
  domain: string,
  endpoint: string,
  timeout: number,
  signal?: AbortSignal,
): Promise<boolean | undefined> {
  const dohTypes = ['A', 'AAAA', 'NS', 'SOA'];
  for (const recordType of dohTypes) {
    try {
      const timeoutSignal = AbortSignal.timeout(timeout);
      const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
      await resolveDoh(domain, recordType, endpoint, combined);
      return true;
    } catch (err: unknown) {
      const code = (err as { code?: string }).code;
      if (code === 'ENOTFOUND' || code === 'ENODATA') continue;
      return undefined;
    }
  }
  return false;
}

export class NodeDnsProvider implements DnsProvider {
  async checkAvailability(domain: string, signal?: AbortSignal): Promise<DnsCheckResult> {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    const strategy = getLookupStrategy();
    const timeout = getLookupTimeout();
    const checkedAt = new Date().toISOString();

    try {
      const native = await resolvesAnyNative(domain, timeout, signal);

      if (native !== undefined) {
        return {
          domain,
          status: native ? DomainStatus.Registered : DomainStatus.Available,
          checkedAt,
        };
      }

      // Native resolver timed out — try DoH fallback if enabled
      if (strategy === 'native-with-doh-fallback') {
        const endpoint = getDohEndpoint();
        logger.warn({ domain, endpoint }, 'DNS: native resolver timed out, falling back to DoH');
        const doh = await resolvesAnyDoh(domain, endpoint, timeout, signal);
        if (doh !== undefined) {
          return {
            domain,
            status: doh ? DomainStatus.Registered : DomainStatus.Available,
            checkedAt,
          };
        }
      }

      return { domain, status: DomainStatus.Unknown, checkedAt };
    } catch (err: unknown) {
      const code = (err as { code?: string }).code;
      if (code === 'ENOTFOUND' || code === 'ENODATA') {
        return { domain, status: DomainStatus.Available, checkedAt };
      }
      return { domain, status: DomainStatus.Unknown, checkedAt };
    }
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
