import { promises as dnsPromises } from 'node:dns';
import { DomainStatus } from '../../types/domain-status.js';
import type { DnsCheckResult } from '../../types/domain-status.js';
import type { DnsProvider } from './dns-provider.js';

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
    return Promise.all(domains.map((d) => this.checkAvailability(d)));
  }
}
