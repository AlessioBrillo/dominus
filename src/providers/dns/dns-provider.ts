import type { DnsCheckResult } from '../../types/domain-status.js';

export interface DnsProvider {
  readonly name: string;
  checkAvailability(domain: string, signal?: AbortSignal): Promise<DnsCheckResult>;
  checkBulk(domains: string[], signal?: AbortSignal): Promise<DnsCheckResult[]>;
  clearCache(): void;
}
