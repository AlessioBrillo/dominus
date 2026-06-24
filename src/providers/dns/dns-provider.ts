import type { DnsCheckResult } from '../../types/domain-status.js';

export interface DnsProvider {
  checkAvailability(domain: string, signal?: AbortSignal): Promise<DnsCheckResult>;
  checkBulk(domains: string[], signal?: AbortSignal): Promise<DnsCheckResult[]>;
  /** Clear any in-memory caches. Called between pipeline runs to prevent stale data. */
  clearCache(): void;
}
