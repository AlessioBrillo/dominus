import type { DnsCheckResult } from '../../types/domain-status.js';

export interface DnsProvider {
  checkAvailability(domain: string): Promise<DnsCheckResult>;
  checkBulk(domains: string[]): Promise<DnsCheckResult[]>;
}
