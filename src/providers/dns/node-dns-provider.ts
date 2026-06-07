import { promises as dnsPromises } from 'node:dns';
import { DomainStatus } from '../../types/domain-status.js';
import type { DnsCheckResult } from '../../types/domain-status.js';
import type { DnsProvider } from './dns-provider.js';
import { loadConfig } from '../../config.js';

export class NodeDnsProvider implements DnsProvider {
  async checkAvailability(domain: string): Promise<DnsCheckResult> {
    try {
      await dnsPromises.resolve(domain, 'A');
      return { domain, status: DomainStatus.Registered, checkedAt: new Date().toISOString() };
    } catch (err: unknown) {
      const code = (err as { code?: string }).code;
      if (code === 'ENOTFOUND' || code === 'ENODATA') {
        return { domain, status: DomainStatus.Available, checkedAt: new Date().toISOString() };
      }
      return { domain, status: DomainStatus.Unknown, checkedAt: new Date().toISOString() };
    }
  }

  async checkBulk(domains: string[]): Promise<DnsCheckResult[]> {
    const concurrency = loadConfig().DNS_BULK_CONCURRENCY;
    const results: DnsCheckResult[] = [];
    for (let i = 0; i < domains.length; i += concurrency) {
      const chunk = domains.slice(i, i + concurrency);
      const chunkResults = await Promise.all(chunk.map((d) => this.checkAvailability(d)));
      results.push(...chunkResults);
    }
    return results;
  }
}
