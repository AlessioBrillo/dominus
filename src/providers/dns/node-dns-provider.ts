import { promises as dnsPromises } from 'node:dns';
import { DomainStatus } from '../../types/domain-status.js';
import type { DnsCheckResult } from '../../types/domain-status.js';
import type { DnsProvider } from './dns-provider.js';
import { loadConfig } from '../../config.js';

const RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'NS'] as const;

async function resolvesAny(domain: string): Promise<boolean | undefined> {
  for (const recordType of RECORD_TYPES) {
    try {
      await dnsPromises.resolve(domain, recordType);
      return true;
    } catch (err: unknown) {
      const code = (err as { code?: string }).code;
      if (code !== 'ENOTFOUND' && code !== 'ENODATA') {
        return undefined;
      }
    }
  }
  return false;
}

export class NodeDnsProvider implements DnsProvider {
  async checkAvailability(domain: string, signal?: AbortSignal): Promise<DnsCheckResult> {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    try {
      const result = await resolvesAny(domain);
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
      const chunkResults = await Promise.all(chunk.map((d) => this.checkAvailability(d, signal)));
      results.push(...chunkResults);
    }
    return results;
  }
}
