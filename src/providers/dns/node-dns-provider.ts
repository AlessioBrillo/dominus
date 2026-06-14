import { promises as dnsPromises } from 'node:dns';
import { DomainStatus } from '../../types/domain-status.js';
import type { DnsCheckResult } from '../../types/domain-status.js';
import type { DnsProvider } from './dns-provider.js';
import { loadConfig } from '../../config.js';
import { getLogger } from '../../logger.js';

const logger = getLogger();

type DnsRecordType = 'A' | 'AAAA' | 'CNAME' | 'NS';
const RECORD_TYPES: DnsRecordType[] = ['A', 'AAAA', 'CNAME', 'NS'];

function getLookupTimeout(): number {
  try {
    return loadConfig().DNS_LOOKUP_TIMEOUT_MS;
  } catch {
    return 3000;
  }
}

function resolveWithTimeout(
  domain: string,
  recordType: DnsRecordType,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string[]> {
  return new Promise<string[]>((resolve, reject) => {
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
      .then((result) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abortHandler);
        resolve(result);
      })
      .catch((err) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abortHandler);
        reject(err);
      });
  });
}

async function resolvesAny(domain: string, signal?: AbortSignal): Promise<boolean | undefined> {
  const timeout = getLookupTimeout();
  for (const recordType of RECORD_TYPES) {
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
  return false;
}

export class NodeDnsProvider implements DnsProvider {
  async checkAvailability(domain: string, signal?: AbortSignal): Promise<DnsCheckResult> {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    try {
      const result = await resolvesAny(domain, signal);
      if (result === undefined) {
        return { domain, status: DomainStatus.Unknown, checkedAt: new Date().toISOString() };
      }
      return {
        domain,
        status: result ? DomainStatus.Registered : DomainStatus.Available,
        checkedAt: new Date().toISOString(),
      };
    } catch (err: unknown) {
      const code = (err as { code?: string }).code;
      if (code === 'ENOTFOUND' || code === 'ENODATA') {
        return { domain, status: DomainStatus.Available, checkedAt: new Date().toISOString() };
      }
      return { domain, status: DomainStatus.Unknown, checkedAt: new Date().toISOString() };
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
