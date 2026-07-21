import type { DnsCheckResult } from '../../types/domain-status.js';

export interface DnsLookupSpec {
  type: 'native' | 'doh';
  endpoint?: string;
}

export interface DnsResolverGroup {
  name: string;
  lookups: DnsLookupSpec[];
}

export function strategyToResolverGroups(
  strategy: string,
  defaultDohEndpoint: string,
): DnsResolverGroup[] {
  switch (strategy) {
    case 'doh-only':
    case 'doh-primary':
      return [{ name: 'default', lookups: [{ type: 'doh', endpoint: defaultDohEndpoint }] }];
    case 'native-with-doh-fallback':
      return [
        { name: 'primary', lookups: [{ type: 'native' }] },
        { name: 'doh-fallback', lookups: [{ type: 'doh', endpoint: defaultDohEndpoint }] },
      ];
    case 'native':
    default:
      return [{ name: 'default', lookups: [{ type: 'native' }] }];
  }
}

export interface DnsProvider {
  readonly name: string;
  checkAvailability(domain: string, signal?: AbortSignal): Promise<DnsCheckResult>;
  checkBulk(domains: string[], signal?: AbortSignal): Promise<DnsCheckResult[]>;
  clearCache(): void;
  pruneCache(): number;
}
